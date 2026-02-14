#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';

const program = new Command();
const VERSION = '0.3.0';

type TaskStatus = 'CREATED' | 'IN_PROGRESS' | 'COMPLETED' | 'BLOCKED';

type Config = {
  project: string;
  version: string;
  ai_provider: string;
  coordination_dir: string;
  auto_commit: boolean;
  task_prefix: string;
  report_prefix: string;
  conventions_file: string;
  rules_file: string;
};

type RelayDependencyValidation = {
  taskId: string;
  reportId: string;
  artifactsChecked: string[];
  warnings: string[];
};

type RelayBaton = {
  id: string;
  createdAt: string;
  toTask: string;
  dependencies: RelayDependencyValidation[];
  checks: string[];
  passed: boolean;
};

type ParsedAiReport = {
  status: TaskStatus;
  doneItems: string[];
  changedFiles: string[];
  testsOutput: string;
  nextSteps: string[];
  resultSummary: string;
};

const DEFAULT_CONFIG: Config = {
  project: path.basename(process.cwd()),
  version: '1.0.0',
  ai_provider: 'auto',
  coordination_dir: './coordination',
  auto_commit: false,
  task_prefix: 'TASK',
  report_prefix: 'REPORT',
  conventions_file: './CONVENTIONS.md',
  rules_file: './AI_RULES.md',
};

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readTextIfExists(filePath: string): string {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
}

function writeText(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf-8');
}

function toAbs(root: string, maybeRelative: string): string {
  return path.isAbsolute(maybeRelative) ? maybeRelative : path.join(root, maybeRelative);
}

function nowIso(): string {
  const now = new Date();
  return now.toISOString().replace('T', ' ').slice(0, 19);
}

function splitList(raw: string | undefined, separators: RegExp = /[;,]/): string[] {
  if (!raw) return [];
  return raw
    .split(separators)
    .map((value) => value.trim())
    .filter(Boolean);
}

function findProjectRoot(startDir: string): string {
  let current = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(current, '.brothers-config.json'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error('Project is not initialized. Run: brothers init');
    }
    current = parent;
  }
}

function loadConfig(root: string): Config {
  const configPath = path.join(root, '.brothers-config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error('Missing .brothers-config.json. Run: brothers init');
  }
  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Partial<Config>;
  return { ...DEFAULT_CONFIG, ...parsed };
}

function coordinationRoot(root: string, config: Config): string {
  return toAbs(root, config.coordination_dir);
}

function numericIdsFromFiles(dirPath: string, prefix: string, extension = '.md'): number[] {
  if (!fs.existsSync(dirPath)) return [];
  const escapedExt = extension.replace('.', '\\.');
  const matcher = new RegExp(`^${prefix}-(\\d+)${escapedExt}$`);
  return fs
    .readdirSync(dirPath)
    .map((name) => {
      const match = name.match(matcher);
      return match ? Number(match[1]) : null;
    })
    .filter((id): id is number => Number.isFinite(id));
}

function nextEntityId(dirPath: string, prefix: string, extension = '.md'): string {
  const ids = numericIdsFromFiles(dirPath, prefix, extension);
  const next = ids.length === 0 ? 1 : Math.max(...ids) + 1;
  return `${prefix}-${String(next).padStart(3, '0')}`;
}

function normalizeTaskStatus(value: string | undefined): TaskStatus {
  const upper = (value ?? '').toUpperCase();
  if (upper === 'CREATED' || upper === 'IN_PROGRESS' || upper === 'COMPLETED' || upper === 'BLOCKED') {
    return upper;
  }
  return 'COMPLETED';
}

function updateTaskStatus(taskPath: string, status: TaskStatus): void {
  const content = fs.readFileSync(taskPath, 'utf-8');
  const updated = content.replace(/\*Status:\s*[^*]+\*/g, `*Status: ${status}*`);
  fs.writeFileSync(taskPath, updated, 'utf-8');
}

function readTaskStatus(content: string): TaskStatus {
  const match = content.match(/\*Status:\s*([A-Z_]+)\*/);
  return normalizeTaskStatus(match?.[1]);
}

function extractSection(content: string, sectionTitle: string): string {
  const escaped = sectionTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matcher = new RegExp(`##\\s+${escaped}([\\s\\S]*?)(\\n##\\s+|$)`, 'i');
  const match = content.match(matcher);
  return match?.[1]?.trim() ?? '';
}

function extractAnySection(content: string, sectionTitles: string[]): string {
  for (const title of sectionTitles) {
    const section = extractSection(content, title);
    if (section) return section;
  }
  return '';
}

function parseChecklistItems(section: string): string[] {
  if (!section) return [];

  const lines = section
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const items: string[] = [];
  for (const line of lines) {
    const checklist = line.match(/^[-*]\s*(?:✅|\[x\]|\[X\])\s*(.+)$/);
    const bullet = line.match(/^[-*]\s*(?:\[\s\]|\[x\]|\[X\])?\s*(.+)$/);
    const numeric = line.match(/^\d+\.\s+(.+)$/);

    if (checklist) items.push(checklist[1].trim());
    else if (bullet) items.push(bullet[1].trim());
    else if (numeric) items.push(numeric[1].trim());
  }

  return Array.from(new Set(items));
}

function parseDependencies(taskContent: string): string[] {
  const section = extractSection(taskContent, 'Dependencies');
  if (!section) return [];

  const lines = section
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const deps: string[] = [];
  for (const line of lines) {
    if (/^none$/i.test(line)) continue;
    const bullet = line.match(/^[-*]\s*(.+)$/);
    const value = bullet ? bullet[1].trim() : line;
    if (/^TASK-\d+$/i.test(value)) {
      deps.push(value.toUpperCase());
    }
  }

  return Array.from(new Set(deps));
}

function replaceDependenciesSection(taskContent: string, dependencies: string[]): string {
  const depsBlock = dependencies.length > 0 ? dependencies.map((dep) => `- ${dep}`).join('\n') : 'None';
  const matcher = /##\s+Dependencies[\s\S]*?(\n##\s+|\n---|$)/i;

  if (matcher.test(taskContent)) {
    return taskContent.replace(matcher, `## Dependencies\n${depsBlock}\n\n$1`);
  }

  const marker = '\n## Done Criteria';
  const insertion = `\n## Dependencies\n${depsBlock}\n`;
  if (taskContent.includes(marker)) {
    return taskContent.replace(marker, `${insertion}${marker}`);
  }

  return `${taskContent.trim()}\n\n## Dependencies\n${depsBlock}\n`;
}

function renderTaskMarkdown(
  id: string,
  title: string,
  priority: string,
  assignee: string,
  details: string,
  files: string[],
  dependencies: string[],
): string {
  const filesList = files.length > 0 ? files.map((file) => `- ${file}`).join('\n') : 'None';
  const depsList = dependencies.length > 0 ? dependencies.map((dep) => `- ${dep}`).join('\n') : 'None';

  return `# ${id}: ${title}

## Description
${title}

## Created
${nowIso()}

## Assignee
${assignee}

## Priority
${priority}

## Details
${details || '[Fill details]'}

## Dependencies
${depsList}

## Done Criteria
- [ ] Code works
- [ ] Tests pass
- [ ] Documentation updated

## Files
${filesList}

---
*Status: CREATED*
*Next: Run brothers start ${id}*
`;
}

function extractTaskTitle(taskContent: string): string {
  const firstLine = taskContent.split('\n').find((line) => line.startsWith('# '));
  if (!firstLine) return 'Untitled task';
  return firstLine.replace(/^#\s+[^:]+:\s*/, '').trim();
}

function getLatestReportFiles(reportsDir: string, count: number): string[] {
  if (!fs.existsSync(reportsDir)) return [];

  const files = fs
    .readdirSync(reportsDir)
    .filter((name) => /^REPORT-\d+\.md$/.test(name))
    .sort((a, b) => a.localeCompare(b));

  return files.slice(-count).map((name) => path.join(reportsDir, name));
}

function parseNextSteps(reportContent: string): string[] {
  const section = extractAnySection(reportContent, ['NEXT STEPS', 'СЛЕДУЮЩИЕ ШАГИ']);
  return parseChecklistItems(section);
}

function setupProject(root: string, projectName: string): void {
  const coordination = path.join(root, 'coordination');
  ensureDir(path.join(coordination, 'tasks'));
  ensureDir(path.join(coordination, 'reports'));
  ensureDir(path.join(coordination, 'templates'));
  ensureDir(path.join(coordination, 'prompts'));
  ensureDir(path.join(coordination, 'archive'));
  ensureDir(path.join(coordination, 'batons'));

  const config: Config = {
    ...DEFAULT_CONFIG,
    project: projectName,
  };

  writeText(path.join(root, '.brothers-config.json'), `${JSON.stringify(config, null, 2)}\n`);

  writeText(
    path.join(coordination, 'templates', 'task-template.md'),
    `# TASK-{ID}: {TITLE}

## Description
{DESCRIPTION}

## Created
{DATE}

## Assignee
{ASSIGNEE}

## Priority
{PRIORITY}

## Details
{DETAILS}

## Dependencies
{DEPENDENCIES}

## Done Criteria
- [ ] Code works
- [ ] Tests pass
- [ ] Documentation updated

## Files
{FILES}

---
*Status: CREATED*
`,
  );

  writeText(
    path.join(coordination, 'templates', 'report-template.md'),
    `# REPORT-{ID}: {TASK_TITLE}

## DATE
{DATE}

## EXECUTOR
{EXECUTOR}

## STATUS
{STATUS}

## TASK
{TASK_ID}

## WORK DONE
- ✅ {ITEM_1}

## FILES CHANGED
- {FILE_1}

## TESTS
{TEST_OUTPUT}

## RESULT
{RESULT}

## NEXT STEPS
- [ ] {NEXT_STEP_1}
`,
  );

  writeText(
    path.join(root, 'README.md'),
    `# ${projectName}

MVP implementation for Brothers Protocol CLI.

## Quick Start

\`\`\`bash
npm install
npm run build
node dist/cli.js init
node dist/cli.js task "My first task"
node dist/cli.js start TASK-001
node dist/cli.js report TASK-001 --done "Implemented flow" --tests "npm test"
node dist/cli.js status
\`\`\`
`,
  );

  if (!fs.existsSync(path.join(root, 'AI_RULES.md'))) {
    writeText(path.join(root, 'AI_RULES.md'), '# AI Rules\n\nAdd project-level AI execution rules here.\n');
  }
}

function createTask(
  root: string,
  title: string,
  options: { priority: string; assignee: string; details: string; files: string[]; dependsOn: string[] },
): { id: string; taskPath: string } {
  const config = loadConfig(root);
  const coordination = coordinationRoot(root, config);
  const tasksDir = path.join(coordination, 'tasks');

  const id = nextEntityId(tasksDir, config.task_prefix);
  const taskPath = path.join(tasksDir, `${id}.md`);
  const content = renderTaskMarkdown(
    id,
    title,
    options.priority,
    options.assignee,
    options.details,
    options.files,
    options.dependsOn,
  );

  writeText(taskPath, content);
  return { id, taskPath };
}

function getTaskPath(tasksDir: string, taskId: string): string {
  return path.join(tasksDir, `${taskId}.md`);
}

function requireTaskContent(tasksDir: string, taskId: string): { taskPath: string; taskContent: string } {
  const taskPath = getTaskPath(tasksDir, taskId);
  if (!fs.existsSync(taskPath)) {
    throw new Error(`Task not found: ${taskId}`);
  }
  return { taskPath, taskContent: fs.readFileSync(taskPath, 'utf-8') };
}

function findLatestReportForTask(
  reportsDir: string,
  taskId: string,
): { reportId: string; reportPath: string; reportContent: string } | null {
  const files = getLatestReportFiles(reportsDir, Number.MAX_SAFE_INTEGER).reverse();

  for (const reportPath of files) {
    const content = fs.readFileSync(reportPath, 'utf-8');
    const section = extractSection(content, 'TASK');
    const linkedTask = section.split('\n')[0]?.trim();

    if (linkedTask === taskId) {
      const reportId = path.basename(reportPath, '.md');
      return { reportId, reportPath, reportContent: content };
    }
  }

  return null;
}

function parseChangedFiles(reportContent: string): string[] {
  const section = extractAnySection(reportContent, ['FILES CHANGED', 'ИЗМЕНЁННЫЕ ФАЙЛЫ']);
  if (!section) return [];

  const lines = section
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const files: string[] = [];
  for (const line of lines) {
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (!bullet) continue;

    const candidate = bullet[1]
      .replace(/^`|`$/g, '')
      .replace(/\s+\(.*\)$/, '')
      .trim();

    if (!candidate || /^not specified$/i.test(candidate)) continue;
    files.push(candidate);
  }

  return Array.from(new Set(files));
}

function validateReportStructure(reportContent: string): string[] {
  const requiredSections = ['WORK DONE', 'FILES CHANGED', 'TESTS', 'RESULT', 'NEXT STEPS'];
  const missing: string[] = [];

  for (const section of requiredSections) {
    if (!extractSection(reportContent, section)) {
      missing.push(section);
    }
  }

  return missing;
}

function runRelayCheck(root: string, config: Config, taskId: string): { baton: RelayBaton; batonPath: string; warnings: string[] } {
  const coordination = coordinationRoot(root, config);
  const tasksDir = path.join(coordination, 'tasks');
  const reportsDir = path.join(coordination, 'reports');
  const batonsDir = path.join(coordination, 'batons');

  const { taskContent } = requireTaskContent(tasksDir, taskId);
  const dependencies = parseDependencies(taskContent);

  if (dependencies.length === 0) {
    throw new Error(`Task ${taskId} has no dependencies. Relay check is not required.`);
  }

  const errors: string[] = [];
  const warnings: string[] = [];
  const validatedDeps: RelayDependencyValidation[] = [];

  for (const dep of dependencies) {
    const depTaskPath = getTaskPath(tasksDir, dep);
    if (!fs.existsSync(depTaskPath)) {
      errors.push(`${dep}: task file is missing`);
      continue;
    }

    const depTaskContent = fs.readFileSync(depTaskPath, 'utf-8');
    const depStatus = readTaskStatus(depTaskContent);
    if (depStatus !== 'COMPLETED') {
      errors.push(`${dep}: status is ${depStatus}, expected COMPLETED`);
      continue;
    }

    const report = findLatestReportForTask(reportsDir, dep);
    if (!report) {
      errors.push(`${dep}: report not found`);
      continue;
    }

    const missingSections = validateReportStructure(report.reportContent);
    if (missingSections.length > 0) {
      errors.push(`${dep}: report ${report.reportId} missing sections ${missingSections.join(', ')}`);
      continue;
    }

    const changedFiles = parseChangedFiles(report.reportContent);
    const missingFiles = changedFiles.filter((file) => !fs.existsSync(path.resolve(root, file)));
    if (missingFiles.length > 0) {
      errors.push(`${dep}: missing artifacts ${missingFiles.join(', ')}`);
      continue;
    }

    const testsSection = extractSection(report.reportContent, 'TESTS');
    if (/not run|not executed|не запуск/i.test(testsSection)) {
      warnings.push(`${dep}: tests were not executed according to ${report.reportId}`);
    }

    validatedDeps.push({
      taskId: dep,
      reportId: report.reportId,
      artifactsChecked: changedFiles,
      warnings: [],
    });
  }

  if (errors.length > 0) {
    throw new Error(`Relay validation failed:\n- ${errors.join('\n- ')}`);
  }

  ensureDir(batonsDir);

  const batonId = nextEntityId(batonsDir, 'BATON', '.json');
  const baton: RelayBaton = {
    id: batonId,
    createdAt: nowIso(),
    toTask: taskId,
    dependencies: validatedDeps,
    checks: ['dependencies_completed', 'reports_exist', 'report_sections_valid', 'artifacts_exist'],
    passed: true,
  };

  const batonPath = path.join(batonsDir, `${batonId}.json`);
  writeText(batonPath, `${JSON.stringify(baton, null, 2)}\n`);

  return { baton, batonPath, warnings };
}

function loadBaton(coordination: string, batonId: string): RelayBaton {
  const batonPath = path.join(coordination, 'batons', `${batonId}.json`);
  if (!fs.existsSync(batonPath)) {
    throw new Error(`Baton not found: ${batonId}`);
  }
  return JSON.parse(fs.readFileSync(batonPath, 'utf-8')) as RelayBaton;
}

function verifyBatonForTask(
  coordination: string,
  taskId: string,
  dependencies: string[],
  batonId: string,
): RelayBaton {
  const baton = loadBaton(coordination, batonId);

  if (!baton.passed) {
    throw new Error(`Baton ${batonId} is not passed`);
  }
  if (baton.toTask !== taskId) {
    throw new Error(`Baton ${batonId} is for ${baton.toTask}, not ${taskId}`);
  }

  const batonDeps = baton.dependencies.map((dep) => dep.taskId).sort();
  const taskDeps = [...dependencies].sort();
  if (JSON.stringify(batonDeps) !== JSON.stringify(taskDeps)) {
    throw new Error(`Baton ${batonId} does not match current dependencies for ${taskId}`);
  }

  return baton;
}

function createReportForTask(
  root: string,
  config: Config,
  taskId: string,
  payload: {
    doneItems: string[];
    changedFiles: string[];
    testsOutput: string;
    nextSteps: string[];
    executor: string;
    status: TaskStatus;
    resultSummary?: string;
  },
): { reportId: string; reportPath: string } {
  const coordination = coordinationRoot(root, config);
  const tasksDir = path.join(coordination, 'tasks');
  const reportsDir = path.join(coordination, 'reports');

  const { taskPath, taskContent } = requireTaskContent(tasksDir, taskId);
  const reportId = nextEntityId(reportsDir, config.report_prefix);
  const reportPath = path.join(reportsDir, `${reportId}.md`);
  const title = extractTaskTitle(taskContent);

  const doneItems = payload.doneItems.length > 0
    ? payload.doneItems.map((item) => `- ✅ ${item}`).join('\n')
    : '- ✅ Implemented task';

  const changedFiles = payload.changedFiles.length > 0
    ? payload.changedFiles.map((item) => `- ${item}`).join('\n')
    : '- Not specified';

  const nextSteps = payload.nextSteps.length > 0
    ? payload.nextSteps.map((item) => `- [ ] ${item}`).join('\n')
    : '- [ ] Define next task';

  const report = `# ${reportId}: ${title}

## DATE
${nowIso()}

## EXECUTOR
${payload.executor}

## STATUS
${payload.status}

## TASK
${taskId}

## WORK DONE
${doneItems}

## FILES CHANGED
${changedFiles}

## TESTS
\`\`\`text
${payload.testsOutput}
\`\`\`

## RESULT
${payload.resultSummary || `Task ${taskId} completed and documented.`}

## NEXT STEPS
${nextSteps}
`;

  writeText(reportPath, report);
  updateTaskStatus(taskPath, payload.status);

  return { reportId, reportPath };
}

function defaultMockAiResponse(): string {
  return `## WORK DONE
- ✅ Implemented requested changes
- ✅ Updated related docs

## FILES CHANGED
- coordination/tasks/TASK-001.md

## TESTS
PASS mock-tests

## RESULT
Task completed in mock mode.

## NEXT STEPS
- [ ] Validate on staging
`;
}

async function callOpenAI(prompt: string, model: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set');
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: 'Return a markdown report with sections: WORK DONE, FILES CHANGED, TESTS, RESULT, NEXT STEPS.',
        },
        { role: 'user', content: prompt },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI request failed (${response.status}): ${text}`);
  }

  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('OpenAI response does not contain message content');
  }

  return content;
}

async function callAnthropic(prompt: string, model: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set');
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 3000,
      messages: [{ role: 'user', content: prompt }],
      system: 'Return a markdown report with sections: WORK DONE, FILES CHANGED, TESTS, RESULT, NEXT STEPS.',
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Anthropic request failed (${response.status}): ${text}`);
  }

  const data = await response.json() as {
    content?: Array<{ type?: string; text?: string }>;
  };

  const content = (data.content ?? [])
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n');

  if (!content) {
    throw new Error('Anthropic response does not contain text content');
  }

  return content;
}

async function callAiProvider(provider: string, prompt: string, model?: string): Promise<string> {
  const normalized = provider.toLowerCase();

  if (normalized === 'mock') {
    return process.env.BROTHERS_MOCK_AI_RESPONSE || defaultMockAiResponse();
  }

  if (normalized === 'openai') {
    return callOpenAI(prompt, model || 'gpt-4.1-mini');
  }

  if (normalized === 'anthropic' || normalized === 'claude') {
    return callAnthropic(prompt, model || 'claude-3-5-sonnet-latest');
  }

  throw new Error(
    `Unsupported AI provider for --auto: ${provider}. ` +
    `Use one of: mock, openai, anthropic`,
  );
}

function parseAiResponse(raw: string): ParsedAiReport {
  const statusText = extractAnySection(raw, ['STATUS', 'СТАТУС']).split('\n')[0]?.trim();
  const status = normalizeTaskStatus(statusText);

  const workSection = extractAnySection(raw, ['WORK DONE', 'ВЫПОЛНЕННЫЕ РАБОТЫ']);
  const filesSection = extractAnySection(raw, ['FILES CHANGED', 'ИЗМЕНЁННЫЕ ФАЙЛЫ']);
  const testsSection = extractAnySection(raw, ['TESTS', 'ТЕСТЫ']);
  const resultSection = extractAnySection(raw, ['RESULT', 'РЕЗУЛЬТАТ']);
  const nextStepsSection = extractAnySection(raw, ['NEXT STEPS', 'СЛЕДУЮЩИЕ ШАГИ']);

  const doneItems = parseChecklistItems(workSection);
  const changedFiles = parseChecklistItems(filesSection)
    .map((item) => item.replace(/^`|`$/g, '').trim())
    .filter((item) => /[\/]|\.[a-zA-Z0-9]+$/.test(item));
  const nextSteps = parseChecklistItems(nextStepsSection);

  const testsOutput = testsSection || 'No test output provided by AI response';
  const resultSummary = resultSection || 'Auto-generated report from AI response.';

  return {
    status,
    doneItems: doneItems.length > 0 ? doneItems : ['Implemented task according to AI response'],
    changedFiles: Array.from(new Set(changedFiles)),
    testsOutput,
    nextSteps,
    resultSummary,
  };
}

program
  .name('brothers')
  .description('Brothers Protocol CLI MVP')
  .version(VERSION);

program
  .command('init')
  .description('Initialize Brothers Protocol in current directory or a new directory')
  .argument('[projectName]', 'Optional directory name for initialization')
  .action((projectName?: string) => {
    const root = projectName ? path.resolve(process.cwd(), projectName) : process.cwd();
    ensureDir(root);

    if (fs.existsSync(path.join(root, '.brothers-config.json'))) {
      throw new Error(`Project already initialized: ${root}`);
    }

    const effectiveName = projectName || path.basename(root);
    setupProject(root, effectiveName);

    console.log(`Initialized Brothers Protocol project at: ${root}`);
    console.log('Created: coordination/tasks, coordination/reports, coordination/templates, coordination/batons, .brothers-config.json');
  });

program
  .command('task')
  .description('Create a new task')
  .argument('<title>', 'Task title')
  .option('-p, --priority <priority>', 'Task priority', 'medium')
  .option('-a, --assignee <assignee>', 'Task assignee', 'auto')
  .option('-d, --details <details>', 'Task details', '')
  .option('-f, --files <files>', 'Comma/semicolon separated files', '')
  .option('--depends-on <taskIds>', 'Comma/semicolon separated dependencies, e.g. TASK-001,TASK-002', '')
  .action((
    title: string,
    options: { priority: string; assignee: string; details: string; files: string; dependsOn: string },
  ) => {
    const root = findProjectRoot(process.cwd());
    const created = createTask(root, title, {
      priority: options.priority,
      assignee: options.assignee,
      details: options.details,
      files: splitList(options.files),
      dependsOn: splitList(options.dependsOn).map((dep) => dep.toUpperCase()),
    });

    console.log(`Created ${created.id}: ${title}`);
    console.log(`Task file: ${created.taskPath}`);
  });

program
  .command('link')
  .description('Attach dependency links to an existing task')
  .argument('<taskId>', 'Task id, e.g. TASK-002')
  .requiredOption('--depends-on <taskIds>', 'Comma/semicolon separated dependencies')
  .action((taskId: string, options: { dependsOn: string }) => {
    const root = findProjectRoot(process.cwd());
    const config = loadConfig(root);
    const tasksDir = path.join(coordinationRoot(root, config), 'tasks');
    const { taskPath, taskContent } = requireTaskContent(tasksDir, taskId);

    const deps = splitList(options.dependsOn).map((dep) => dep.toUpperCase());
    const updated = replaceDependenciesSection(taskContent, deps);
    writeText(taskPath, updated);

    console.log(`Updated dependencies for ${taskId}`);
    console.log(`Dependencies: ${deps.join(', ') || 'None'}`);
  });

program
  .command('relay-check')
  .description('Validate dependency chain and issue relay baton for a task')
  .argument('<taskId>', 'Task id, e.g. TASK-002')
  .option('--json', 'Output JSON only', false)
  .action((taskId: string, options: { json: boolean }) => {
    const root = findProjectRoot(process.cwd());
    const config = loadConfig(root);

    const result = runRelayCheck(root, config, taskId);

    if (options.json) {
      console.log(JSON.stringify({
        passed: true,
        taskId,
        batonId: result.baton.id,
        batonPath: result.batonPath,
        warnings: result.warnings,
      }, null, 2));
      return;
    }

    console.log(`Relay validation passed for ${taskId}`);
    console.log(`Baton: ${result.baton.id}`);
    console.log(`Baton file: ${result.batonPath}`);
    if (result.warnings.length > 0) {
      console.log('Warnings:');
      result.warnings.forEach((warning) => console.log(`- ${warning}`));
    }
  });

program
  .command('baton-info')
  .description('Show relay baton details')
  .argument('<batonId>', 'Baton id, e.g. BATON-001')
  .option('--json', 'Output JSON only', false)
  .action((batonId: string, options: { json: boolean }) => {
    const root = findProjectRoot(process.cwd());
    const config = loadConfig(root);
    const coordination = coordinationRoot(root, config);

    const baton = loadBaton(coordination, batonId);

    if (options.json) {
      console.log(JSON.stringify(baton, null, 2));
      return;
    }

    console.log(`BATON: ${baton.id}`);
    console.log(`Created: ${baton.createdAt}`);
    console.log(`To task: ${baton.toTask}`);
    console.log(`Passed: ${baton.passed ? 'yes' : 'no'}`);
    console.log('Dependencies:');
    for (const dep of baton.dependencies) {
      console.log(`- ${dep.taskId} via ${dep.reportId}`);
    }
  });

program
  .command('start')
  .description('Start task and generate AI prompt')
  .argument('<taskId>', 'Task id, e.g. TASK-001')
  .option('--ai <provider>', 'AI provider name', 'manual')
  .option('--with-baton <batonId>', 'Validated baton id, e.g. BATON-001')
  .option('--auto', 'Automatically send prompt to AI and create report', false)
  .option('--model <model>', 'Model name for auto mode', '')
  .action(async (taskId: string, options: { ai: string; withBaton?: string; auto: boolean; model: string }) => {
    const root = findProjectRoot(process.cwd());
    const config = loadConfig(root);
    const coordination = coordinationRoot(root, config);
    const tasksDir = path.join(coordination, 'tasks');

    const { taskPath, taskContent } = requireTaskContent(tasksDir, taskId);

    const dependencies = parseDependencies(taskContent);
    if (dependencies.length > 0) {
      if (!options.withBaton) {
        throw new Error(
          `Task ${taskId} has dependencies (${dependencies.join(', ')}). ` +
          `Run: brothers relay-check ${taskId} and start with --with-baton BATON-XXX`,
        );
      }
      verifyBatonForTask(coordination, taskId, dependencies, options.withBaton);
    }

    const rules = readTextIfExists(toAbs(root, config.rules_file));
    const conventions = readTextIfExists(toAbs(root, config.conventions_file));
    const latestReports = getLatestReportFiles(path.join(coordination, 'reports'), 3)
      .map((reportPath) => `\n---\nFile: ${path.basename(reportPath)}\n${fs.readFileSync(reportPath, 'utf-8')}`)
      .join('\n');

    const prompt = `CONTEXT: Working with Brothers Protocol\n\nRULES:\n${rules || '[No AI_RULES.md found]'}\n\nCONVENTIONS:\n${conventions || '[No CONVENTIONS.md found]'}\n\nTASK: ${taskId}\n${taskContent}\n\nRECENT REPORTS:\n${latestReports || '[No reports yet]'}\n\nINSTRUCTION:\nComplete the task and return a report using project template.`;

    const promptPath = path.join(coordination, 'prompts', `${taskId}-prompt.txt`);
    writeText(promptPath, prompt);
    updateTaskStatus(taskPath, 'IN_PROGRESS');

    console.log(`Task ${taskId} started`);
    console.log(`AI provider: ${options.ai}`);
    if (options.withBaton) {
      console.log(`Baton verified: ${options.withBaton}`);
    }
    console.log(`Prompt file: ${promptPath}`);

    if (!options.auto) {
      return;
    }

    if (options.ai.toLowerCase() === 'manual') {
      throw new Error('Auto mode requires --ai mock|openai|anthropic');
    }

    console.log('Auto mode enabled: sending prompt to AI...');
    const aiResponse = await callAiProvider(options.ai, prompt, options.model || undefined);

    const responsePath = path.join(coordination, 'prompts', `${taskId}-response.txt`);
    writeText(responsePath, aiResponse);
    console.log(`AI response saved: ${responsePath}`);

    const parsed = parseAiResponse(aiResponse);
    const created = createReportForTask(root, config, taskId, {
      doneItems: parsed.doneItems,
      changedFiles: parsed.changedFiles,
      testsOutput: parsed.testsOutput,
      nextSteps: parsed.nextSteps,
      executor: `${options.ai}${options.model ? `:${options.model}` : ''}`,
      status: parsed.status,
      resultSummary: parsed.resultSummary,
    });

    console.log(`Auto report created: ${created.reportId}`);
    console.log(`Report file: ${created.reportPath}`);
  });

program
  .command('report')
  .description('Create task report and update task status')
  .argument('<taskId>', 'Task id, e.g. TASK-001')
  .option('--done <items>', 'Done items separated by ; or ,', 'Implemented task')
  .option('--files <items>', 'Changed files separated by ; or ,', '')
  .option('--tests <output>', 'Tests output snippet', 'Tests were not run')
  .option('--next <items>', 'Next steps separated by ; or ,', '')
  .option('--executor <executor>', 'Executor name', 'manual')
  .option('--status <status>', 'Task final status', 'COMPLETED')
  .action((
    taskId: string,
    options: {
      done: string;
      files: string;
      tests: string;
      next: string;
      executor: string;
      status: string;
    },
  ) => {
    const root = findProjectRoot(process.cwd());
    const config = loadConfig(root);

    const created = createReportForTask(root, config, taskId, {
      doneItems: splitList(options.done),
      changedFiles: splitList(options.files),
      testsOutput: options.tests,
      nextSteps: splitList(options.next),
      executor: options.executor,
      status: normalizeTaskStatus(options.status),
    });

    console.log(`Report created: ${created.reportId}`);
    console.log(`Report file: ${created.reportPath}`);
  });

program
  .command('status')
  .description('Show project task/report status')
  .action(() => {
    const root = findProjectRoot(process.cwd());
    const config = loadConfig(root);
    const coordination = coordinationRoot(root, config);

    const tasksDir = path.join(coordination, 'tasks');
    const reportsDir = path.join(coordination, 'reports');
    const batonsDir = path.join(coordination, 'batons');

    const taskFiles = fs.existsSync(tasksDir)
      ? fs.readdirSync(tasksDir).filter((name) => /^TASK-\d+\.md$/.test(name)).sort()
      : [];

    const statuses: Record<TaskStatus, number> = {
      CREATED: 0,
      IN_PROGRESS: 0,
      COMPLETED: 0,
      BLOCKED: 0,
    };

    for (const file of taskFiles) {
      const content = fs.readFileSync(path.join(tasksDir, file), 'utf-8');
      const status = readTaskStatus(content);
      statuses[status] += 1;
    }

    const reportFiles = fs.existsSync(reportsDir)
      ? fs.readdirSync(reportsDir).filter((name) => /^REPORT-\d+\.md$/.test(name)).sort()
      : [];

    const batonFiles = fs.existsSync(batonsDir)
      ? fs.readdirSync(batonsDir).filter((name) => /^BATON-\d+\.json$/.test(name)).sort()
      : [];

    const lastReport = reportFiles.length > 0 ? reportFiles[reportFiles.length - 1] : 'None';

    console.log('BROTHERS STATUS');
    console.log(`Project: ${config.project}`);
    console.log(`Tasks total: ${taskFiles.length}`);
    console.log(`  COMPLETED: ${statuses.COMPLETED}`);
    console.log(`  IN_PROGRESS: ${statuses.IN_PROGRESS}`);
    console.log(`  CREATED: ${statuses.CREATED}`);
    console.log(`  BLOCKED: ${statuses.BLOCKED}`);
    console.log(`Reports total: ${reportFiles.length}`);
    console.log(`Batons total: ${batonFiles.length}`);
    console.log(`Last report: ${lastReport}`);
  });

program
  .command('next')
  .description('Suggest or create the next task from latest report')
  .option('--create <index>', 'Create task by 1-based index from next steps')
  .option('-p, --priority <priority>', 'Priority for auto-created task', 'medium')
  .option('-a, --assignee <assignee>', 'Assignee for auto-created task', 'auto')
  .option('--depends-on <taskIds>', 'Dependencies for auto-created task', '')
  .action((options: { create?: string; priority: string; assignee: string; dependsOn: string }) => {
    const root = findProjectRoot(process.cwd());
    const config = loadConfig(root);
    const reportsDir = path.join(coordinationRoot(root, config), 'reports');
    const latestReportPath = getLatestReportFiles(reportsDir, 1)[0];

    if (!latestReportPath) {
      throw new Error('No reports found. Create at least one report first.');
    }

    const reportContent = fs.readFileSync(latestReportPath, 'utf-8');
    const suggestions = parseNextSteps(reportContent);

    if (suggestions.length === 0) {
      throw new Error('Latest report has no parseable NEXT STEPS section.');
    }

    console.log(`Latest report: ${path.basename(latestReportPath)}`);
    suggestions.forEach((step, idx) => {
      console.log(`${idx + 1}. ${step}`);
    });

    if (options.create) {
      const index = Number(options.create);
      if (!Number.isInteger(index) || index < 1 || index > suggestions.length) {
        throw new Error(`Invalid index: ${options.create}`);
      }

      const created = createTask(root, suggestions[index - 1], {
        priority: options.priority,
        assignee: options.assignee,
        details: `Auto-created from ${path.basename(latestReportPath)} (step ${index})`,
        files: [],
        dependsOn: splitList(options.dependsOn).map((dep) => dep.toUpperCase()),
      });

      console.log(`Created ${created.id}: ${suggestions[index - 1]}`);
    }
  });

program.parse(process.argv);

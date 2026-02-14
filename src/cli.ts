#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';

const program = new Command();
const VERSION = '0.2.0';

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
  const escapedExt = extension.replace('.', '\\.')
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

function updateTaskStatus(taskPath: string, status: TaskStatus): void {
  const content = fs.readFileSync(taskPath, 'utf-8');
  const updated = content.replace(/\*Status:\s*[^*]+\*/g, `*Status: ${status}*`);
  fs.writeFileSync(taskPath, updated, 'utf-8');
}

function readTaskStatus(content: string): TaskStatus {
  const match = content.match(/\*Status:\s*([A-Z_]+)\*/);
  const status = match?.[1] as TaskStatus | undefined;
  return status ?? 'CREATED';
}

function extractSection(content: string, sectionTitle: string): string {
  const escaped = sectionTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matcher = new RegExp(`##\\s+${escaped}([\\s\\S]*?)(\\n##\\s+|$)`, 'i');
  const match = content.match(matcher);
  return match?.[1]?.trim() ?? '';
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
  const section = extractSection(reportContent, 'NEXT STEPS');
  if (!section) return [];

  const lines = section
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const steps: string[] = [];
  for (const line of lines) {
    const bullet = line.match(/^[-*]\s*(?:\[\s\]\s*)?(.+)$/);
    const numeric = line.match(/^\d+\.\s+(.+)$/);
    if (bullet) steps.push(bullet[1].trim());
    else if (numeric) steps.push(numeric[1].trim());
  }
  return steps;
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

  writeText(
    path.join(root, '.brothers-config.json'),
    `${JSON.stringify(config, null, 2)}\n`,
  );

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
    writeText(
      path.join(root, 'AI_RULES.md'),
      '# AI Rules\n\nAdd project-level AI execution rules here.\n',
    );
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

function findLatestReportForTask(reportsDir: string, taskId: string): { reportId: string; reportPath: string; reportContent: string } | null {
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
  const section = extractSection(reportContent, 'FILES CHANGED');
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
    checks: [
      'dependencies_completed',
      'reports_exist',
      'report_sections_valid',
      'artifacts_exist',
    ],
    passed: true,
  };

  const batonPath = path.join(batonsDir, `${batonId}.json`);
  writeText(batonPath, `${JSON.stringify(baton, null, 2)}\n`);

  return { baton, batonPath, warnings };
}

function verifyBatonForTask(
  coordination: string,
  taskId: string,
  dependencies: string[],
  batonId: string,
): RelayBaton {
  const batonPath = path.join(coordination, 'batons', `${batonId}.json`);
  if (!fs.existsSync(batonPath)) {
    throw new Error(`Baton not found: ${batonId}. Run: brothers relay-check ${taskId}`);
  }

  const baton = JSON.parse(fs.readFileSync(batonPath, 'utf-8')) as RelayBaton;
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
    options: {
      priority: string;
      assignee: string;
      details: string;
      files: string;
      dependsOn: string;
    },
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
  .action((taskId: string) => {
    const root = findProjectRoot(process.cwd());
    const config = loadConfig(root);

    const result = runRelayCheck(root, config, taskId);

    console.log(`Relay validation passed for ${taskId}`);
    console.log(`Baton: ${result.baton.id}`);
    console.log(`Baton file: ${result.batonPath}`);
    if (result.warnings.length > 0) {
      console.log('Warnings:');
      result.warnings.forEach((warning) => console.log(`- ${warning}`));
    }
  });

program
  .command('start')
  .description('Start task and generate AI prompt')
  .argument('<taskId>', 'Task id, e.g. TASK-001')
  .option('--ai <provider>', 'AI provider name', 'manual')
  .option('--with-baton <batonId>', 'Validated baton id, e.g. BATON-001')
  .action((taskId: string, options: { ai: string; withBaton?: string }) => {
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
    const coordination = coordinationRoot(root, config);
    const tasksDir = path.join(coordination, 'tasks');

    const { taskPath, taskContent } = requireTaskContent(tasksDir, taskId);

    const reportsDir = path.join(coordination, 'reports');
    const reportId = nextEntityId(reportsDir, config.report_prefix);
    const reportPath = path.join(reportsDir, `${reportId}.md`);

    const title = extractTaskTitle(taskContent);

    const doneItems = splitList(options.done).map((item) => `- ✅ ${item}`).join('\n') || '- ✅ Implemented task';
    const changedFiles = splitList(options.files).map((item) => `- ${item}`).join('\n') || '- Not specified';
    const nextSteps = splitList(options.next).map((item) => `- [ ] ${item}`).join('\n') || '- [ ] Define next task';

    const report = `# ${reportId}: ${title}

## DATE
${nowIso()}

## EXECUTOR
${options.executor}

## STATUS
${options.status}

## TASK
${taskId}

## WORK DONE
${doneItems}

## FILES CHANGED
${changedFiles}

## TESTS
\`\`\`text
${options.tests}
\`\`\`

## RESULT
Task ${taskId} completed and documented.

## NEXT STEPS
${nextSteps}
`;

    writeText(reportPath, report);

    const status = options.status.toUpperCase() as TaskStatus;
    const finalStatus: TaskStatus = ['CREATED', 'IN_PROGRESS', 'COMPLETED', 'BLOCKED'].includes(status)
      ? status
      : 'COMPLETED';
    updateTaskStatus(taskPath, finalStatus);

    console.log(`Report created: ${reportId}`);
    console.log(`Report file: ${reportPath}`);
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
      const title = suggestions[index - 1];
      const created = createTask(root, title, {
        priority: options.priority,
        assignee: options.assignee,
        details: `Auto-created from ${path.basename(latestReportPath)} (step ${index})`,
        files: [],
        dependsOn: splitList(options.dependsOn).map((dep) => dep.toUpperCase()),
      });
      console.log(`Created ${created.id}: ${title}`);
    }
  });

program.parse(process.argv);

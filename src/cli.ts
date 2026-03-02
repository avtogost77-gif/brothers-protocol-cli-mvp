#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';

const program = new Command();
const VERSION = '0.6.0';

type TaskStatus = 'CREATED' | 'IN_PROGRESS' | 'COMPLETED' | 'BLOCKED';

type Config = {
  project: string;
  version: string;
  ai_provider: string;
  ai_model: string;
  auto_sanitize_prompt: boolean;
  ai_retries: number;
  ai_retry_delay_ms: number;
  coordination_dir: string;
  auto_commit: boolean;
  task_prefix: string;
  report_prefix: string;
  conventions_file: string;
  rules_file: string;
  baton_ttl_hours: number;
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
  expiresAt: string;
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
  ai_provider: 'manual',
  ai_model: '',
  auto_sanitize_prompt: true,
  ai_retries: 2,
  ai_retry_delay_ms: 800,
  coordination_dir: './coordination',
  auto_commit: false,
  task_prefix: 'TASK',
  report_prefix: 'REPORT',
  conventions_file: './CONVENTIONS.md',
  rules_file: './AI_RULES.md',
  baton_ttl_hours: 72,
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

function boolFromMode(mode: string | undefined, fallback: boolean): boolean {
  if (!mode || mode === 'auto') return fallback;
  if (mode === 'on' || mode === 'true' || mode === '1') return true;
  if (mode === 'off' || mode === 'false' || mode === '0') return false;
  throw new Error(`Invalid mode: ${mode}. Expected on|off|auto`);
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

function saveConfig(root: string, config: Config): void {
  writeText(path.join(root, '.brothers-config.json'), `${JSON.stringify(config, null, 2)}\n`);
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
  ensureDir(dirPath);
  // Atomic ID allocation: O_EXCL fails if file already exists, preventing race conditions
  // when multiple CLI processes run concurrently (e.g. in CI pipelines).
  for (let attempt = 0; attempt < 20; attempt++) {
    const ids = numericIdsFromFiles(dirPath, prefix, extension);
    const next = ids.length === 0 ? 1 : Math.max(...ids) + 1;
    const candidate = `${prefix}-${String(next).padStart(3, '0')}`;
    const placeholder = path.join(dirPath, `${candidate}${extension}`);
    try {
      // O_CREAT | O_EXCL: creates file only if it does NOT exist (atomic on POSIX)
      const fd = fs.openSync(placeholder, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
      fs.closeSync(fd);
      // Placeholder written — caller's writeText() will overwrite with real content
      return candidate;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue; // another process claimed this ID
      throw e;
    }
  }
  throw new Error(`Failed to allocate unique ${prefix} ID after 20 attempts (concurrent writes?)`);
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
    if (/^TASK-\d+$/i.test(value)) deps.push(value.toUpperCase());
  }

  return Array.from(new Set(deps));
}

/**
 * DFS cycle detection in the task dependency graph.
 * Returns the cycle path (e.g. ["TASK-001","TASK-003","TASK-001"]) or null if no cycle.
 * Uses a recursion stack (recStack) to distinguish back-edges from cross-edges.
 */
function detectCycles(
  startId: string,
  tasksDir: string,
  visited: Set<string> = new Set(),
  recStack: string[] = [],
): string[] | null {
  if (recStack.includes(startId)) {
    // Found a back-edge → cycle. Return path from first occurrence to current.
    return [...recStack.slice(recStack.indexOf(startId)), startId];
  }
  if (visited.has(startId)) return null; // already fully explored, no cycle through here
  visited.add(startId);

  const taskFile = path.join(tasksDir, `${startId}.md`);
  if (!fs.existsSync(taskFile)) return null; // task doesn't exist yet, skip

  const content = fs.readFileSync(taskFile, 'utf-8');
  const deps = parseDependencies(content);

  for (const dep of deps) {
    const cycle = detectCycles(dep, tasksDir, visited, [...recStack, startId]);
    if (cycle) return cycle;
  }

  return null;
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

  saveConfig(root, config);

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

  // Guard: detect cycles before writing. Since `id` doesn't exist yet,
  // a cycle would only occur if any existing dep already (transitively) points
  // back to a task with the same id — practically impossible, but safe to check.
  for (const dep of options.dependsOn) {
    const cycle = detectCycles(dep, tasksDir, new Set([id]), [id]);
    if (cycle) {
      // Remove the placeholder created by nextEntityId before throwing
      const placeholder = path.join(tasksDir, `${id}.md`);
      if (fs.existsSync(placeholder)) fs.unlinkSync(placeholder);
      throw new Error(`Circular dependency detected: ${cycle.join(' → ')}`);
    }
  }

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
    const candidate = bullet[1].replace(/^`|`$/g, '').replace(/\s+\(.*\)$/, '').trim();
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

function validateRelayCheck(
  root: string,
  config: Config,
  taskId: string,
): { warnings: string[]; validatedDeps: RelayDependencyValidation[] } {
  const coordination = coordinationRoot(root, config);
  const tasksDir = path.join(coordination, 'tasks');
  const reportsDir = path.join(coordination, 'reports');

  const { taskContent } = requireTaskContent(tasksDir, taskId);
  const dependencies = parseDependencies(taskContent);

  if (dependencies.length === 0) {
    throw new Error(`Task ${taskId} has no dependencies. Relay check is not required.`);
  }

  // Safety net: reject relay-check if someone manually introduced a cycle
  for (const dep of dependencies) {
    const cycle = detectCycles(dep, tasksDir, new Set([taskId]), [taskId]);
    if (cycle) {
      throw new Error(`Circular dependency detected: ${cycle.join(' → ')}. Fix dependencies before relay-check.`);
    }
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

  return { warnings, validatedDeps };
}

function issueRelayBaton(
  root: string,
  config: Config,
  taskId: string,
  validatedDeps: RelayDependencyValidation[],
): { baton: RelayBaton; batonPath: string } {
  const coordination = coordinationRoot(root, config);
  const batonsDir = path.join(coordination, 'batons');

  ensureDir(batonsDir);

  const batonId = nextEntityId(batonsDir, 'BATON', '.json');
  const ttlHours = config.baton_ttl_hours ?? 72;
  const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
  const baton: RelayBaton = {
    id: batonId,
    createdAt: nowIso(),
    expiresAt,
    toTask: taskId,
    dependencies: validatedDeps,
    checks: ['dependencies_completed', 'reports_exist', 'report_sections_valid', 'artifacts_exist'],
    passed: true,
  };

  const batonPath = path.join(batonsDir, `${batonId}.json`);
  writeText(batonPath, `${JSON.stringify(baton, null, 2)}\n`);

  return { baton, batonPath };
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

  if (!baton.passed) throw new Error(`Baton ${batonId} is not passed`);
  if (baton.expiresAt && new Date(baton.expiresAt) < new Date()) {
    throw new Error(
      `Baton ${batonId} expired at ${baton.expiresAt}. Run: brothers relay-check ${taskId} to issue a fresh baton.`,
    );
  }
  if (baton.toTask !== taskId) throw new Error(`Baton ${batonId} is for ${baton.toTask}, not ${taskId}`);

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

function sanitizePrompt(raw: string): string {
  const replacements: Array<[RegExp, string]> = [
    [/ghp_[A-Za-z0-9]{20,}/g, '[REDACTED_GITHUB_TOKEN]'],
    [/sk-[A-Za-z0-9_-]{16,}/g, '[REDACTED_API_KEY]'],
    [/AKIA[0-9A-Z]{16}/g, '[REDACTED_AWS_KEY]'],
    [/AIza[0-9A-Za-z-_]{20,}/g, '[REDACTED_GOOGLE_KEY]'],
    [/(password\s*[:=]\s*)[^\s\n]+/gi, '$1[REDACTED_PASSWORD]'],
    [/(token\s*[:=]\s*)[^\s\n]+/gi, '$1[REDACTED_TOKEN]'],
    [/(api[_-]?key\s*[:=]\s*)[^\s\n]+/gi, '$1[REDACTED_API_KEY]'],
    [/(authorization\s*:\s*bearer\s+)[^\s\n]+/gi, '$1[REDACTED_BEARER]'],
  ];

  let sanitized = raw;
  for (const [pattern, replacement] of replacements) {
    sanitized = sanitized.replace(pattern, replacement);
  }
  return sanitized;
}

function buildPrompt(
  root: string,
  config: Config,
  taskId: string,
  taskContent: string,
): { rawPrompt: string; sanitizedPrompt: string } {
  const coordination = coordinationRoot(root, config);
  const rules = readTextIfExists(toAbs(root, config.rules_file));
  const conventions = readTextIfExists(toAbs(root, config.conventions_file));
  const latestReports = getLatestReportFiles(path.join(coordination, 'reports'), 3)
    .map((reportPath) => `\n---\nFile: ${path.basename(reportPath)}\n${fs.readFileSync(reportPath, 'utf-8')}`)
    .join('\n');

  const rawPrompt = `CONTEXT: Working with Brothers Protocol\n\nRULES:\n${rules || '[No AI_RULES.md found]'}\n\nCONVENTIONS:\n${conventions || '[No CONVENTIONS.md found]'}\n\nTASK: ${taskId}\n${taskContent}\n\nRECENT REPORTS:\n${latestReports || '[No reports yet]'}\n\nINSTRUCTION:\nComplete the task and return a report using project template.`;
  return { rawPrompt, sanitizedPrompt: sanitizePrompt(rawPrompt) };
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
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');

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

  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenAI response does not contain message content');

  return content;
}

async function callAnthropic(prompt: string, model: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');

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

  const data = await response.json() as { content?: Array<{ type?: string; text?: string }> };
  const content = (data.content ?? [])
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n');

  if (!content) throw new Error('Anthropic response does not contain text content');
  return content;
}

async function callClaudeCode(prompt: string): Promise<string> {
  // Claude Code blocks nested sessions (CLAUDECODE env var is set when running inside Claude Code)
  if (process.env.CLAUDECODE) {
    throw new Error(
      'Cannot call Claude Code from within a Claude Code session.\n' +
      'Run brothers commands from a regular terminal (outside Claude Code).',
    );
  }

  const { spawnSync } = await import('node:child_process');
  const result = spawnSync('claude', ['--print'], {
    input: prompt,
    encoding: 'utf-8',
    timeout: 120000,
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.error) {
    const err = result.error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      throw new Error(
        'claude command not found. Make sure Claude Code is installed and in PATH.\n' +
        'Install: https://claude.ai/code',
      );
    }
    throw new Error(`Claude Code error: ${err.message}`);
  }

  if (result.status !== 0) {
    const errMsg = (result.stderr as string) || `exit code ${result.status}`;
    throw new Error(`Claude Code failed: ${errMsg.trim()}`);
  }

  const output = (result.stdout as string) || '';
  // Strip ANSI escape codes for clean report parsing
  return output.replace(/\x1b\[[0-9;]*m/g, '').trim();
}

async function callAiProvider(provider: string, prompt: string, model: string | undefined, attempt: number): Promise<string> {
  const normalized = provider.toLowerCase();

  if (normalized === 'mock') {
    const failCount = Number(process.env.BROTHERS_MOCK_FAILS || '0');
    if (attempt <= failCount) {
      throw new Error(`Mock provider forced failure on attempt ${attempt}/${failCount}`);
    }
    return process.env.BROTHERS_MOCK_AI_RESPONSE || defaultMockAiResponse();
  }

  if (normalized === 'openai') return callOpenAI(prompt, model || 'gpt-4.1-mini');
  if (normalized === 'anthropic' || normalized === 'claude') return callAnthropic(prompt, model || 'claude-3-5-sonnet-latest');
  if (normalized === 'claude-code') return callClaudeCode(prompt);

  throw new Error(`Unsupported AI provider for --auto: ${provider}. Use one of: mock, openai, anthropic, claude-code`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callAiWithRetry(
  provider: string,
  prompt: string,
  model: string | undefined,
  retries: number,
  retryDelayMs: number,
): Promise<string> {
  let lastError: unknown;
  const maxAttempts = Math.max(1, retries + 1);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await callAiProvider(provider, prompt, model, attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts) break;

      console.log(`AI attempt ${attempt} failed: ${(error as Error).message}`);
      const delay = retryDelayMs * attempt;
      console.log(`Retrying in ${delay}ms...`);
      await sleep(delay);
    }
  }

  throw new Error(`AI provider failed after ${maxAttempts} attempts: ${(lastError as Error).message}`);
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

const ai = program.command('ai').description('Configure AI provider defaults');

ai
  .command('providers')
  .description('List supported auto providers')
  .action(() => {
    console.log('Supported providers:');
    console.log('- mock         (testing, no API key required)');
    console.log('- claude-code  (uses local Claude Code session, no API key required)');
    console.log('- openai       (requires OPENAI_API_KEY)');
    console.log('- anthropic    (requires ANTHROPIC_API_KEY)');
  });

ai
  .command('show')
  .description('Show AI configuration')
  .action(() => {
    const root = findProjectRoot(process.cwd());
    const config = loadConfig(root);

    console.log('AI CONFIG');
    console.log(`provider: ${config.ai_provider}`);
    console.log(`model: ${config.ai_model || '(default per provider)'}`);
    console.log(`sanitize_prompt: ${config.auto_sanitize_prompt}`);
    console.log(`retries: ${config.ai_retries}`);
    console.log(`retry_delay_ms: ${config.ai_retry_delay_ms}`);
  });

ai
  .command('setup')
  .description('Set AI defaults in .brothers-config.json')
  .option('--provider <provider>', 'manual|mock|openai|anthropic')
  .option('--model <model>', 'Default model for --auto mode')
  .option('--sanitize <mode>', 'on|off')
  .option('--retries <count>', 'Retry count for auto calls')
  .option('--retry-delay-ms <ms>', 'Base retry delay in milliseconds')
  .action((options: { provider?: string; model?: string; sanitize?: string; retries?: string; retryDelayMs?: string }) => {
    const root = findProjectRoot(process.cwd());
    const config = loadConfig(root);

    if (options.provider) {
      const normalized = options.provider.toLowerCase();
      if (!['manual', 'mock', 'openai', 'anthropic', 'claude', 'claude-code'].includes(normalized)) {
        throw new Error('Unsupported provider. Use manual|mock|openai|anthropic|claude-code');
      }
      config.ai_provider = normalized === 'claude' ? 'anthropic' : normalized;
    }

    if (options.model !== undefined) config.ai_model = options.model;

    if (options.sanitize !== undefined) {
      config.auto_sanitize_prompt = boolFromMode(options.sanitize, config.auto_sanitize_prompt);
    }

    if (options.retries !== undefined) {
      const retries = Number(options.retries);
      if (!Number.isInteger(retries) || retries < 0 || retries > 10) {
        throw new Error('retries must be an integer between 0 and 10');
      }
      config.ai_retries = retries;
    }

    if (options.retryDelayMs !== undefined) {
      const retryDelayMs = Number(options.retryDelayMs);
      if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 60000) {
        throw new Error('retry-delay-ms must be an integer between 0 and 60000');
      }
      config.ai_retry_delay_ms = retryDelayMs;
    }

    saveConfig(root, config);

    console.log('AI config updated');
    console.log(`provider: ${config.ai_provider}`);
    console.log(`model: ${config.ai_model || '(default per provider)'}`);
    console.log(`sanitize_prompt: ${config.auto_sanitize_prompt}`);
    console.log(`retries: ${config.ai_retries}`);
    console.log(`retry_delay_ms: ${config.ai_retry_delay_ms}`);
  });

ai
  .command('test')
  .description('Validate AI provider credentials/configuration')
  .option('--provider <provider>', 'manual|mock|openai|anthropic')
  .option('--model <model>', 'Model override for live test')
  .option('--live', 'Make a real API call (openai/anthropic)', false)
  .action(async (options: { provider?: string; model?: string; live: boolean }) => {
    const root = findProjectRoot(process.cwd());
    const config = loadConfig(root);

    const provider = (options.provider || config.ai_provider || 'manual').toLowerCase();
    const model = options.model || config.ai_model || undefined;

    if (provider === 'manual') {
      throw new Error('AI provider is manual. Set provider via: brothers ai setup --provider mock|openai|anthropic|claude-code');
    }

    if (provider === 'mock') {
      const response = await callAiWithRetry('mock', 'PING', model, 0, 0);
      console.log('AI test passed');
      console.log(`provider: ${provider}`);
      if (model) console.log(`model: ${model}`);
      console.log(`response_size: ${response.length}`);
      return;
    }

    if (provider === 'claude-code') {
      const { spawnSync } = await import('node:child_process');
      const check = spawnSync('claude', ['--version'], { encoding: 'utf-8' });
      if (check.error || check.status !== 0) {
        throw new Error(
          'claude command not found or not working.\n' +
          'Install Claude Code: https://claude.ai/code',
        );
      }
      const version = ((check.stdout as string) || '').trim();
      if (!options.live) {
        console.log('AI test passed (claude command found)');
        console.log('provider: claude-code');
        console.log(`claude version: ${version}`);
        console.log('Use --live to run a real call');
        return;
      }
      const response = await callClaudeCode('Return exactly one word: PONG');
      console.log('AI live test passed');
      console.log('provider: claude-code');
      console.log(`claude version: ${version}`);
      console.log(`response: ${response.slice(0, 100)}`);
      return;
    }

    if (provider === 'openai') {
      if (!process.env.OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY is not set');
      }
      if (!options.live) {
        console.log('AI test passed (credentials present)');
        console.log('provider: openai');
        console.log('Use --live to execute an API request');
        return;
      }
    }

    if (provider === 'anthropic' || provider === 'claude') {
      if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error('ANTHROPIC_API_KEY is not set');
      }
      if (!options.live) {
        console.log('AI test passed (credentials present)');
        console.log('provider: anthropic');
        console.log('Use --live to execute an API request');
        return;
      }
    }

    const normalizedProvider = provider === 'claude' ? 'anthropic' : provider;
    const response = await callAiWithRetry(normalizedProvider, 'Return exactly: PONG', model, 0, 0);
    console.log('AI live test passed');
    console.log(`provider: ${normalizedProvider}`);
    if (model) console.log(`model: ${model}`);
    console.log(`response_size: ${response.length}`);
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

    // Guard: detect circular dependencies before persisting
    for (const dep of deps) {
      const cycle = detectCycles(dep, tasksDir, new Set([taskId.toUpperCase()]), [taskId.toUpperCase()]);
      if (cycle) {
        throw new Error(`Circular dependency detected: ${cycle.join(' → ')}`);
      }
    }

    const updated = replaceDependenciesSection(taskContent, deps);
    writeText(taskPath, updated);

    console.log(`Updated dependencies for ${taskId}`);
    console.log(`Dependencies: ${deps.join(', ') || 'None'}`);
  });

program
  .command('relay-check')
  .description('Validate dependency chain and issue relay baton for a task')
  .argument('<taskId>', 'Task id, e.g. TASK-002')
  .option('--strict', 'Treat warnings as validation errors', false)
  .option('--json', 'Output JSON only', false)
  .action((taskId: string, options: { strict: boolean; json: boolean }) => {
    const root = findProjectRoot(process.cwd());
    const config = loadConfig(root);

    const validation = validateRelayCheck(root, config, taskId);
    const strictFailed = options.strict && validation.warnings.length > 0;

    if (options.json) {
      if (strictFailed) {
        console.log(JSON.stringify({
          passed: false,
          strict: options.strict,
          taskId,
          warnings: validation.warnings,
        }, null, 2));
        process.exitCode = 1;
        return;
      }

      const issued = issueRelayBaton(root, config, taskId, validation.validatedDeps);
      console.log(JSON.stringify({
        passed: true,
        strict: options.strict,
        taskId,
        batonId: issued.baton.id,
        batonPath: issued.batonPath,
        warnings: validation.warnings,
      }, null, 2));
      return;
    }

    if (strictFailed) {
      throw new Error(`Relay strict mode failed:\n- ${validation.warnings.join('\n- ')}`);
    }

    const issued = issueRelayBaton(root, config, taskId, validation.validatedDeps);
    console.log(`Relay validation passed for ${taskId}`);
    console.log(`Baton: ${issued.baton.id}`);
    console.log(`Baton file: ${issued.batonPath}`);
    if (validation.warnings.length > 0) {
      console.log('Warnings:');
      validation.warnings.forEach((warning) => console.log(`- ${warning}`));
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

    const expired = baton.expiresAt && new Date(baton.expiresAt) < new Date();
    console.log(`BATON: ${baton.id}`);
    console.log(`Created:  ${baton.createdAt}`);
    console.log(`Expires:  ${baton.expiresAt ?? 'n/a'}${expired ? ' ⚠ EXPIRED' : ''}`);
    console.log(`To task:  ${baton.toTask}`);
    console.log(`Passed:   ${baton.passed ? 'yes' : 'no'}`);
    console.log('Dependencies:');
    for (const dep of baton.dependencies) {
      console.log(`- ${dep.taskId} via ${dep.reportId}`);
    }
  });

program
  .command('prompt')
  .description('Generate task prompt without starting execution')
  .argument('<taskId>', 'Task id, e.g. TASK-001')
  .option('--sanitize <mode>', 'auto|on|off', 'auto')
  .option('--sanitize-preview', 'Show raw and sanitized prompt', false)
  .option('--save', 'Save selected prompt to coordination/prompts', false)
  .action((taskId: string, options: { sanitize: string; sanitizePreview: boolean; save: boolean }) => {
    const root = findProjectRoot(process.cwd());
    const config = loadConfig(root);
    const coordination = coordinationRoot(root, config);
    const tasksDir = path.join(coordination, 'tasks');
    const { taskContent } = requireTaskContent(tasksDir, taskId);

    const built = buildPrompt(root, config, taskId, taskContent);
    const sanitizeEnabled = boolFromMode(options.sanitize, config.auto_sanitize_prompt);
    const selectedPrompt = sanitizeEnabled ? built.sanitizedPrompt : built.rawPrompt;

    if (options.sanitizePreview) {
      console.log('--- RAW PROMPT ---');
      console.log(built.rawPrompt);
      console.log('--- SANITIZED PROMPT ---');
      console.log(built.sanitizedPrompt);
    } else {
      console.log(selectedPrompt);
    }

    if (options.save) {
      const promptPath = path.join(coordination, 'prompts', `${taskId}-prompt.txt`);
      writeText(promptPath, selectedPrompt);
      console.log(`Saved prompt: ${promptPath}`);
    }
  });

program
  .command('start')
  .description('Start task and generate AI prompt')
  .argument('<taskId>', 'Task id, e.g. TASK-001')
  .option('--ai <provider>', 'AI provider name (manual|mock|openai|anthropic)')
  .option('--model <model>', 'Model name for auto mode')
  .option('--with-baton <batonId>', 'Validated baton id, e.g. BATON-001')
  .option('--dry-run', 'Generate prompt only, without status change or AI call', false)
  .option('--auto', 'Automatically send prompt to AI and create report', false)
  .option('--sanitize <mode>', 'auto|on|off', 'auto')
  .option('--retries <count>', 'Override retry count for this run')
  .option('--retry-delay-ms <ms>', 'Override base retry delay for this run')
  .action(async (
    taskId: string,
    options: {
      ai?: string;
      model?: string;
      withBaton?: string;
      dryRun: boolean;
      auto: boolean;
      sanitize: string;
      retries?: string;
      retryDelayMs?: string;
    },
  ) => {
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

    if (options.dryRun && options.auto) {
      throw new Error('--dry-run cannot be combined with --auto');
    }

    const providerFromConfig = (config.ai_provider || 'manual').toLowerCase();
    const provider = (options.ai || providerFromConfig).toLowerCase();
    const model = options.model
      || (!options.ai || provider === providerFromConfig ? (config.ai_model || undefined) : undefined);

    const built = buildPrompt(root, config, taskId, taskContent);
    const sanitizeEnabled = boolFromMode(options.sanitize, config.auto_sanitize_prompt);
    const prompt = sanitizeEnabled ? built.sanitizedPrompt : built.rawPrompt;

    const promptPath = path.join(coordination, 'prompts', `${taskId}-prompt.txt`);
    writeText(promptPath, prompt);

    if (options.dryRun) {
      console.log(`Task ${taskId} dry-run completed`);
      console.log(`AI provider: ${provider}`);
      if (model) console.log(`Model: ${model}`);
      if (options.withBaton) console.log(`Baton verified: ${options.withBaton}`);
      console.log(`Prompt sanitized: ${sanitizeEnabled}`);
      console.log(`Prompt file: ${promptPath}`);
      console.log('Dry run: task status unchanged, no AI calls executed');
      return;
    }

    updateTaskStatus(taskPath, 'IN_PROGRESS');

    console.log(`Task ${taskId} started`);
    console.log(`AI provider: ${provider}`);
    if (model) console.log(`Model: ${model}`);
    if (options.withBaton) console.log(`Baton verified: ${options.withBaton}`);
    console.log(`Prompt sanitized: ${sanitizeEnabled}`);
    console.log(`Prompt file: ${promptPath}`);

    if (!options.auto) return;

    if (provider === 'manual') {
      throw new Error('Auto mode requires provider mock|openai|anthropic (via --ai or brothers ai setup)');
    }

    const retries = options.retries !== undefined ? Number(options.retries) : config.ai_retries;
    const retryDelayMs = options.retryDelayMs !== undefined ? Number(options.retryDelayMs) : config.ai_retry_delay_ms;
    if (!Number.isInteger(retries) || retries < 0 || retries > 10) {
      throw new Error('retries must be integer between 0 and 10');
    }
    if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 60000) {
      throw new Error('retry-delay-ms must be integer between 0 and 60000');
    }

    console.log('Auto mode enabled: sending prompt to AI...');
    const aiResponse = await callAiWithRetry(provider, prompt, model, retries, retryDelayMs);

    const responsePath = path.join(coordination, 'prompts', `${taskId}-response.txt`);
    writeText(responsePath, aiResponse);
    console.log(`AI response saved: ${responsePath}`);

    const parsed = parseAiResponse(aiResponse);
    const created = createReportForTask(root, config, taskId, {
      doneItems: parsed.doneItems,
      changedFiles: parsed.changedFiles,
      testsOutput: parsed.testsOutput,
      nextSteps: parsed.nextSteps,
      executor: `${provider}${model ? `:${model}` : ''}`,
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
    options: { done: string; files: string; tests: string; next: string; executor: string; status: string },
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

// ─── UI (TUI dashboard) ────────────────────────────────────────────────────────
program
  .command('ui')
  .description('Launch interactive TUI dashboard')
  .action(async () => {
    const { spawn } = await import('node:child_process');
    const { fileURLToPath: ftu } = await import('node:url');
    const tuiPath = path.join(path.dirname(ftu(import.meta.url)), 'tui', 'index.js');
    if (!fs.existsSync(tuiPath)) {
      console.error('TUI not built. Run: npm run build');
      process.exit(1);
    }
    const child = spawn(process.execPath, [tuiPath], { stdio: 'inherit' });
    child.on('exit', code => process.exit(code ?? 0));
  });

process.on('uncaughtException', (err) => {
  console.error(err.message);
  process.exit(1);
});

program.parseAsync(process.argv);

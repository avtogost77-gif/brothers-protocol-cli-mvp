#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';

const program = new Command();
const VERSION = '0.1.0';

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

function numericIdsFromFiles(dirPath: string, prefix: string): number[] {
  if (!fs.existsSync(dirPath)) return [];
  const matcher = new RegExp(`^${prefix}-(\\d+)\\.md$`);
  return fs
    .readdirSync(dirPath)
    .map((name) => {
      const match = name.match(matcher);
      return match ? Number(match[1]) : null;
    })
    .filter((id): id is number => Number.isFinite(id));
}

function nextEntityId(dirPath: string, prefix: string): string {
  const ids = numericIdsFromFiles(dirPath, prefix);
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

function renderTaskMarkdown(id: string, title: string, priority: string, assignee: string, details: string, files: string[]): string {
  const filesList = files.length > 0 ? files.map((file) => `- ${file}`).join('\n') : 'None';
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
  const sectionMatch = reportContent.match(/##\s+NEXT STEPS([\s\S]*?)(\n##\s+|$)/i);
  if (!sectionMatch) return [];
  const section = sectionMatch[1];
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

## Date
{DATE}

## Executor
{EXECUTOR}

## Status
{STATUS}

## Task
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

function createTask(root: string, title: string, options: { priority: string; assignee: string; details: string; files: string[] }): { id: string; taskPath: string } {
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
  );
  writeText(taskPath, content);
  return { id, taskPath };
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
    console.log('Created: coordination/tasks, coordination/reports, coordination/templates, .brothers-config.json');
  });

program
  .command('task')
  .description('Create a new task')
  .argument('<title>', 'Task title')
  .option('-p, --priority <priority>', 'Task priority', 'medium')
  .option('-a, --assignee <assignee>', 'Task assignee', 'auto')
  .option('-d, --details <details>', 'Task details', '')
  .option('-f, --files <files>', 'Comma/semicolon separated files', '')
  .action((title: string, options: { priority: string; assignee: string; details: string; files: string }) => {
    const root = findProjectRoot(process.cwd());
    const created = createTask(root, title, {
      priority: options.priority,
      assignee: options.assignee,
      details: options.details,
      files: splitList(options.files),
    });

    console.log(`Created ${created.id}: ${title}`);
    console.log(`Task file: ${created.taskPath}`);
  });

program
  .command('start')
  .description('Start task and generate AI prompt')
  .argument('<taskId>', 'Task id, e.g. TASK-001')
  .option('--ai <provider>', 'AI provider name', 'manual')
  .action((taskId: string, options: { ai: string }) => {
    const root = findProjectRoot(process.cwd());
    const config = loadConfig(root);
    const coordination = coordinationRoot(root, config);
    const taskPath = path.join(coordination, 'tasks', `${taskId}.md`);

    if (!fs.existsSync(taskPath)) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const taskContent = fs.readFileSync(taskPath, 'utf-8');
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
    const taskPath = path.join(coordination, 'tasks', `${taskId}.md`);

    if (!fs.existsSync(taskPath)) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const reportsDir = path.join(coordination, 'reports');
    const reportId = nextEntityId(reportsDir, config.report_prefix);
    const reportPath = path.join(reportsDir, `${reportId}.md`);

    const taskContent = fs.readFileSync(taskPath, 'utf-8');
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

    const lastReport = reportFiles.length > 0 ? reportFiles[reportFiles.length - 1] : 'None';

    console.log('BROTHERS STATUS');
    console.log(`Project: ${config.project}`);
    console.log(`Tasks total: ${taskFiles.length}`);
    console.log(`  COMPLETED: ${statuses.COMPLETED}`);
    console.log(`  IN_PROGRESS: ${statuses.IN_PROGRESS}`);
    console.log(`  CREATED: ${statuses.CREATED}`);
    console.log(`  BLOCKED: ${statuses.BLOCKED}`);
    console.log(`Reports total: ${reportFiles.length}`);
    console.log(`Last report: ${lastReport}`);
  });

program
  .command('next')
  .description('Suggest or create the next task from latest report')
  .option('--create <index>', 'Create task by 1-based index from next steps')
  .option('-p, --priority <priority>', 'Priority for auto-created task', 'medium')
  .option('-a, --assignee <assignee>', 'Assignee for auto-created task', 'auto')
  .action((options: { create?: string; priority: string; assignee: string }) => {
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
      });
      console.log(`Created ${created.id}: ${title}`);
    }
  });

program.parse(process.argv);

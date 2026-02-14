import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = process.cwd();
const cliPath = path.join(repoRoot, 'dist', 'cli.js');

function run(args, cwd, env = {}) {
  const result = spawnSync('node', [cliPath, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });

  if (result.status !== 0) {
    throw new Error(
      `Command failed: node ${cliPath} ${args.join(' ')}\n` +
      `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
    );
  }

  return result.stdout;
}

function runFail(args, cwd, env = {}) {
  const result = spawnSync('node', [cliPath, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });

  assert.notEqual(result.status, 0, `Expected command to fail: ${args.join(' ')}`);
  return `${result.stdout}\n${result.stderr}`;
}

test('MVP flow: init -> task -> start -> report -> status -> next', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brothers-mvp-'));

  run(['init'], tempRoot);
  assert.ok(fs.existsSync(path.join(tempRoot, '.brothers-config.json')));
  assert.ok(fs.existsSync(path.join(tempRoot, 'coordination', 'tasks')));
  assert.ok(fs.existsSync(path.join(tempRoot, 'coordination', 'reports')));
  assert.ok(fs.existsSync(path.join(tempRoot, 'coordination', 'batons')));

  const taskOutput = run([
    'task',
    'Fix calculator id mismatch',
    '--priority',
    'high',
    '--assignee',
    'claude',
    '--details',
    'Update form id and event handler',
    '--files',
    'index.html,assets/js/calculator.js',
  ], tempRoot);
  assert.match(taskOutput, /Created TASK-001/);

  const startOutput = run(['start', 'TASK-001', '--ai', 'claude'], tempRoot);
  assert.match(startOutput, /Task TASK-001 started/);
  assert.ok(fs.existsSync(path.join(tempRoot, 'coordination', 'prompts', 'TASK-001-prompt.txt')));

  const reportOutput = run([
    'report',
    'TASK-001',
    '--done',
    'Updated calculator id;Adjusted event listeners;Added regression test',
    '--files',
    'coordination/tasks/TASK-001.md',
    '--tests',
    'PASS tests/calculator.test.js (3/3)',
    '--next',
    'Deploy to staging;Run smoke tests on prod clone',
    '--executor',
    'claude-sonnet',
  ], tempRoot);
  assert.match(reportOutput, /Report created: REPORT-001/);

  const statusOutput = run(['status'], tempRoot);
  assert.match(statusOutput, /COMPLETED: 1/);
  assert.match(statusOutput, /Reports total: 1/);

  const nextOutput = run(['next', '--create', '1'], tempRoot);
  assert.match(nextOutput, /1\. Deploy to staging/);
  assert.match(nextOutput, /Created TASK-002: Deploy to staging/);

  const task2Path = path.join(tempRoot, 'coordination', 'tasks', 'TASK-002.md');
  assert.ok(fs.existsSync(task2Path));
});

test('Relay flow: dependency requires baton + json endpoints', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brothers-relay-'));

  run(['init'], tempRoot);

  run(['task', 'Base task'], tempRoot);
  run(['start', 'TASK-001'], tempRoot);
  run([
    'report',
    'TASK-001',
    '--done',
    'Implemented base',
    '--files',
    'coordination/tasks/TASK-001.md',
    '--tests',
    'PASS',
    '--next',
    'Dependent task',
  ], tempRoot);

  run([
    'task',
    'Dependent task',
    '--depends-on',
    'TASK-001',
  ], tempRoot);

  const blockedStart = runFail(['start', 'TASK-002'], tempRoot);
  assert.match(blockedStart, /has dependencies/);
  assert.match(blockedStart, /relay-check/);

  const relayJson = run(['relay-check', 'TASK-002', '--json'], tempRoot);
  const relayData = JSON.parse(relayJson);
  assert.equal(relayData.passed, true);
  assert.equal(relayData.taskId, 'TASK-002');
  assert.equal(relayData.batonId, 'BATON-001');

  const batonInfoJson = run(['baton-info', 'BATON-001', '--json'], tempRoot);
  const batonData = JSON.parse(batonInfoJson);
  assert.equal(batonData.id, 'BATON-001');
  assert.equal(batonData.toTask, 'TASK-002');

  const startWithBaton = run(['start', 'TASK-002', '--with-baton', 'BATON-001'], tempRoot);
  assert.match(startWithBaton, /Baton verified: BATON-001/);
  assert.match(startWithBaton, /Task TASK-002 started/);
});

test('Auto mode: mock provider creates report from AI response', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brothers-auto-'));

  run(['init'], tempRoot);
  run(['task', 'Auto task'], tempRoot);

  const mockResponse = `## STATUS\nCOMPLETED\n\n## WORK DONE\n- ✅ Added endpoint\n- ✅ Added tests\n\n## FILES CHANGED\n- coordination/tasks/TASK-001.md\n- src/api.ts\n\n## TESTS\nPASS 2 tests\n\n## RESULT\nFeature done\n\n## NEXT STEPS\n- [ ] Deploy\n`;

  const autoOutput = run(
    ['start', 'TASK-001', '--ai', 'mock', '--auto', '--model', 'mock-v1'],
    tempRoot,
    { BROTHERS_MOCK_AI_RESPONSE: mockResponse },
  );

  assert.match(autoOutput, /Auto mode enabled/);
  assert.match(autoOutput, /Auto report created: REPORT-001/);

  const reportPath = path.join(tempRoot, 'coordination', 'reports', 'REPORT-001.md');
  assert.ok(fs.existsSync(reportPath));

  const reportContent = fs.readFileSync(reportPath, 'utf-8');
  assert.match(reportContent, /Added endpoint/);
  assert.match(reportContent, /PASS 2 tests/);
  assert.match(reportContent, /Deploy/);

  const taskContent = fs.readFileSync(path.join(tempRoot, 'coordination', 'tasks', 'TASK-001.md'), 'utf-8');
  assert.match(taskContent, /\*Status: COMPLETED\*/);
});

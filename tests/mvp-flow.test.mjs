import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = process.cwd();
const cliPath = path.join(repoRoot, 'dist', 'cli.js');

function run(args, cwd) {
  const result = spawnSync('node', [cliPath, ...args], {
    cwd,
    encoding: 'utf-8',
  });

  if (result.status !== 0) {
    throw new Error(
      `Command failed: node ${cliPath} ${args.join(' ')}\n` +
      `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
    );
  }

  return result.stdout;
}

test('MVP flow: init -> task -> start -> report -> status -> next', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brothers-mvp-'));

  run(['init'], tempRoot);
  assert.ok(fs.existsSync(path.join(tempRoot, '.brothers-config.json')));
  assert.ok(fs.existsSync(path.join(tempRoot, 'coordination', 'tasks')));
  assert.ok(fs.existsSync(path.join(tempRoot, 'coordination', 'reports')));

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
    'index.html,assets/js/calculator.js,tests/calculator.test.js',
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

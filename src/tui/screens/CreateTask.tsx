import React, { useState } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StatusBar } from '../components/StatusBar.js';

// dist/tui/screens/CreateTask.js → dist/tui/ → dist/
const _distDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

interface Props {
  coordDir: string;
  onDone: (output: string) => void;
  onCancel: () => void;
}

type Step = 'title' | 'priority' | 'confirm';

const PRIORITIES = ['high', 'medium', 'low'] as const;
type Priority = typeof PRIORITIES[number];

function runCli(args: string, cwd: string): string {
  const cliPath = path.join(_distDir, 'cli.js');
  try {
    return execSync(`node "${cliPath}" ${args}`, { encoding: 'utf-8', cwd, timeout: 10000 });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return (err.stdout ?? '') + (err.stderr ? `\nError: ${err.stderr}` : (err.message ?? ''));
  }
}

export function CreateTask({ coordDir, onDone, onCancel }: Props) {
  const [step, setStep] = useState<Step>('title');
  const [title, setTitle] = useState('');
  const [priorityIdx, setPriorityIdx] = useState(1); // medium
  const projectDir = path.dirname(coordDir);
  const { exit } = useApp();

  useInput((input, key) => {
    if (key.escape) { onCancel(); return; }
    if (input === 'q' && step !== 'title') { exit(); return; }

    // --- Title step: simple char-by-char input ---
    if (step === 'title') {
      if (key.return) {
        if (title.trim()) setStep('priority');
        return;
      }
      if (key.backspace || key.delete) {
        setTitle(t => t.slice(0, -1));
        return;
      }
      // Accept printable characters (space and above)
      if (input && input.length === 1 && input.charCodeAt(0) >= 32 && !key.ctrl && !key.meta) {
        setTitle(t => t + input);
      }
      return;
    }

    // --- Priority step: arrow key selection ---
    if (step === 'priority') {
      if (key.upArrow)   setPriorityIdx(i => Math.max(0, i - 1));
      if (key.downArrow) setPriorityIdx(i => Math.min(PRIORITIES.length - 1, i + 1));
      if (key.return)    setStep('confirm');
      return;
    }

    // --- Confirm step ---
    if (step === 'confirm') {
      if (input === 'y' || input === 'Y' || key.return) {
        const priority: Priority = PRIORITIES[priorityIdx]!;
        const safeTitle = title.trim().replace(/"/g, '\\"');
        const output = runCli(`task "${safeTitle}" --priority ${priority}`, projectDir);
        onDone(output);
        return;
      }
      if (input === 'n' || input === 'N') { onCancel(); return; }
    }
  });

  const priority: Priority = PRIORITIES[priorityIdx]!;

  const PRIORITY_COLOR: Record<Priority, string> = { high: 'red', medium: 'yellow', low: 'gray' };

  return (
    <Box flexDirection="column">
      <Box borderStyle="double" borderColor="cyan" paddingX={2}>
        <Text bold color="cyan">Новая задача</Text>
      </Box>

      <Box flexDirection="column" paddingX={3} paddingY={1} gap={1}>
        {/* Step 1: Title */}
        <Box gap={1}>
          <Text color={step === 'title' ? 'cyan' : 'gray'} bold={step === 'title'}>
            {'Название:    '}
          </Text>
          {step === 'title' ? (
            <Box>
              <Text>{title}</Text>
              <Text color="cyan">█</Text>
            </Box>
          ) : (
            <Text>{title}</Text>
          )}
        </Box>

        {/* Step 2: Priority */}
        {(step === 'priority' || step === 'confirm') && (
          <Box flexDirection="column">
            <Text color={step === 'priority' ? 'cyan' : 'gray'} bold={step === 'priority'}>
              Приоритет:
            </Text>
            {step === 'priority' ? (
              PRIORITIES.map((p, i) => (
                <Box key={p} paddingLeft={2}>
                  <Text color={i === priorityIdx ? 'cyan' : 'gray'} bold={i === priorityIdx}>
                    {i === priorityIdx ? '▶  ' : '   '}{p}
                  </Text>
                </Box>
              ))
            ) : (
              <Box paddingLeft={2}>
                <Text color={(PRIORITY_COLOR[priority]) as Parameters<typeof Text>[0]['color']} bold>
                  {priority}
                </Text>
              </Box>
            )}
          </Box>
        )}

        {/* Step 3: Confirm */}
        {step === 'confirm' && (
          <Box flexDirection="column" marginTop={1} gap={0}>
            <Text color="gray">{'─'.repeat(36)}</Text>
            <Text>Создать задачу?</Text>
            <Box paddingLeft={1} marginTop={0}>
              <Text dimColor>brothers task "{title.trim()}" --priority {priority}</Text>
            </Box>
            <Box gap={3} marginTop={1}>
              <Text color="green" bold>[Y/Enter] Да</Text>
              <Text color="red" bold>[N/Esc] Отмена</Text>
            </Box>
          </Box>
        )}
      </Box>

      <StatusBar hints={
        step === 'title'    ? [{ key: 'Enter', label: 'далее' }, { key: 'Esc', label: 'отмена' }] :
        step === 'priority' ? [{ key: '↑↓', label: 'выбор' }, { key: 'Enter', label: 'далее' }, { key: 'Esc', label: 'отмена' }] :
        [{ key: 'Y/Enter', label: 'создать' }, { key: 'N/Esc', label: 'отмена' }]
      } />
    </Box>
  );
}

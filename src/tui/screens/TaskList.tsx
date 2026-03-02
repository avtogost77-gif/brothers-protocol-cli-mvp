import React, { useState } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { Badge } from '../components/Badge.js';
import { StatusBar } from '../components/StatusBar.js';
import type { Task, Baton } from '../lib.js';
import { isBatonActive } from '../lib.js';

interface Props {
  tasks: Task[];
  batons: Baton[];
  project: string;
  stack: string[];
  mcp: string[];
  onDetail: (taskId: string) => void;
  onCreate: () => void;
  onRefresh: () => void;
}

export function TaskList({ tasks, batons, project, stack, mcp, onDetail, onCreate, onRefresh }: Props) {
  const [selected, setSelected] = useState(0);
  const { exit } = useApp();

  useInput((_input, key) => {
    if (key.upArrow)   setSelected(i => Math.max(0, i - 1));
    if (key.downArrow) setSelected(i => Math.min(Math.max(0, tasks.length - 1), i + 1));
    if (key.return && tasks.length > 0) onDetail(tasks[selected]!.id);
    if (_input === 'n' || _input === 'N') onCreate();
    if (_input === 'r' || _input === 'R') onRefresh();
    if (_input === 'q' || _input === 'Q') exit();
  });

  const activeBatons = batons.filter(isBatonActive);

  const statusOrder: Record<string, number> = { IN_PROGRESS: 0, CREATED: 1, BLOCKED: 2, COMPLETED: 3 };
  const sorted = [...tasks].sort((a, b) => (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9));

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box borderStyle="double" borderColor="cyan" paddingX={2} justifyContent="space-between">
        <Text bold color="cyan">Brothers Protocol</Text>
        <Text color="gray">{project}  ·  {tasks.length} задач</Text>
      </Box>

      {/* Stack + MCP info strip */}
      {(stack.length > 0 || mcp.length > 0) && (
        <Box paddingX={2} gap={2}>
          {stack.length > 0 && (
            <Text color="gray" dimColor>⬡ {stack.join(' · ')}</Text>
          )}
          {mcp.length > 0 && (
            <Text color="yellow" dimColor>MCP: {mcp.map(m =>
              m.replace('@modelcontextprotocol/server-', '')
               .replace('mcp-server-', '')
               .replace('@playwright/', '')
            ).join(', ')}</Text>
          )}
        </Box>
      )}

      {/* Task list */}
      <Box flexDirection="column" paddingY={1} paddingX={1} minHeight={10}>
        {sorted.length === 0 ? (
          <Box paddingX={2} paddingY={1}>
            <Text color="gray">Нет задач. Нажми </Text>
            <Text bold color="cyan">[N]</Text>
            <Text color="gray"> для создания первой.</Text>
          </Box>
        ) : (
          sorted.map((task, i) => {
            const isSelected = i === selected;
            const hasBaton = activeBatons.some(b => b.toTask === task.id);
            const isDone = task.status === 'COMPLETED';
            return (
              <Box key={task.id} paddingX={1}>
                <Text bold={isSelected} color={isSelected ? 'cyan' : 'gray'}>
                  {isSelected ? '▶ ' : '  '}
                </Text>
                <Badge status={task.status} />
                <Text>{'  '}</Text>
                <Text
                  bold={isSelected}
                  color={isSelected ? 'cyan' : isDone ? undefined : 'white'}
                  dimColor={isDone && !isSelected}
                >
                  {task.id}
                </Text>
                <Text>{'  '}</Text>
                <Text
                  bold={isSelected}
                  dimColor={isDone && !isSelected}
                  color={isSelected ? 'white' : undefined}
                >
                  {task.title.length > 44 ? task.title.slice(0, 41) + '...' : task.title}
                </Text>
                {hasBaton && <Text color="green">  ⚡</Text>}
              </Box>
            );
          })
        )}
      </Box>

      {activeBatons.length > 0 && (
        <Box paddingX={3}>
          <Text color="green" dimColor>⚡ = активный baton для задачи</Text>
        </Box>
      )}

      <StatusBar hints={[
        { key: '↑↓',    label: 'навигация' },
        { key: 'Enter', label: 'детали' },
        { key: 'N',     label: 'новая задача' },
        { key: 'R',     label: 'обновить' },
        { key: 'Q',     label: 'выход' },
      ]} />
    </Box>
  );
}

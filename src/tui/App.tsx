import React, { useState, useCallback } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { TaskList } from './screens/TaskList.js';
import { TaskDetail } from './screens/TaskDetail.js';
import { CreateTask } from './screens/CreateTask.js';
import { readTasks, readBatons, getProjectName } from './lib.js';
import type { Task, Baton } from './lib.js';

type Screen =
  | { type: 'list' }
  | { type: 'detail'; taskId: string }
  | { type: 'create' }
  | { type: 'output'; command: string; output: string };

interface AppData {
  tasks: Task[];
  batons: Baton[];
  project: string;
}

function load(coordDir: string): AppData {
  return {
    tasks:   readTasks(coordDir),
    batons:  readBatons(coordDir),
    project: getProjectName(coordDir),
  };
}

export function App({ coordDir }: { coordDir: string }) {
  const [data, setData]     = useState<AppData>(() => load(coordDir));
  const [screen, setScreen] = useState<Screen>({ type: 'list' });

  const refresh = useCallback(() => setData(load(coordDir)), [coordDir]);

  const goList = useCallback(() => {
    refresh();
    setScreen({ type: 'list' });
  }, [refresh]);

  if (screen.type === 'list') {
    return (
      <TaskList
        tasks={data.tasks}
        batons={data.batons}
        project={data.project}
        onDetail={id  => setScreen({ type: 'detail', taskId: id })}
        onCreate={() => setScreen({ type: 'create' })}
        onRefresh={refresh}
      />
    );
  }

  if (screen.type === 'detail') {
    const task = data.tasks.find(t => t.id === screen.taskId);
    if (!task) return <Text color="red">Задача не найдена: {screen.taskId}</Text>;
    return (
      <TaskDetail
        task={task}
        batons={data.batons}
        coordDir={coordDir}
        onBack={goList}
        onOutput={(cmd, out) => setScreen({ type: 'output', command: cmd, output: out })}
      />
    );
  }

  if (screen.type === 'create') {
    return (
      <CreateTask
        coordDir={coordDir}
        onDone={out => setScreen({ type: 'output', command: 'task create', output: out })}
        onCancel={goList}
      />
    );
  }

  if (screen.type === 'output') {
    return <OutputView command={screen.command} output={screen.output} onBack={goList} />;
  }

  return null;
}

function OutputView({
  command, output, onBack,
}: { command: string; output: string; onBack: () => void }) {
  const { exit } = useApp();
  useInput((input, key) => {
    if (key.escape || input === 'b' || input === 'B' || key.return) { onBack(); return; }
    if (input === 'q' || input === 'Q') exit();
  });
  return (
    <Box flexDirection="column">
      <Box borderStyle="double" borderColor="yellow" paddingX={2}>
        <Text color="yellow" bold>$ brothers {command}</Text>
      </Box>
      <Box paddingX={3} paddingY={1}>
        <Text>{output.trim()}</Text>
      </Box>
      <Box borderStyle="single" borderColor="gray" paddingX={2}>
        <Text bold color="cyan">[Enter/B]</Text>
        <Text color="gray"> назад   </Text>
        <Text bold color="cyan">[Q]</Text>
        <Text color="gray"> выход</Text>
      </Box>
    </Box>
  );
}

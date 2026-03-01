import React from 'react';
import { Text } from 'ink';
import type { TaskStatus } from '../lib.js';

const STATUS_ICON: Record<TaskStatus, { icon: string; color: string }> = {
  CREATED:     { icon: '○', color: 'gray' },
  IN_PROGRESS: { icon: '●', color: 'yellow' },
  COMPLETED:   { icon: '●', color: 'green' },
  BLOCKED:     { icon: '✖', color: 'red' },
};

export function Badge({ status }: { status: TaskStatus }) {
  const { icon, color } = STATUS_ICON[status] ?? STATUS_ICON.CREATED;
  return <Text color={color as Parameters<typeof Text>[0]['color']}>{icon}</Text>;
}

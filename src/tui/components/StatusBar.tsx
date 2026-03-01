import React from 'react';
import { Box, Text } from 'ink';

interface Hint {
  key: string;
  label: string;
}

interface Props {
  hints: Hint[];
}

export function StatusBar({ hints }: Props) {
  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1}>
      {hints.map((h, i) => (
        <React.Fragment key={i}>
          {i > 0 && <Text color="gray">{'   '}</Text>}
          <Text bold color="cyan">[{h.key}]</Text>
          <Text color="gray"> {h.label}</Text>
        </React.Fragment>
      ))}
    </Box>
  );
}

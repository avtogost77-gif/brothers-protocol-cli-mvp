import React from 'react';
import { render } from 'ink';
import { App } from './App.js';
import { findCoordDir } from './lib.js';

const coordDir = findCoordDir();

if (!coordDir) {
  process.stderr.write(
    'Brothers Protocol: папка coordination/ не найдена.\n' +
    'Запусти: brothers init\n',
  );
  process.exit(1);
}

render(<App coordDir={coordDir} />);

#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

const isWindows = process.platform === 'win32';
const command = isWindows ? 'powershell.exe' : 'bash';
const commandArgs = isWindows
  ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(__dirname, 'daemon.ps1'), ...args]
  : [join(__dirname, 'daemon.sh'), ...args];

const result = spawnSync(command, commandArgs, {
  stdio: 'inherit',
  windowsHide: isWindows,
});

if (result.error) {
  console.error(`Failed to run daemon manager: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 0);

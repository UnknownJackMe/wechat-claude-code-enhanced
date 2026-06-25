import { spawn, spawnSync, type ChildProcess, type SpawnOptions, type SpawnSyncOptions, type SpawnSyncReturns } from 'node:child_process';

type ClaudeCommand = {
  command: string;
  shell: boolean;
};

let cachedClaudeCommand: ClaudeCommand | null = null;

function pickWindowsClaudeCandidate(candidates: string[]): string | null {
  if (candidates.length === 0) {
    return null;
  }

  const normalized = candidates
    .map((candidate) => candidate.trim())
    .filter(Boolean);

  const preferred = normalized.find((candidate) => /\\\.local\\bin\\claude\.exe$/i.test(candidate))
    ?? normalized.find((candidate) => /(^|\\)claude\.exe$/i.test(candidate) && !/\\windowsapps\\claude\.exe$/i.test(candidate))
    ?? normalized.find((candidate) => /(^|\\)claude\.cmd$/i.test(candidate))
    ?? normalized.find((candidate) => /(^|\\)claude(\.exe)?$/i.test(candidate))
    ?? normalized[0];

  return preferred || null;
}

function resolveClaudeCommand(): ClaudeCommand {
  if (cachedClaudeCommand) {
    return cachedClaudeCommand;
  }

  if (process.platform !== 'win32') {
    cachedClaudeCommand = { command: 'claude', shell: false };
    return cachedClaudeCommand;
  }

  try {
    const result = spawnSync('where.exe', ['claude'], { encoding: 'utf8', windowsHide: true });
    const lines = `${result.stdout ?? ''}`
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const selected = pickWindowsClaudeCandidate(lines);
    if (selected) {
      cachedClaudeCommand = {
        command: selected,
        shell: selected.toLowerCase().endsWith('.cmd'),
      };
      return cachedClaudeCommand;
    }
  } catch {
    // Fall through to PATH lookup.
  }

  cachedClaudeCommand = { command: 'claude', shell: true };
  return cachedClaudeCommand;
}

export function invalidateClaudeCommandCache(): void {
  cachedClaudeCommand = null;
}

export function spawnClaude(args: string[], options: SpawnOptions = {}): ChildProcess {
  const resolved = resolveClaudeCommand();
  return spawn(resolved.command, args, {
    ...options,
    shell: options.shell ?? resolved.shell,
    windowsHide: options.windowsHide ?? process.platform === 'win32',
  });
}

export function spawnClaudeSync(
  args: string[],
  options: SpawnSyncOptions = {},
): SpawnSyncReturns<string | Buffer> {
  const resolved = resolveClaudeCommand();
  return spawnSync(resolved.command, args, {
    ...options,
    shell: options.shell ?? resolved.shell,
    windowsHide: options.windowsHide ?? process.platform === 'win32',
  });
}

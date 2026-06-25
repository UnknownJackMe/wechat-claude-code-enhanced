import { spawn, spawnSync, type ChildProcess, type SpawnOptions, type SpawnSyncOptions, type SpawnSyncReturns } from 'node:child_process';

type ClaudeCommand = {
  command: string;
  shell: boolean;
};

/**
 * Escape a single argument for cmd.exe when shell: true.
 * Wraps in double quotes and escapes internal double quotes and special chars.
 * This prevents content with dashes, backticks, parentheses, etc. from being
 * misinterpreted as CLI options or shell metacharacters.
 */
function escapeCmdArg(arg: string): string {
  // If arg is simple (no spaces, no special chars), return as-is
  if (/^[a-zA-Z0-9_./:=@-]+$/.test(arg)) return arg;
  // Escape internal double quotes and wrap in double quotes
  const escaped = arg.replace(/"/g, '\\"');
  return `"${escaped}"`;
}

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
  const useShell = options.shell ?? resolved.shell;
  const finalArgs = useShell ? args.map(escapeCmdArg) : args;
  return spawn(resolved.command, finalArgs, {
    ...options,
    shell: useShell,
    windowsHide: options.windowsHide ?? process.platform === 'win32',
  });
}

export function spawnClaudeSync(
  args: string[],
  options: SpawnSyncOptions = {},
): SpawnSyncReturns<string | Buffer> {
  const resolved = resolveClaudeCommand();
  const useShell = options.shell ?? resolved.shell;
  const finalArgs = useShell ? args.map(escapeCmdArg) : args;
  return spawnSync(resolved.command, finalArgs, {
    ...options,
    shell: useShell,
    windowsHide: options.windowsHide ?? process.platform === 'win32',
  });
}

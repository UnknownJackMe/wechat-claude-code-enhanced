import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadJson, saveJson, updateJson } from './store.js';

const QUICK_PATH = join(homedir(), '.wechat-claude-code', 'quick-commands.json');

export type QuickCommands = Record<string, string>;

function normalizeCommands(input: unknown): QuickCommands {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const entries = Object.entries(input as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return Object.fromEntries(entries);
}

export function loadQuickCommands(): QuickCommands {
  return normalizeCommands(loadJson<unknown>(QUICK_PATH, {}));
}

export function saveQuickCommands(commands: QuickCommands): void {
  saveJson(QUICK_PATH, commands);
}

/** Resolve a quick-command name to its stored prompt. Returns undefined if not found. */
export function resolveQuickCommand(name: string): string | undefined {
  return loadQuickCommands()[name.toLowerCase()];
}

export function upsertQuickCommand(name: string, prompt: string): void {
  updateJson<QuickCommands>(QUICK_PATH, {}, (current) => {
    const commands = normalizeCommands(current);
    commands[name.toLowerCase()] = prompt;
    return commands;
  });
}

export function deleteQuickCommand(name: string): boolean {
  const key = name.toLowerCase();
  let deleted = false;
  updateJson<QuickCommands>(QUICK_PATH, {}, (current) => {
    const commands = normalizeCommands(current);
    if (!(key in commands)) return commands;
    delete commands[key];
    deleted = true;
    return commands;
  });
  return deleted;
}

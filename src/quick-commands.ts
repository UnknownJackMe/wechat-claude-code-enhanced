import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadJson, saveJson } from './store.js';

const QUICK_PATH = join(homedir(), '.wechat-claude-code', 'quick-commands.json');

export type QuickCommands = Record<string, string>;

export function loadQuickCommands(): QuickCommands {
  return loadJson<QuickCommands>(QUICK_PATH, {});
}

export function saveQuickCommands(commands: QuickCommands): void {
  saveJson(QUICK_PATH, commands);
}

/** Resolve a quick-command name to its stored prompt. Returns undefined if not found. */
export function resolveQuickCommand(name: string): string | undefined {
  return loadQuickCommands()[name.toLowerCase()];
}

export function upsertQuickCommand(name: string, prompt: string): void {
  const commands = loadQuickCommands();
  commands[name.toLowerCase()] = prompt;
  saveQuickCommands(commands);
}

export function deleteQuickCommand(name: string): boolean {
  const commands = loadQuickCommands();
  const key = name.toLowerCase();
  if (!(key in commands)) return false;
  delete commands[key];
  saveQuickCommands(commands);
  return true;
}

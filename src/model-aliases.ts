import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadJson, saveJson, updateJson } from './store.js';

const ALIASES_PATH = join(homedir(), '.wechat-claude-code', 'model-aliases.json');

export type ModelAliases = Record<string, string>;

function normalizeAliases(input: unknown): ModelAliases {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const entries = Object.entries(input as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return Object.fromEntries(entries);
}

export function loadModelAliases(): ModelAliases {
  return normalizeAliases(loadJson<unknown>(ALIASES_PATH, {}));
}

export function saveModelAliases(aliases: ModelAliases): void {
  saveJson(ALIASES_PATH, aliases);
}

/** Resolve an alias to its full model ID. Returns the input unchanged if no alias found. */
export function resolveModel(nameOrAlias: string): string {
  const aliases = loadModelAliases();
  return aliases[nameOrAlias.toLowerCase()] ?? nameOrAlias;
}

export function upsertAlias(alias: string, modelId: string): void {
  updateJson<ModelAliases>(ALIASES_PATH, {}, (current) => {
    const aliases = normalizeAliases(current);
    aliases[alias.toLowerCase()] = modelId;
    return aliases;
  });
}

export function deleteAlias(alias: string): boolean {
  const key = alias.toLowerCase();
  let deleted = false;
  updateJson<ModelAliases>(ALIASES_PATH, {}, (current) => {
    const aliases = normalizeAliases(current);
    if (!(key in aliases)) return aliases;
    delete aliases[key];
    deleted = true;
    return aliases;
  });
  return deleted;
}

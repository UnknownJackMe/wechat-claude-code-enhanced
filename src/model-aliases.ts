import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadJson, saveJson } from './store.js';

const ALIASES_PATH = join(homedir(), '.wechat-claude-code', 'model-aliases.json');

export type ModelAliases = Record<string, string>;

export function loadModelAliases(): ModelAliases {
  return loadJson<ModelAliases>(ALIASES_PATH, {});
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
  const aliases = loadModelAliases();
  aliases[alias.toLowerCase()] = modelId;
  saveModelAliases(aliases);
}

export function deleteAlias(alias: string): boolean {
  const aliases = loadModelAliases();
  const key = alias.toLowerCase();
  if (!(key in aliases)) return false;
  delete aliases[key];
  saveModelAliases(aliases);
  return true;
}

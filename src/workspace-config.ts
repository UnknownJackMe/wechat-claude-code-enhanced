import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadJson, saveJson } from './store.js';

const CONFIG_PATH = join(homedir(), '.wechat-claude-code', 'workspace-configs.json');

export interface WorkspaceConfig {
  id: number;
  name: string;
  cwd: string;
  model?: string;
  effort?: string;
  advisor?: string;
  sdkSessionId?: string;
}

export function loadWorkspaceConfigs(): WorkspaceConfig[] {
  return loadJson<WorkspaceConfig[]>(CONFIG_PATH, []);
}

export function saveWorkspaceConfigs(configs: WorkspaceConfig[]): void {
  saveJson(CONFIG_PATH, configs);
}

export function getWorkspaceConfig(id: number): WorkspaceConfig | undefined {
  return loadWorkspaceConfigs().find(c => c.id === id);
}

export function upsertWorkspaceConfig(config: WorkspaceConfig): void {
  const configs = loadWorkspaceConfigs();
  const idx = configs.findIndex(c => c.id === config.id);
  if (idx >= 0) {
    configs[idx] = config;
  } else {
    configs.push(config);
    configs.sort((a, b) => a.id - b.id);
  }
  saveWorkspaceConfigs(configs);
}

export function deleteWorkspaceConfig(id: number): boolean {
  const configs = loadWorkspaceConfigs();
  const idx = configs.findIndex(c => c.id === id);
  if (idx < 0) return false;
  configs.splice(idx, 1);
  saveWorkspaceConfigs(configs);
  return true;
}

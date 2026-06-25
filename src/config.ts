import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { DEFAULT_WORKING_DIR } from "./constants.js";
import { saveJson } from "./store.js";
import { logger } from "./logger.js";

export interface Config {
  workingDirectory: string;
  model?: string;
  systemPrompt?: string;
}

const CONFIG_DIR = join(homedir(), ".wechat-claude-code");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

const DEFAULT_CONFIG: Config = {
  workingDirectory: DEFAULT_WORKING_DIR,
};

export function loadConfig(): Config {
  try {
    const content = readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(content);
    const config: Config = {
      workingDirectory: parsed.workingDirectory || DEFAULT_CONFIG.workingDirectory,
      model: parsed.model,
      systemPrompt: parsed.systemPrompt,
    };
    mkdirSync(config.workingDirectory, { recursive: true });
    return config;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn('loadConfig failed, using defaults', { error: err instanceof Error ? err.message : String(err) });
    }
    const config = { ...DEFAULT_CONFIG };
    try {
      mkdirSync(config.workingDirectory, { recursive: true });
    } catch {
      // Working directory may be invalid; proceed with the default path in memory.
    }
    return config;
  }
}

export function saveConfig(config: Config): void {
  const data: Record<string, string> = {
    workingDirectory: config.workingDirectory,
  };
  if (config.model) data.model = config.model;
  if (config.systemPrompt) data.systemPrompt = config.systemPrompt;
  saveJson(CONFIG_PATH, data);
}

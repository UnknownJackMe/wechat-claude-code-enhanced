import { readFileSync, writeFileSync, chmodSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "./logger.js";

const READ_RETRY_DELAYS_MS = [5, 15];

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function validateAccountId(accountId: string): void {
  if (!/^[a-zA-Z0-9_.@=-]+$/.test(accountId)) {
    throw new Error(`Invalid accountId: "${accountId}"`);
  }
}

/**
 * Load a JSON file, returning a typed object or the fallback if the file
 * does not exist or cannot be parsed.
 */
export function loadJson<T>(filePath: string, fallback: T): T {
  for (let attempt = 0; attempt <= READ_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const raw = readFileSync(filePath, "utf-8");
      try {
        return JSON.parse(raw) as T;
      } catch (err) {
        if (err instanceof SyntaxError) {
          // Fall back instead of crashing when a JSON file was truncated or corrupted.
          logger.warn('loadJson found invalid JSON, using fallback', { filePath, error: err.message });
          return fallback;
        }
        throw err;
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        if (attempt < READ_RETRY_DELAYS_MS.length) {
          // Retry briefly so readers tolerate the narrow window before an atomic rename lands.
          sleepSync(READ_RETRY_DELAYS_MS[attempt]);
          continue;
        }
        return fallback;
      }
      logger.warn('loadJson failed', { filePath, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }
  return fallback;
}

/**
 * Persist an object as pretty-printed JSON.
 * File is written with mode 0o600 (owner read/write only).
 */
export function saveJson(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const raw = JSON.stringify(data, null, 2) + "\n";
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;

  try {
    // Write to a sibling temp file first so concurrent writers never expose partial JSON.
    writeFileSync(tempPath, raw, { encoding: "utf-8", mode: 0o600 });
    renameSync(tempPath, filePath);
    if (process.platform !== 'win32') {
      chmodSync(filePath, 0o600);
    }
  } catch (err) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Ignore cleanup failures for temp files that were never created or already renamed.
    }
    throw err;
  }
}

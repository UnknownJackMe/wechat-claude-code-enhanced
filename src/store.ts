import { readFileSync, writeFileSync, chmodSync, mkdirSync, renameSync, unlinkSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "./logger.js";

const READ_RETRY_DELAYS_MS = [5, 15];
const LOCK_RETRY_DELAY_MS = 25;
const LOCK_TIMEOUT_MS = 2_000;
const STALE_LOCK_MS = 30_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function validateAccountId(accountId: string): void {
  if (!/^[a-zA-Z0-9_.@=-]+$/.test(accountId)) {
    throw new Error(`Invalid accountId: "${accountId}"`);
  }
}

function acquireLock(lockPath: string): () => void {
  const start = Date.now();
  while (true) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      return () => {
        try {
          rmSync(lockPath, { recursive: true, force: true });
        } catch {
          // Ignore lock cleanup failures; later calls can remove stale locks.
        }
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;

      try {
        const st = statSync(lockPath);
        if (Date.now() - st.mtimeMs > STALE_LOCK_MS) {
          rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }

      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for JSON lock: ${lockPath}`);
      }
      sleepSync(LOCK_RETRY_DELAY_MS);
    }
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
    try {
      renameSync(tempPath, filePath);
    } catch (renameErr) {
      // On Windows, renameSync over an existing file can throw EEXIST.
      // Fallback: remove the target first, then retry the rename.
      if ((renameErr as NodeJS.ErrnoException).code === 'EEXIST' || (renameErr as NodeJS.ErrnoException).code === 'EPERM') {
        try { unlinkSync(filePath); } catch { /* target may have been removed concurrently */ }
        renameSync(tempPath, filePath);
      } else {
        throw renameErr;
      }
    }
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

/** Atomically load, transform, and save JSON while holding a per-file lock. */
export function updateJson<T>(filePath: string, fallback: T, updater: (current: T) => T): T {
  mkdirSync(dirname(filePath), { recursive: true });
  const release = acquireLock(`${filePath}.lock`);
  try {
    const updated = updater(loadJson<T>(filePath, fallback));
    saveJson(filePath, updated);
    return updated;
  } finally {
    release();
  }
}

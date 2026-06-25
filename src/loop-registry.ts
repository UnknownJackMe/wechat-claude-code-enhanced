import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadJson, updateJson } from './store.js';

const LOOPS_PATH = join(homedir(), '.wechat-claude-code', 'loops.json');
const MAX_LOOPS = 20;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
export const MIN_LOOP_INTERVAL_MS = 60_000;
export const MAX_LOOP_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;

export interface LoopEntry {
  id: string;
  accountId: string;
  prompt: string;
  intervalMs: number;
  cwd: string;
  model?: string;
  effort?: string;
  sdkSessionId?: string;
  createdAt: number;
  nextFireAt: number;
}

// ---------------------------------------------------------------------------
// Interval parsing
// ---------------------------------------------------------------------------

export function parseInterval(token: string): number | null {
  const m = token.trim().match(/^(-?\d+(?:\.\d+)?)\s*(s|m|h|d)$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;

  let intervalMs: number;
  switch (m[2].toLowerCase()) {
    case 's':
      intervalMs = Math.round(n * 1_000);
      break;
    case 'm':
      intervalMs = Math.round(n * 60_000);
      break;
    case 'h':
      intervalMs = Math.round(n * 3_600_000);
      break;
    case 'd':
      intervalMs = Math.round(n * 86_400_000);
      break;
    default:
      return null;
  }
  if (intervalMs > MAX_LOOP_INTERVAL_MS) return null;
  // Keep the existing 1 minute floor so very short loops cannot hammer the process.
  return Math.max(MIN_LOOP_INTERVAL_MS, intervalMs);
}

export function formatInterval(ms: number): string {
  if (ms >= 86_400_000 && ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 60_000)}m`;
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

function genId(existing: LoopEntry[]): string {
  const ids = new Set(existing.map(l => l.id));
  let id: string;
  do {
    id = Math.random().toString(36).slice(2, 10);
  } while (ids.has(id));
  return id;
}

// ---------------------------------------------------------------------------
// Persistence — all mutations use updateJson for atomic read-modify-write
// ---------------------------------------------------------------------------

function pruneExpired(loops: LoopEntry[]): LoopEntry[] {
  const now = Date.now();
  return loops.filter(l => now - l.createdAt < SEVEN_DAYS_MS);
}

export function loadLoops(): LoopEntry[] {
  const all = loadJson<LoopEntry[]>(LOOPS_PATH, []);
  const pruned = pruneExpired(all);
  // NOTE: we don't persist pruning on bare reads to avoid lock overhead.
  // Expired entries are cleaned on the next mutation.
  return pruned;
}

export function addLoop(entry: Omit<LoopEntry, 'id' | 'createdAt' | 'nextFireAt'>): LoopEntry {
  let created: LoopEntry | undefined;
  updateJson<LoopEntry[]>(LOOPS_PATH, [], (loops) => {
    const pruned = pruneExpired(loops);
    if (pruned.length >= MAX_LOOPS) {
      throw new Error(`已达最大 loop 数量 (${MAX_LOOPS})，请先停止部分 loop`);
    }
    const now = Date.now();
    created = {
      ...entry,
      id: genId(pruned),
      createdAt: now,
      nextFireAt: now + entry.intervalMs,
    };
    return [...pruned, created];
  });
  return created!;
}

export function removeLoop(id: string): boolean {
  let found = false;
  updateJson<LoopEntry[]>(LOOPS_PATH, [], (loops) => {
    const idx = loops.findIndex(l => l.id === id);
    if (idx < 0) return loops;
    found = true;
    const copy = [...loops];
    copy.splice(idx, 1);
    return copy;
  });
  return found;
}

export function removeAllLoops(accountId: string): number {
  let removed = 0;
  updateJson<LoopEntry[]>(LOOPS_PATH, [], (loops) => {
    const kept = loops.filter(l => l.accountId !== accountId);
    removed = loops.length - kept.length;
    return kept;
  });
  return removed;
}

export function updateNextFire(id: string, nextFireAt: number): void {
  updateJson<LoopEntry[]>(LOOPS_PATH, [], (loops) => {
    const loop = loops.find(l => l.id === id);
    if (loop) loop.nextFireAt = nextFireAt;
    return loops;
  });
}

export function getLoopsForAccount(accountId: string): LoopEntry[] {
  return loadLoops().filter(l => l.accountId === accountId);
}

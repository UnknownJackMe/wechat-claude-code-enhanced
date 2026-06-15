import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadJson, saveJson } from './store.js';

const LOOPS_PATH = join(homedir(), '.wechat-claude-code', 'loops.json');
const MAX_LOOPS = 20;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

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
  const m = token.trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  switch (m[2].toLowerCase()) {
    case 's': return Math.max(60_000, Math.round(n * 1_000));      // min 1 min
    case 'm': return Math.round(n * 60_000);
    case 'h': return Math.round(n * 3_600_000);
    case 'd': return Math.round(n * 86_400_000);
  }
  return null;
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

function genId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function loadLoops(): LoopEntry[] {
  const now = Date.now();
  const all = loadJson<LoopEntry[]>(LOOPS_PATH, []);
  return all.filter(l => now - l.createdAt < SEVEN_DAYS_MS);
}

export function saveLoops(loops: LoopEntry[]): void {
  saveJson(LOOPS_PATH, loops);
}

export function addLoop(entry: Omit<LoopEntry, 'id' | 'createdAt' | 'nextFireAt'>): LoopEntry {
  const loops = loadLoops();
  if (loops.length >= MAX_LOOPS) {
    throw new Error(`已达最大 loop 数量 (${MAX_LOOPS})，请先停止部分 loop`);
  }
  const now = Date.now();
  const loop: LoopEntry = {
    ...entry,
    id: genId(),
    createdAt: now,
    nextFireAt: now + entry.intervalMs,
  };
  loops.push(loop);
  saveLoops(loops);
  return loop;
}

export function removeLoop(id: string): boolean {
  const loops = loadLoops();
  const idx = loops.findIndex(l => l.id === id);
  if (idx < 0) return false;
  loops.splice(idx, 1);
  saveLoops(loops);
  return true;
}

export function removeAllLoops(accountId: string): number {
  const loops = loadLoops();
  const kept = loops.filter(l => l.accountId !== accountId);
  const removed = loops.length - kept.length;
  saveLoops(kept);
  return removed;
}

export function updateNextFire(id: string, nextFireAt: number): void {
  const loops = loadLoops();
  const loop = loops.find(l => l.id === id);
  if (loop) {
    loop.nextFireAt = nextFireAt;
    saveLoops(loops);
  }
}

export function getLoopsForAccount(accountId: string): LoopEntry[] {
  return loadLoops().filter(l => l.accountId === accountId);
}

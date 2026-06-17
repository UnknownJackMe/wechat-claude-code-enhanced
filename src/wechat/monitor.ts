import { WeChatApi } from './api.js';
import { loadSyncBuf, saveSyncBuf } from './sync-buf.js';
import { logger } from '../logger.js';
import { createSessionStore } from '../session.js';
import type { WeixinMessage } from './types.js';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../constants.js';

const SESSION_EXPIRED_ERRCODE = -14;
const SESSION_EXPIRED_PAUSE_MS = 60 * 60 * 1000; // 1 hour
const BACKOFF_BASE_MS = 3_000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;
const MAX_CONSECUTIVE_FAILURES = 20;
const MESSAGE_PROCESSING_TIMEOUT_MS = 30_000;
const SESSIONS_DIR = join(DATA_DIR, 'sessions');

export interface MonitorCallbacks {
  onMessage: (msg: WeixinMessage) => Promise<void>;
  onSessionExpired: () => void;
}

export function createMonitor(api: WeChatApi, callbacks: MonitorCallbacks) {
  const controller = new AbortController();
  let stopped = false;
  const recentMsgIds = new Set<number>();
  const MAX_MSG_IDS = 1000;
  const sessionStore = createSessionStore();

  async function run(): Promise<void> {
    let consecutiveFailures = 0;

    while (!controller.signal.aborted) {
      try {
        const buf = loadSyncBuf();
        logger.debug('Polling for messages', { hasBuf: buf.length > 0 });

        const resp = await api.getUpdates(buf || undefined);

        if (resp.ret === SESSION_EXPIRED_ERRCODE) {
          logger.warn('Session expired, pausing for 1 hour');
          callbacks.onSessionExpired();
          await sleep(SESSION_EXPIRED_PAUSE_MS, controller.signal);
          consecutiveFailures = 0;
          continue;
        }

        if (resp.ret !== undefined && resp.ret !== 0) {
          consecutiveFailures++;
          logger.warn('getUpdates returned error', { ret: resp.ret, retmsg: resp.retmsg, consecutiveFailures });
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            logger.error('Monitor stopping after repeated getUpdates errors', {
              ret: resp.ret,
              consecutiveFailures,
              maxConsecutiveFailures: MAX_CONSECUTIVE_FAILURES,
            });
            stop();
            break;
          }
          const backoff = getBackoffMs(consecutiveFailures);
          logger.info(`Backing off ${backoff}ms`, { consecutiveFailures, reason: 'getUpdates ret != 0' });
          await sleep(backoff, controller.signal);
          continue;
        }

        // Save the new sync buffer regardless of ret
        if (resp.get_updates_buf) {
          saveSyncBuf(resp.get_updates_buf);
        }

        // Process messages (with deduplication)
        const messages = resp.msgs ?? [];
        if (messages.length > 0) {
          logger.info('Received messages', { count: messages.length });
          for (const msg of messages) {
            // Skip already-processed messages
            if (msg.message_id && recentMsgIds.has(msg.message_id)) {
              continue;
            }
            if (msg.message_id) {
              recentMsgIds.add(msg.message_id);
              if (recentMsgIds.size > MAX_MSG_IDS) {
                // Evict oldest half (Set iterates in insertion order)
                const iter = recentMsgIds.values();
                const toDelete: number[] = [];
                for (let i = 0; i < MAX_MSG_IDS / 2; i++) {
                  const { value } = iter.next();
                  if (value !== undefined) toDelete.push(value);
                }
                for (const id of toDelete) recentMsgIds.delete(id);
              }
            }
            // Fire-and-forget: don't block the polling loop on message processing
            // This allows permission responses (y/n) to be received while a query is running
            void withTimeout(
              callbacks.onMessage(msg),
              MESSAGE_PROCESSING_TIMEOUT_MS,
              `onMessage timed out after ${MESSAGE_PROCESSING_TIMEOUT_MS}ms`,
            ).catch((err) => {
              const msg2 = err instanceof Error ? err.message : String(err);
              const resetCount = resetProcessingSessions(sessionStore, `message handler failure for ${msg.message_id ?? 'unknown'}`);
              logger.error('Error processing message', {
                error: msg2,
                messageId: msg.message_id,
                resetSessions: resetCount,
              });
            });
          }
        }

        consecutiveFailures = 0;
      } catch (err) {
        if (controller.signal.aborted) {
          break;
        }

        consecutiveFailures++;
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error('Monitor error', { error: errorMsg, consecutiveFailures });

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          logger.error('Monitor stopping after repeated failures', {
            consecutiveFailures,
            maxConsecutiveFailures: MAX_CONSECUTIVE_FAILURES,
          });
          stop();
          break;
        }

        const backoff = getBackoffMs(consecutiveFailures);
        logger.info(`Backing off ${backoff}ms`, { consecutiveFailures });
        await sleep(backoff, controller.signal);
      }
    }

    stopped = true;
    logger.info('Monitor stopped');
  }

  function stop(): void {
    if (!controller.signal.aborted) {
      logger.info('Stopping monitor...');
      controller.abort();
    }
  }

  return { run, stop };
}

function getBackoffMs(consecutiveFailures: number): number {
  return Math.min(BACKOFF_BASE_MS * (2 ** Math.max(0, consecutiveFailures - 1)), BACKOFF_MAX_MS);
}

function resetProcessingSessions(
  sessionStore: ReturnType<typeof createSessionStore>,
  reason: string,
): number {
  if (!existsSync(SESSIONS_DIR)) {
    return 0;
  }

  let resetCount = 0;
  for (const entry of readdirSync(SESSIONS_DIR)) {
    if (!entry.endsWith('.json')) {
      continue;
    }
    const accountId = entry.slice(0, -'.json'.length);
    try {
      const session = sessionStore.load(accountId);
      if (session.state !== 'processing') {
        continue;
      }
      session.state = 'idle';
      sessionStore.save(accountId, session);
      resetCount++;
    } catch (err) {
      logger.warn('Failed to reset stuck session state', {
        accountId,
        reason,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (resetCount > 0) {
    logger.warn('Reset processing sessions after monitor fallback', { reason, resetCount });
  }

  return resetCount;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
    }),
  ]);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }

    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

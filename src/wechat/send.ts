import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { isImageFile } from './upload.js';
import { WeChatApi } from './api.js';
import { MessageItemType, MessageType, MessageState, TypingStatus, type MessageItem, type OutboundMessage } from './types.js';
import { uploadFile } from './upload.js';
import { logger } from '../logger.js';

const TYPING_KEEPALIVE_MS = 5_000;
const TYPING_REQUEST_TIMEOUT_MS = 12_000;
const TYPING_CANCEL_TIMEOUT_MS = 3_000;

export function createSender(api: WeChatApi, botAccountId: string) {
  let clientCounter = 0;
  const typingTicketCache = new Map<string, { ticket: string; fetchedAt: number }>();
  const TICKET_TTL = 24 * 60 * 60 * 1000;

  function generateClientId(): string {
    return `wcc-${Date.now()}-${++clientCounter}`;
  }

  async function getTypingTicket(userId: string, contextToken?: string, signal?: AbortSignal): Promise<string> {
    const cached = typingTicketCache.get(userId);
    if (cached && Date.now() - cached.fetchedAt < TICKET_TTL) {
      return cached.ticket;
    }
    try {
      const resp = await api.getConfig(userId, contextToken, signal);
      if (resp.ret === 0 && resp.typing_ticket) {
        typingTicketCache.set(userId, { ticket: resp.typing_ticket, fetchedAt: Date.now() });
        return resp.typing_ticket;
      }
      logger.warn('getConfig returned no typing_ticket', { ret: resp.ret });
    } catch (err) {
      logger.warn('getConfig failed', { err: err instanceof Error ? err.message : String(err) });
    }
    return '';
  }

  /**
   * Start typing indicator with keepalive. Returns a stop function.
   * Fire-and-forget: errors are logged but not thrown.
   */
  function startTyping(toUserId: string, contextToken: string): () => void {
    let cancelled = false;
    const controller = new AbortController();

    void (async () => {
      let ticket = '';
      let typingStarted = false;
      try {
        ticket = await withAbortableTimeout(
          getTypingTicket(toUserId, contextToken, controller.signal),
          controller.signal,
          TYPING_REQUEST_TIMEOUT_MS,
          'getTypingTicket',
        );
        if (!ticket || cancelled) return;

        await withAbortableTimeout(api.sendTyping({
          ilink_user_id: toUserId,
          typing_ticket: ticket,
          status: TypingStatus.TYPING,
        }, controller.signal), controller.signal, TYPING_REQUEST_TIMEOUT_MS, 'sendTyping start');
        typingStarted = true;
      } catch (err) {
        if (isAbortLikeError(err)) {
          return;
        }
        logger.debug('sendTyping start failed', { err: err instanceof Error ? err.message : String(err) });
        return;
      }

      // Keepalive loop
      while (!controller.signal.aborted) {
        await sleepWithSignal(TYPING_KEEPALIVE_MS, controller.signal);
        if (controller.signal.aborted) break;
        try {
          await withAbortableTimeout(api.sendTyping({
            ilink_user_id: toUserId,
            typing_ticket: ticket,
            status: TypingStatus.TYPING,
          }, controller.signal), controller.signal, TYPING_REQUEST_TIMEOUT_MS, 'sendTyping keepalive');
        } catch (err) {
          if (isAbortLikeError(err)) {
            break;
          }
          break;
        }
      }

      // Send CANCEL to tell WeChat we're done typing
      if (!ticket || !typingStarted || !cancelled) return;
      try {
        await withTimeout(api.sendTyping({
          ilink_user_id: toUserId,
          typing_ticket: ticket,
          status: TypingStatus.CANCEL,
        }), TYPING_CANCEL_TIMEOUT_MS, 'sendTyping cancel');
      } catch {
        // ignore
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }

  async function sendText(toUserId: string, contextToken: string, text: string): Promise<void> {
    const clientId = generateClientId();

    const items: MessageItem[] = [
      {
        type: MessageItemType.TEXT,
        text_item: { text },
      },
    ];

    const msg: OutboundMessage = {
      from_user_id: botAccountId,
      to_user_id: toUserId,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      context_token: contextToken,
      item_list: items,
    };

    logger.info('Sending text message', { toUserId, clientId, textLength: text.length });
    await api.sendMessage({ msg });
    logger.info('Text message sent', { toUserId, clientId });
  }

  async function sendFile(toUserId: string, contextToken: string, filePath: string): Promise<void> {
    const resolved = resolve(filePath.replace(/^~/, process.env.HOME || ''));
    if (!existsSync(resolved)) {
      await sendText(toUserId, contextToken, `文件不存在: ${resolved}`);
      return;
    }

    try {
      const media = await uploadFile(api, toUserId, resolved);
      const clientId = generateClientId();

      // Convert aesKeyHex to base64: treat hex string as UTF-8, then base64 encode
      // (matches OpenClaw's format: Buffer.from(hexString).toString("base64"))
      const aesKeyBase64 = Buffer.from(media.aesKeyHex).toString('base64');

      let item: MessageItem;
      if (media.mediaType === 'image') {
        item = {
          type: MessageItemType.IMAGE,
          image_item: {
            media: {
              encrypt_query_param: media.encryptQueryParam,
              aes_key: aesKeyBase64,
              encrypt_type: 1,
            },
            mid_size: media.fileSize,
          },
        };
      } else {
        item = {
          type: MessageItemType.FILE,
          file_item: {
            media: {
              encrypt_query_param: media.encryptQueryParam,
              aes_key: aesKeyBase64,
              encrypt_type: 1,
            },
            file_name: media.fileName,
            len: String(media.rawSize),
          },
        };
      }

      const msg: OutboundMessage = {
        from_user_id: botAccountId,
        to_user_id: toUserId,
        client_id: clientId,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        context_token: contextToken,
        item_list: [item],
      };

      logger.info('Sending file message', { toUserId, clientId, fileName: media.fileName, mediaType: media.mediaType });
      await api.sendMessage({ msg }, { maxRetries: 1 });
      logger.info('File message sent', { toUserId, clientId, fileName: media.fileName });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Failed to send file', { filePath: resolved, error: msg });
      if (!msg.includes('rate-limited')) {
        await sendText(toUserId, contextToken, `发送文件失败: ${msg}`);
      }
      throw err;
    }
  }

  /**
   * Send multiple files with rate-limit retry logic.
   * Returns { sent, failed } counts.
   */
  async function sendFiles(
    toUserId: string,
    contextToken: string,
    filePaths: string[],
  ): Promise<{ sent: number; failed: string[] }> {
    const failed: string[] = [];
    let sent = 0;

    for (const filePath of filePaths) {
      try {
        await sendFile(toUserId, contextToken, filePath);
        sent++;
        // Small gap between files to avoid rate limits
        if (filePaths.length > 1) await new Promise(r => setTimeout(r, 500));
      } catch (err) {
        // sendFile already does one capped backoff internally; if it still
        // failed, give up fast rather than stalling the channel for minutes.
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn('sendFile gave up', { filePath, error: msg });
        failed.push(filePath);
      }
    }

    return { sent, failed };
  }

  return { sendText, startTyping, sendFile, sendFiles };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SENDABLE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico',
  '.pdf', '.doc', '.docx', '.ppt', '.pptx', '.rtf',
  '.txt', '.md', '.csv', '.xlsx', '.xls',
  '.mp3', '.wav', '.m4a', '.mp4', '.mov',
  '.zip', '.tar', '.gz', '.json', '.ts', '.js', '.py',
]);

/** Expand a list of paths: directories are scanned (non-recursive), files are kept as-is. */
export function expandPaths(paths: string[]): string[] {
  const result: string[] = [];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const entry of readdirSync(p)) {
        const full = `${p}/${entry}`;
        try {
          const est = statSync(full);
          if (est.isFile() && SENDABLE_EXTENSIONS.has(extname(entry).toLowerCase())) {
            result.push(full);
          }
        } catch { /* skip */ }
      }
    } else if (st.isFile()) {
      result.push(p);
    }
  }
  return result;
}

function isAbortLikeError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') {
    return true;
  }
  return err instanceof Error && (err.message === 'aborted' || err.message.includes('timed out'));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

function withAbortableTimeout<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return Promise.race([
    promise,
    waitForAbort(signal),
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
}

function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

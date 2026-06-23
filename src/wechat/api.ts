import type {
  GetUpdatesResp,
  SendMessageReq,
  GetUploadUrlResp,
  SendTypingReq,
  GetConfigResp,
} from './types.js';
import { logger } from '../logger.js';

/** Generate a random base64 identifier. */
function generateUin(): string {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  return Buffer.from(buf).toString('base64');
}

export class WeChatApi {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly uin: string;
  private readonly nextSendTime = new Map<string, number>();
  private static readonly MIN_SEND_INTERVAL = 4000;
  private static readonly MAX_SEND_SLOT_WAIT = 60_000;
  private static readonly RETRY_BACKOFFS_MS = [3_000, 6_000, 12_000, 24_000, 30_000, 30_000];

  constructor(token: string, baseUrl: string = 'https://ilinkai.weixin.qq.com') {
    if (baseUrl) {
      try {
        const url = new URL(baseUrl);
        const allowedHosts = ['weixin.qq.com', 'wechat.com'];
        const isAllowed = allowedHosts.some(h => url.hostname === h || url.hostname.endsWith('.' + h));
        if (url.protocol !== 'https:' || !isAllowed) {
          logger.warn('Untrusted baseUrl, using default', { baseUrl });
          baseUrl = 'https://ilinkai.weixin.qq.com';
        }
      } catch {
        logger.warn('Invalid baseUrl, using default', { baseUrl });
        baseUrl = 'https://ilinkai.weixin.qq.com';
      }
    }
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.uin = generateUin();
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.token}`,
      'AuthorizationType': 'ilink_bot_token',
      'X-WECHAT-UIN': this.uin,
    };
  }

  private async request<T = Record<string, unknown>>(
    path: string,
    body: unknown,
    timeoutMs: number = 15_000,
    externalSignal?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const abortFromCaller = () => controller.abort();
    externalSignal?.addEventListener('abort', abortFromCaller, { once: true });

    const url = `${this.baseUrl}/${path}`;

    logger.debug('API request', { url, body });

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
      }

      const json = (await res.json()) as T;
      logger.debug('API response', json);
      return json;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        if (externalSignal?.aborted) {
          throw err;
        }
        throw new Error(`Request to ${url} timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', abortFromCaller);
    }
  }

  private async waitForSendSlot(userId?: string): Promise<void> {
    if (!userId) return;

    const now = Date.now();
    let nextAvailable = this.nextSendTime.get(userId) ?? now;
    if (nextAvailable - now > WeChatApi.MAX_SEND_SLOT_WAIT) {
      logger.warn('Rate limiter slot too far in the future, resetting', {
        userId,
        waitMs: nextAvailable - now,
      });
      nextAvailable = now;
    }

    const sendAt = Math.max(now, nextAvailable);
    this.nextSendTime.set(userId, sendAt + WeChatApi.MIN_SEND_INTERVAL);
    const waitMs = sendAt - now;
    if (waitMs > 0) {
      logger.debug('Rate limiter waiting', { userId, waitMs });
      await new Promise(r => setTimeout(r, waitMs));
    }
  }

  /** Long-poll for new messages. Timeout 35s for long-polling. */
  async getUpdates(buf?: string): Promise<GetUpdatesResp> {
    return this.request<GetUpdatesResp>(
      'ilink/bot/getupdates',
      buf ? { get_updates_buf: buf } : {},
      35_000,
    );
  }

  /** Send a message to a user. Per-user rate limited, retries on rate-limit (ret: -2). */
  async sendMessage(req: SendMessageReq): Promise<void> {
    const userId = req.msg?.to_user_id;

    // Retry generously but finitely: one initial send plus six capped backoffs.
    for (let attempt = 0; attempt <= WeChatApi.RETRY_BACKOFFS_MS.length; attempt++) {
      await this.waitForSendSlot(userId);
      const res = await this.request<{ ret?: number }>('ilink/bot/sendmessage', req);
      if (res.ret === -2) {
        const delay = WeChatApi.RETRY_BACKOFFS_MS[attempt];
        if (delay === undefined) {
          logger.warn('sendMessage rate-limited after max retries', { retries: WeChatApi.RETRY_BACKOFFS_MS.length });
          throw new Error(`sendMessage rate-limited after ${WeChatApi.RETRY_BACKOFFS_MS.length} retries`);
        }
        logger.warn('sendMessage rate-limited (ret:-2), retrying', { attempt, delayMs: delay });
        if (userId) {
          this.nextSendTime.set(userId, Date.now() + delay + WeChatApi.MIN_SEND_INTERVAL);
        }
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      return;
    }
  }

  /** Fetch bot config (includes typing_ticket). */
  async getConfig(ilinkUserId: string, contextToken?: string, signal?: AbortSignal): Promise<GetConfigResp> {
    return this.request<GetConfigResp>(
      'ilink/bot/getconfig',
      { ilink_user_id: ilinkUserId, context_token: contextToken },
      10_000,
      signal,
    );
  }

  /** Send a typing indicator to a user. */
  async sendTyping(req: SendTypingReq, signal?: AbortSignal): Promise<void> {
    await this.request('ilink/bot/sendtyping', req, 10_000, signal);
  }

  /** Get a presigned upload URL for media files. */
  async getUploadUrl(req: import('./types.js').GetUploadUrlReq): Promise<GetUploadUrlResp> {
    return this.request<GetUploadUrlResp>('ilink/bot/getuploadurl', req);
  }
}

#!/usr/bin/env node
import { createInterface } from 'node:readline';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { join, basename } from 'node:path';
import { unlinkSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';

import { WeChatApi } from './wechat/api.js';
import { saveAccount, loadLatestAccount, type AccountData } from './wechat/accounts.js';
import { startQrLogin, waitForQrScan } from './wechat/login.js';
import { createMonitor, type MonitorCallbacks } from './wechat/monitor.js';
import { createSender } from './wechat/send.js';
import { downloadImage, extractText, extractFirstImageUrl, extractFirstFileItem, extractFirstVoiceItem, downloadFile, downloadAllMedia } from './wechat/media.js';
import { createSessionStore, type Session } from './session.js';
import { routeCommand, handleSetupWizard, type CommandContext, type CommandResult } from './commands/router.js';
import { claudeQuery, validateModel, type QueryOptions, type PermissionRequest } from './claude/provider.js';
import { transcribeVoice } from './wechat/voice-transcribe.js';
import { loadConfig, saveConfig } from './config.js';
import { logger } from './logger.js';
import { DATA_DIR } from './constants.js';
import { MessageType, MessageItemType, type WeixinMessage } from './wechat/types.js';
import {
  loadLoops, addLoop, removeLoop, updateNextFire, getLoopsForAccount,
  type LoopEntry, formatInterval,
} from './loop-registry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_MESSAGE_LENGTH = 4000;
const STALE_PENDING_UPLOAD_MS = 30 * 60 * 1000;

// Loop scheduler — module-level so handleMessage can call scheduleLoop
// after startDaemon sets it up.
let _scheduleLoop: ((loop: LoopEntry) => void) | null = null;
function scheduleLoopGlobal(loop: LoopEntry): void {
  if (_scheduleLoop) _scheduleLoop(loop);
}
let _reconcileLoopTimers: (() => void) | null = null;
function reconcileLoopTimersGlobal(): void {
  if (_reconcileLoopTimers) _reconcileLoopTimers();
}

// -- Pending permission approval (approve mode) --
// When the CLI asks to use a tool, we park a resolver here and push the request
// to WeChat. The user's y/n reply (handled as a priority command) resolves it.
interface PendingApproval {
  accountId: string;
  resolve: (decision: { behavior: 'allow' | 'deny'; message?: string }) => void;
  toolName: string;
  timer: ReturnType<typeof setTimeout>;
}
const pendingApprovals = new Map<string, PendingApproval>();
const APPROVAL_TIMEOUT_MS = 30_000;

/** Resolve a parked approval for an account with allow/deny. Returns true if one existed. */
function resolveApproval(accountId: string, behavior: 'allow' | 'deny', message?: string): boolean {
  const pending = pendingApprovals.get(accountId);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingApprovals.delete(accountId);
  pending.resolve({ behavior, message });
  return true;
}

/** Build a concise, readable WeChat message describing a tool-permission request. */
function formatApprovalRequest(req: PermissionRequest): string {
  const lines = ['**🔐 需要确认操作**', '', `**工具** ${req.toolName}`];
  const input = req.input ?? {};
  if (typeof input.command === 'string') {
    lines.push('', `**命令**`);
    lines.push('`' + input.command + '`');
    if (input.description) lines.push('', input.description);
  } else if (typeof input.file_path === 'string') {
    lines.push('', `**文件** ${input.file_path}`);
  } else {
    const json = JSON.stringify(input);
    lines.push('', `**参数** ${json.length > 400 ? json.slice(0, 400) + '…' : json}`);
  }
  if (req.decisionReason) lines.push('', `_${req.decisionReason}_`);
  lines.push('', '回复 **y** 批准 / **n** 拒绝（30 秒有效）');
  return lines.join('\n');
}

// Extensions eligible for auto-push when detected in Claude's response
const AUTO_PUSH_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico',
  '.pdf', '.doc', '.docx', '.ppt', '.pptx', '.rtf',
  '.txt', '.md',
  '.csv', '.xlsx', '.xls',
  '.mp3', '.wav', '.m4a', '.mp4', '.mov',
]);

/** Extract local file paths from Claude's response text (files and directories). */
function extractFilePathsFromText(text: string, cwd: string): string[] {
  const paths: string[] = [];
  // Match absolute paths with extension (files) or trailing slash / no extension (dirs)
  const regex = /(?:\/(?:Users|home|tmp|var|etc|opt)\/[^\s`'"()\[\]{}|<>]+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const raw = match[0].replace(/[,。、]+$/, ''); // strip trailing punctuation
    const resolved = raw.startsWith('~') ? raw.replace(/^~/, homedir()) : raw;
    paths.push(resolved);
  }
  // Also match tilde paths
  const tildeRegex = /~\/[^\s`'"()\[\]{}|<>]+/g;
  while ((match = tildeRegex.exec(text)) !== null) {
    paths.push(match[0].replace(/^~/, homedir()).replace(/[,。、]+$/, ''));
  }
  return [...new Set(paths)]; // deduplicate
}

/** Split text into blocks at paragraph boundaries (double newlines). */
function parseBlocks(text: string): string[] {
  return text.split(/\n\n+/).filter(block => block.length > 0);
}

/** Find a safe split point that won't break markdown formatting. */
function findSafeSplitPoint(text: string, maxLen: number): number {
  // Try newline first (preserves list items, paragraphs)
  let idx = text.lastIndexOf('\n', maxLen);
  if (idx >= maxLen * 0.3) return idx;

  // Try sentence-ending punctuation
  const sentenceEnd = /[。！？.!?]$/;
  for (let i = maxLen; i >= maxLen * 0.5; i--) {
    if (sentenceEnd.test(text.slice(i - 1, i))) return i;
  }

  // Try space (won't split mid-word or mid-markdown)
  idx = text.lastIndexOf(' ', maxLen);
  if (idx >= maxLen * 0.3) return idx;

  // Last resort: hard cut
  return maxLen;
}

/** Fallback: split a single oversized block at safe boundaries. */
function splitByNewline(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    const splitIdx = findSafeSplitPoint(remaining, maxLen);
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n+/, '');
  }
  return chunks;
}

/**
 * Card-aware message splitter.
 * Splits at paragraph boundaries (double newlines) to keep cards intact,
 * falls back to newline-based splitting for oversized single blocks.
 */
function splitMessage(text: string, maxLen: number = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLen) return [text];
  const blocks = parseBlocks(text);
  const chunks: string[] = [];
  let current = '';

  for (const block of blocks) {
    // Can this block fit into the current chunk?
    if (current.length === 0) {
      if (block.length <= maxLen) {
        current = block;
      } else {
        chunks.push(...splitByNewline(block, maxLen));
      }
    } else if (current.length + 2 + block.length <= maxLen) {
      current += '\n\n' + block;
    } else {
      // Current chunk is complete, start a new one
      chunks.push(current);
      if (block.length <= maxLen) {
        current = block;
      } else {
        chunks.push(...splitByNewline(block, maxLen));
        current = '';
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function promptUser(question: string, defaultValue?: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const display = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
    rl.question(display, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

/** Open a file using the platform's default application (secure: uses spawnSync) */
function openFile(filePath: string): void {
  const platform = process.platform;
  let cmd: string;
  let args: string[];

  if (platform === 'darwin') {
    cmd = 'open';
    args = [filePath];
  } else if (platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '', filePath];
  } else {
    // Linux: try xdg-open
    cmd = 'xdg-open';
    args = [filePath];
  }

  const result = spawnSync(cmd, args, { stdio: 'ignore' });
  if (result.error) {
    logger.warn('Failed to open file', { cmd, filePath, error: result.error.message });
  }
}

function saveSessionSafely(
  sessionStore: ReturnType<typeof createSessionStore>,
  accountId: string,
  session: Session,
  context: string,
): boolean {
  try {
    sessionStore.save(accountId, session);
    return true;
  } catch (err) {
    logger.error('Failed to save session', {
      accountId,
      context,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

function resetSessionStateSafely(
  sessionStore: ReturnType<typeof createSessionStore>,
  accountId: string,
  session: Session,
  context: string,
): void {
  session.state = 'idle';
  saveSessionSafely(sessionStore, accountId, session, context);
}

function clearStalePendingUploads(sessionStore: ReturnType<typeof createSessionStore>): void {
  const sessionsDir = join(DATA_DIR, 'sessions');
  let entries: string[] = [];
  try {
    entries = readdirSync(sessionsDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger.warn('Failed to scan sessions for stale pending uploads', {
        dir: sessionsDir,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  const cutoff = Date.now() - STALE_PENDING_UPLOAD_MS;
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const accountId = entry.slice(0, -'.json'.length);
    if (!accountId) continue;

    const session = sessionStore.load(accountId);
    const pending = session.pendingFileUpload;
    if (!pending) continue;

    if (!pending.startedAt || pending.startedAt < cutoff) {
      logger.warn('Clearing stale pending file upload on startup', {
        accountId,
        startedAt: pending.startedAt,
      });
      delete session.pendingFileUpload;
      saveSessionSafely(sessionStore, accountId, session, 'clear stale pendingFileUpload on startup');
    }
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

async function runSetup(): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true });
  const QR_PATH = join(DATA_DIR, 'qrcode.png');

  console.log('正在设置...\n');

  // Loop: generate QR → display → poll for scan → handle expiry → repeat
  while (true) {
    const { qrcodeUrl, qrcodeId } = await startQrLogin();

    const isHeadlessLinux = process.platform === 'linux' &&
      !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;

    if (isHeadlessLinux) {
      // Headless Linux: display QR in terminal using qrcode-terminal
      try {
        const qrcodeTerminal = await import('qrcode-terminal');
        console.log('请用微信扫描下方二维码：\n');
        qrcodeTerminal.default.generate(qrcodeUrl, { small: true });
        console.log();
        console.log('二维码链接：', qrcodeUrl);
        console.log();
      } catch {
        logger.warn('qrcode-terminal not available, falling back to URL');
        console.log('无法在终端显示二维码，请访问链接：');
        console.log(qrcodeUrl);
        console.log();
      }
    } else {
      // macOS / Windows / GUI Linux: generate QR PNG and open with system viewer
      const QRCode = await import('qrcode');
      const pngData = await QRCode.toBuffer(qrcodeUrl, { type: 'png', width: 400, margin: 2 });
      writeFileSync(QR_PATH, pngData);

      openFile(QR_PATH);
      console.log('已打开二维码图片，请用微信扫描：');
      console.log(`图片路径: ${QR_PATH}\n`);
    }

    console.log('等待扫码绑定...');

    try {
      await waitForQrScan(qrcodeId);
      console.log('✅ 绑定成功!');
      break;
    } catch (err: any) {
      if (err.message?.includes('expired')) {
        console.log('⚠️ 二维码已过期，正在刷新...\n');
        continue;
      }
      throw err;
    }
  }

  // Clean up QR image
  try { unlinkSync(QR_PATH); } catch {
    logger.warn('Failed to clean up QR image', { path: QR_PATH });
  }

  const workingDir = await promptUser('请输入工作目录', join(homedir(), 'Documents', 'ClaudeCode'));
  const config = loadConfig();
  config.workingDirectory = workingDir;
  saveConfig(config);

  console.log('运行 npm run daemon -- start 启动服务');
}

// ---------------------------------------------------------------------------
// Daemon
// ---------------------------------------------------------------------------

async function runDaemon(): Promise<void> {
  const config = loadConfig();
  const account = loadLatestAccount();

  if (!account) {
    console.error('未找到账号，请先运行 node dist/main.js setup');
    process.exit(1);
  }

  const api = new WeChatApi(account.botToken, account.baseUrl);
  const sessionStore = createSessionStore();
  clearStalePendingUploads(sessionStore);
  const session: Session = sessionStore.load(account.accountId);

  // Fix: backfill session workingDirectory from config if it's still the default process.cwd()
  if (config.workingDirectory && session.workingDirectory === process.cwd()) {
    session.workingDirectory = config.workingDirectory;
    sessionStore.save(account.accountId, session);
  }

  // Fix: reset stale non-idle state on startup (e.g. after crash)
  if (session.state !== 'idle') {
    logger.warn('Resetting stale session state on startup', { state: session.state });
    session.state = 'idle';
    sessionStore.save(account.accountId, session);
  }

  const sender = createSender(api, account.accountId);
  const sharedCtx = { lastContextToken: '' };
  const activeControllers = new Map<string, AbortController>();

  // -- Message queue for serial processing --
  const messageQueue: WeixinMessage[] = [];
  let processingQueue = false;

  async function drainQueue(): Promise<void> {
    if (processingQueue) return;
    processingQueue = true;
    try {
      while (messageQueue.length > 0) {
        const msg = messageQueue.shift()!;
        await handleMessage(msg, account!, session, sessionStore, sender, config, sharedCtx, activeControllers, messageQueue);
      }
    } finally {
      processingQueue = false;
    }
  }

  // -- Wire the monitor callbacks --

  /** Handle priority commands (/stop, /clear, y/n approval) immediately, bypassing the serial queue. */
  function handlePriorityCommand(msg: WeixinMessage): boolean {
    if (msg.message_type !== MessageType.USER || !msg.item_list) return false;
    const text = extractTextFromItems(msg.item_list).trim();

    // Approval reply (y/n) — only meaningful while a tool approval is pending.
    if (pendingApprovals.has(account!.accountId)) {
      const lower = text.toLowerCase();
      const isYes = lower === 'y' || lower === 'yes' || lower === '是' || lower === '同意' || lower === '批准';
      const isNo = lower === 'n' || lower === 'no' || lower === '否' || lower === '拒绝' || lower === '不';
      if (isYes || isNo) {
        resolveApproval(account!.accountId, isYes ? 'allow' : 'deny', isYes ? undefined : '用户拒绝了此操作');
        sender.sendText(msg.from_user_id!, msg.context_token ?? '', isYes ? '✅ 已批准' : '🚫 已拒绝').catch(() => {});
        return true;
      }
      // /stop and /clear should still work: deny the pending op, then fall through.
      if (text.startsWith('/stop') || text.startsWith('/clear')) {
        resolveApproval(account!.accountId, 'deny', '用户中止了对话');
      } else {
        // Any other message while awaiting approval: remind the user.
        sender.sendText(msg.from_user_id!, msg.context_token ?? '', '⏳ 正在等待你确认上一个操作，请回复 y 批准 / n 拒绝。').catch(() => {});
        return true;
      }
    }

    if (!text.startsWith('/stop') && !text.startsWith('/clear')) return false;
    if (session.state !== 'processing') return false;

    const ctrl = activeControllers.get(account!.accountId);
    if (ctrl) { ctrl.abort(); activeControllers.delete(account!.accountId); }
    session.state = 'idle';
    sessionStore.save(account!.accountId, session);

    if (text.startsWith('/stop')) {
      messageQueue.length = 0;
      sender.sendText(msg.from_user_id!, msg.context_token ?? '', '⏹ 已停止当前对话，排队中的消息已清空。').catch(() => {});
    }
    return true;
  }

  const callbacks: MonitorCallbacks = {
    onMessage: async (msg: WeixinMessage) => {
      if (handlePriorityCommand(msg)) return;
      messageQueue.push(msg);
      drainQueue();
    },
    onSessionExpired: () => {
      logger.warn('Session expired, will keep retrying...');
      console.error('⚠️ 微信会话已过期，请重新运行 setup 扫码绑定');
    },
  };

  const monitor = createMonitor(api, callbacks);

  // -- Graceful shutdown --

  const loopTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function clearLoopTimer(loopId: string): void {
    const timer = loopTimers.get(loopId);
    if (!timer) return;
    clearTimeout(timer);
    loopTimers.delete(loopId);
  }

  function reconcileLoopTimers(): void {
    const activeLoopIds = new Set(getLoopsForAccount(account!.accountId).map(loop => loop.id));
    for (const loopId of [...loopTimers.keys()]) {
      if (!activeLoopIds.has(loopId)) {
        clearLoopTimer(loopId);
      }
    }
  }

  function scheduleLoop(loop: LoopEntry): void {
    if (loopTimers.has(loop.id)) return;
    const delay = Math.max(0, loop.nextFireAt - Date.now());
    const timer = setTimeout(async () => {
      loopTimers.delete(loop.id);
      // Check loop still exists (may have been stopped)
      const current = loadLoops().find(l => l.id === loop.id);
      if (!current) return;

      logger.info('Loop firing', { id: loop.id, prompt: loop.prompt.slice(0, 60) });
      const loopFromUserId = account!.userId || '';
      const loopContextToken = sharedCtx.lastContextToken;
      if (!loopFromUserId || !loopContextToken) {
        logger.warn('Loop skipped: no user to send to', { id: loop.id });
      } else {
        try {
          await sendToClaude(
            `[🔁 定时任务] ${loop.prompt}`,
            undefined, undefined,
            loopFromUserId, loopContextToken,
            account!, session, sessionStore, sender, config, activeControllers,
          );
        } catch (err) {
          logger.error('Loop execution failed', { id: loop.id, error: err instanceof Error ? err.message : String(err) });
        }
      }

      const latest = loadLoops().find(l => l.id === loop.id);
      if (!latest) {
        logger.info('Loop removed during execution, skipping reschedule', { id: loop.id });
        clearLoopTimer(loop.id);
        return;
      }

      // Reschedule
      const nextFireAt = Date.now() + latest.intervalMs;
      updateNextFire(loop.id, nextFireAt);
      scheduleLoop({ ...latest, nextFireAt });
    }, delay);
    loopTimers.set(loop.id, timer);
  }

  // Restore loops that were active before restart
  for (const loop of loadLoops().filter(l => l.accountId === account!.accountId)) {
    logger.info('Restoring loop', { id: loop.id, interval: formatInterval(loop.intervalMs) });
    scheduleLoop(loop);
  }

  // Expose scheduleLoop globally so handleMessage can use it
  _scheduleLoop = scheduleLoop;
  _reconcileLoopTimers = reconcileLoopTimers;

  function shutdown(): void {
    logger.info('Shutting down...');
    for (const controller of activeControllers.values()) controller.abort();
    activeControllers.clear();
    for (const timer of loopTimers.values()) clearTimeout(timer);
    loopTimers.clear();
    monitor.stop();
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  logger.info('Daemon started', { accountId: account.accountId });
  console.log(`已启动 (账号: ${account.accountId})`);

  await monitor.run();
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

async function handleMessage(
  msg: WeixinMessage,
  account: AccountData,
  session: Session,
  sessionStore: ReturnType<typeof createSessionStore>,
  sender: ReturnType<typeof createSender>,
  config: ReturnType<typeof loadConfig>,
  sharedCtx: { lastContextToken: string },
  activeControllers: Map<string, AbortController>,
  messageQueue: WeixinMessage[],
): Promise<void> {
  // Filter: only user messages with required fields
  if (msg.message_type !== MessageType.USER) return;
  if (!msg.from_user_id || !msg.item_list) return;
  if (account.userId && msg.from_user_id !== account.userId) return;

  const contextToken = msg.context_token ?? '';
  const fromUserId = msg.from_user_id;
  sharedCtx.lastContextToken = contextToken;

  // Extract text from items
  let userText = extractTextFromItems(msg.item_list);
  const imageItem = extractFirstImageUrl(msg.item_list);
  const fileItem = extractFirstFileItem(msg.item_list);
  const voiceItem = extractFirstVoiceItem(msg.item_list);

  // Voice → transcribe locally with mlx_whisper, echo the result, then treat as text
  if (voiceItem && !userText) {
    const stopVoiceTyping = sender.startTyping(fromUserId, contextToken);
    let transcript: string | null = null;
    try {
      transcript = await transcribeVoice(voiceItem);
    } catch (err) {
      logger.warn('transcribeVoice threw', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      stopVoiceTyping();
    }
    if (transcript) {
      await sender.sendText(fromUserId, contextToken, `🎤 识别为：${transcript}`);
      userText = transcript;
    } else {
      await sender.sendText(fromUserId, contextToken, '🎤 语音没识别出文字，请重发或直接打字。');
      return;
    }
  }

  // Drop non-command messages while processing (priority commands already handled upstream)
  if (session.state === 'processing' && !userText.startsWith('/')) {
    return;
  }

  // -- Setup wizard interception (takes priority over normal routing) --

  if (session.pendingSetup) {
    const updateSession = (partial: Partial<typeof session>) => {
      Object.assign(session, partial);
      sessionStore.save(account.accountId, session);
    };
    const ctx: CommandContext = {
      accountId: account.accountId,
      session,
      updateSession,
      clearSession: () => sessionStore.clear(account.accountId),
      getChatHistoryText: (limit?: number) => sessionStore.getChatHistoryText(session, limit),
      text: userText,
    };
    const wizardResult = handleSetupWizard(ctx, userText);
    if (wizardResult) {
      if (wizardResult.reply) {
        await sender.sendText(fromUserId, contextToken, wizardResult.reply);
      }
      return;
    }
  }

  // -- File upload collection mode --

  if (session.pendingFileUpload) {
    const updateSession = (partial: Partial<Session>) => {
      Object.assign(session, partial);
      sessionStore.save(account.accountId, session);
    };

    // Allow /send-you-end, /send-you-cancel, /send-you to pass through to command routing
    const passThroughCmds = ['/send-you-end', '/send-you-cancel', '/send-you'];
    const isPassThrough = passThroughCmds.some(cmd => userText.trim().toLowerCase().startsWith(cmd));

    if (!isPassThrough) {
      // Check if message has media
      const hasMedia = msg.item_list?.some(
        item => item.type === MessageItemType.IMAGE || item.type === MessageItemType.FILE
      );

      if (hasMedia && msg.item_list) {
        // Download all media in this message
        const downloaded = await downloadAllMedia(msg.item_list);
        if (downloaded.length > 0) {
          const existing = session.pendingFileUpload.items;
          updateSession({
            pendingFileUpload: {
              ...session.pendingFileUpload,
              items: [...existing, ...downloaded],
            },
          });
          const total = session.pendingFileUpload.items.length;
          const names = downloaded.map(f => f.fileName).join('、');
          await sender.sendText(fromUserId, contextToken,
            `✅ 已接收: ${names}（共 ${total} 个文件）\n\n继续发送文件，或发 /send-you-end [要求] 完成。`
          );
        } else {
          await sender.sendText(fromUserId, contextToken, '⚠️ 文件下载失败，请重试。');
        }
        return;
      }

      if (userText && !userText.startsWith('/')) {
        // Non-command text during collection — remind user
        await sender.sendText(fromUserId, contextToken,
          `📥 文件接收中（已收 ${session.pendingFileUpload.items.length} 个）\n\n请继续发送文件，或发 /send-you-end [要求] 完成，/send-you-cancel 取消。`
        );
        return;
      }
    }
  }

  // -- Command routing --

  if (userText.startsWith('/')) {
    const updateSession = (partial: Partial<Session>) => {
      Object.assign(session, partial);
      sessionStore.save(account.accountId, session);
    };

    const ctx: CommandContext = {
      accountId: account.accountId,
      session,
      updateSession,
      clearSession: () => sessionStore.clear(account.accountId),
      getChatHistoryText: (limit?: number) => sessionStore.getChatHistoryText(session, limit),
      text: userText,
    };

    const result: CommandResult = routeCommand(ctx);

    if (userText.trim().toLowerCase().startsWith('/loop')) {
      reconcileLoopTimersGlobal();
    }

    if (result.handled && result.reply) {
      await sender.sendText(fromUserId, contextToken, result.reply);
      return;
    }

    if (result.handled && result.claudePrompt) {
      await sendToClaude(
        result.claudePrompt, imageItem, fileItem, fromUserId, contextToken,
        account, session, sessionStore, sender, config, activeControllers,
      );
      return;
    }

    if (result.handled && result.compactSession) {
      await compactSession(
        fromUserId, contextToken,
        account, session, sessionStore, sender, config,
      );
      return;
    }

    if (result.handled && result.validateModel) {
      const target = result.validateModel;
      const cwd = (session.workingDirectory || config.workingDirectory).replace(/^~/, homedir());
      const stopTyping = sender.startTyping(fromUserId, contextToken);
      await sender.sendText(fromUserId, contextToken, `⏳ 正在验证模型 ${target} ...`);
      let v;
      try {
        v = await validateModel(target, cwd);
      } finally {
        stopTyping();
      }
      if (v.ok) {
        session.model = target;
        sessionStore.save(account.accountId, session);
        await sender.sendText(fromUserId, contextToken, `✅ 模型已切换为:\n  ${target}`);
      } else {
        const reasonText: Record<string, string> = {
          invalid_model: '模型名称无效（该模型不存在或拼写有误）',
          auth: '认证问题（API 密钥无效、欠费或无权访问该模型）',
          network: '网络问题（无法连接到模型服务）',
          rate_limit: '服务限流或过载，请稍后重试',
          timeout: '探测超时无响应（多为模型名无效或服务不可达）',
          unknown: '未知错误',
        };
        const label = reasonText[v.reason ?? 'unknown'] ?? '未知错误';
        const lines = [
          `❌ 模型 ${target} 不可用`,
          '',
          `原因: ${label}`,
        ];
        if (v.detail) lines.push('', `详情: ${v.detail}`);
        lines.push('', `当前仍使用:\n  ${session.model ?? '默认'}`);
        await sender.sendText(fromUserId, contextToken, lines.join('\n'));
      }
      return;
    }

    if (result.handled && result.sendFile) {
      await sender.sendFile(fromUserId, contextToken, result.sendFile);
      return;
    }

    if (result.handled && result.sendFiles && result.sendFiles.length > 0) {
      await sender.sendText(fromUserId, contextToken, `📎 准备发送 ${result.sendFiles.length} 个文件...`);
      const { sent, failed } = await sender.sendFiles(fromUserId, contextToken, result.sendFiles);
      if (failed.length > 0) {
        await sender.sendText(fromUserId, contextToken,
          `✅ 已发送 ${sent} 个文件，以下 ${failed.length} 个发送失败:\n${failed.map(f => '  ' + f).join('\n')}`
        );
      }
      return;
    }

    if (result.handled && result.sendYouPayload) {
      const { requirement, items } = result.sendYouPayload;
      const { readFileSync } = await import('node:fs');
      const { extname } = await import('node:path');

      const mimeByExt: Record<string, string> = {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
      };

      const collectedImages: QueryOptions['images'] = [];
      const collectedFilePaths: string[] = [];
      for (const it of items) {
        if (it.type === 'image') {
          try {
            const buf = readFileSync(it.localPath);
            const ext = extname(it.localPath).toLowerCase();
            collectedImages.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: mimeByExt[ext] ?? 'image/jpeg',
                data: buf.toString('base64'),
              },
            });
          } catch (err) {
            logger.warn('Failed to read collected image', { path: it.localPath, error: err instanceof Error ? err.message : String(err) });
          }
        } else {
          collectedFilePaths.push(it.localPath);
        }
      }

      await sendToClaude(
        requirement || '请分析以下文件/图片。', undefined, undefined, fromUserId, contextToken,
        account, session, sessionStore, sender, config, activeControllers,
        { images: collectedImages, filePaths: collectedFilePaths },
      );
      return;
    }

    if (result.handled && result.startLoop) {
      try {
        const loop = addLoop({
          accountId: account.accountId,
          prompt: result.startLoop.prompt,
          intervalMs: result.startLoop.intervalMs,
          cwd: session.workingDirectory,
          model: session.model,
          effort: session.effort,
          sdkSessionId: session.sdkSessionId,
        });
        scheduleLoopGlobal(loop);
        await sender.sendText(fromUserId, contextToken, [
          `✅ Loop 已创建 [${loop.id}]`,
          '',
          `任务:\n  ${loop.prompt}`,
          '',
          `间隔:\n  每 ${formatInterval(loop.intervalMs)}`,
          '',
          `首次触发:\n  ${formatInterval(loop.intervalMs)} 后`,
          '',
          '用 /loop 查看状态，/loop stop ' + loop.id + ' 停止',
        ].join('\n'));
      } catch (err) {
        await sender.sendText(fromUserId, contextToken, `❌ 创建 loop 失败: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    if (result.handled) return;

    // Not handled, treat as normal message (fall through)
  }

  // -- Normal message -> Claude --

  if (!userText && !imageItem && !fileItem) {
    await sender.sendText(fromUserId, contextToken, '暂不支持此类型消息，请发送文字、语音、图片或文件');
    return;
  }

  await sendToClaude(
    userText, imageItem, fileItem, fromUserId, contextToken,
    account, session, sessionStore, sender, config, activeControllers,
  );
}

function extractTextFromItems(items: NonNullable<WeixinMessage['item_list']>): string {
  return items.map((item) => extractText(item)).filter(Boolean).join('\n');
}

async function compactSession(
  fromUserId: string,
  contextToken: string,
  account: AccountData,
  session: Session,
  sessionStore: ReturnType<typeof createSessionStore>,
  sender: ReturnType<typeof createSender>,
  config: ReturnType<typeof loadConfig>,
): Promise<void> {
  session.state = 'processing';
  saveSessionSafely(sessionStore, account.accountId, session, 'mark compactSession processing');

  const stopTyping = sender.startTyping(fromUserId, contextToken);
  try {
    await sender.sendText(fromUserId, contextToken, '⏳ 正在压缩上下文，请稍候（通常需要1-2分钟）...');

    const cwd = (session.workingDirectory || config.workingDirectory).replace(/^~/, homedir());
    const result = await claudeQuery({
      prompt: '/compact',
      cwd,
      resume: session.sdkSessionId,
      model: session.model,
    });

    // compact 完成后 session ID 不变，直接用 result.sessionId（和原来一样）
    // 从 result.text 里不会有实际输出（compact 完成后 Claude 没有回复文字）
    // 但 claudeQuery 内部能拿到 sessionId（来自 system/init）
    if (result.error && !result.sessionId) {
      await sender.sendText(fromUserId, contextToken, `❌ 压缩失败: ${result.error}`);
      return;
    }

    // session ID 保持不变（compact 不会改变 session ID）
    session.sdkSessionId = result.sessionId || session.sdkSessionId;
    saveSessionSafely(sessionStore, account.accountId, session, 'save compactSession session id');

    // Parse compact stats from the sentinel we injected in provider.ts
    let statsLine = '';
    const compactMarker = result.text.match(/^__compact__:(\d+):(\d+)$/m);
    if (compactMarker) {
      const pre = parseInt(compactMarker[1], 10);
      const post = parseInt(compactMarker[2], 10);
      const pct = pre > 0 ? Math.round((1 - post / pre) * 100) : 0;
      statsLine = `\n压缩前: ${pre.toLocaleString()} tokens → 压缩后: ${post.toLocaleString()} tokens（减少 ${pct}%）`;
    }

    await sender.sendText(fromUserId, contextToken, `✅ 上下文已压缩${statsLine}\n\nSession ID 不变，对话继续。可直接发送下一条消息。`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await sender.sendText(fromUserId, contextToken, `❌ 压缩出错: ${msg}`);
  } finally {
    resetSessionStateSafely(sessionStore, account.accountId, session, 'compactSession finally');
    stopTyping();
  }
}

async function sendToClaude(
  userText: string,
  imageItem: ReturnType<typeof extractFirstImageUrl>,
  fileItem: ReturnType<typeof extractFirstFileItem>,
  fromUserId: string,
  contextToken: string,
  account: AccountData,
  session: Session,
  sessionStore: ReturnType<typeof createSessionStore>,
  sender: ReturnType<typeof createSender>,
  config: ReturnType<typeof loadConfig>,
  activeControllers: Map<string, AbortController>,
  preCollected?: {
    images?: QueryOptions['images'];
    filePaths?: string[];
  },
): Promise<void> {
  // Set state to processing
  session.state = 'processing';
  saveSessionSafely(sessionStore, account.accountId, session, 'mark sendToClaude processing');

  // Create abort controller for this query so it can be cancelled by new messages
  const abortController = new AbortController();
  activeControllers.set(account.accountId, abortController);

  // Flush timer for streaming text to WeChat during query (declared here for finally cleanup)
  let flushTimer: ReturnType<typeof setInterval> | undefined;

  // Record user message in chat history
  sessionStore.addChatMessage(session, 'user', userText || '(图片)');

  // Start typing indicator (keepalive until stopTyping is called)
  const stopTyping = sender.startTyping(fromUserId, contextToken);

  try {
    // Download image if present
    let images: QueryOptions['images'];
    if (imageItem) {
      const base64DataUri = await downloadImage(imageItem);
      if (base64DataUri) {
        const matches = base64DataUri.match(/^data:([^;]+);base64,(.+)$/);
        if (matches) {
          images = [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: matches[1],
                data: matches[2],
              },
            },
          ];
        }
      }
    }

    // Download file if present
    let prompt = userText || '请分析这张图片';
    if (fileItem) {
      const filePath = await downloadFile(fileItem);
      if (filePath) {
        const fileName = fileItem.file_item?.file_name || basename(filePath);
        prompt = userText
          ? `${userText}\n\n用户发送了文件: ${fileName}\n文件已保存到: ${filePath}\n请先读取这个文件再回答。`
          : `用户发送了文件: ${fileName}\n文件已保存到: ${filePath}\n请读取这个文件并总结其内容。`;
      }
    }

    // Merge pre-collected media from /send-you flow
    if (preCollected) {
      if (preCollected.images && preCollected.images.length > 0) {
        images = [...(images ?? []), ...preCollected.images];
      }
      if (preCollected.filePaths && preCollected.filePaths.length > 0) {
        const fileLines = preCollected.filePaths
          .map((p) => `  ${p}`)
          .join('\n');
        prompt = `${prompt}\n\n用户发送了以下文件，请用 Read 工具读取后再回答：\n${fileLines}`;
      }
    }

    let textBuffer = '';
    let anySent = false;
    let lastSentTime = Date.now();

    // Flush thresholds — keep these high to avoid hammering the WeChat rate limit.
    // The API returns ret:-2 if we send too many messages in a short window, and
    // retries are also rate-limited, so messages get silently dropped.
    const MIN_BATCH_FLUSH_LEN = 200;   // don't flush tiny thinking-aloud fragments
    const SOFT_FLUSH_LIMIT = 3800;
    const MIN_FLUSH_INTERVAL_MS = 2000; // at most one message every 2s during streaming

    /** Check if buffer ends at a structural boundary (double newline or horizontal rule). */
    function endsWithStructuralBoundary(text: string): boolean {
      return /\n\n\s*$/.test(text) || /\n[-*_]{3,}\s*$/.test(text);
    }

    // Serial promise chain — each flushText() appends to the chain, no flags needed
    let flushChain: Promise<void> = Promise.resolve();

    function flushText(): Promise<void> {
      // Capture and clear synchronously to prevent race condition:
      // new deltas can arrive while the chain awaits sendText,
      // causing the async callback to clear content it never captured.
      const captured = textBuffer.trim();
      textBuffer = '';
      if (!captured) return flushChain;

      flushChain = flushChain.then(async () => {
        const chunks = splitMessage(captured);
        for (const chunk of chunks) {
          await sender.sendText(fromUserId, contextToken, chunk);
        }
        anySent = true;
        lastSentTime = Date.now();
      }).catch((err) => {
        logger.error('flushText send failed', { error: err instanceof Error ? err.message : String(err) });
      });
      return flushChain;
    }

    // Safety net: send keepalive if nothing was sent for 5 minutes
    const SILENCE_WARNING_MS = 5 * 60 * 1000;
    const SILENCE_MESSAGES = [
      '我还在处理中，这个问题有点复杂，请再稍等一下',
      '正在努力干活中，马上就有结果了，请稍等片刻',
      '有点复杂正在处理，再给我一点时间，很快就好',
      '快好了别着急，正在收尾阶段，马上给你回复',
      '还在跑呢，任务量比较大，不过马上就能出结果了',
      '任务比想象的复杂一些，再等等我，正在全力处理',
      '正在处理中，进展顺利，再等一会儿就好',
      '还没完不过已经快了，再给我一分钟就能搞定',
      '我在认真思考这个问题，请再稍等一会儿',
      '稍微有点棘手，不过已经快解决了，再等我一下',
    ];
    flushTimer = setInterval(() => {
      if (Date.now() - lastSentTime > SILENCE_WARNING_MS) {
        const msg = SILENCE_MESSAGES[Math.floor(Math.random() * SILENCE_MESSAGES.length)];
        sender.sendText(fromUserId, contextToken, msg).catch(() => {});
        lastSentTime = Date.now();
      }
    }, 2000);

    const queryOptions: QueryOptions = {
      prompt,
      cwd: (session.workingDirectory || config.workingDirectory).replace(/^~/, homedir()),
      resume: session.sdkSessionId,
      model: session.model,
      effort: session.effort,
      advisor: session.advisor,
      addDirs: [
        join(tmpdir(), 'wechat-claude-uploads'),
        join(tmpdir(), 'wechat-claude-code'),
      ],
      systemPrompt: [
        '你正在通过微信与用户对话，不是在终端里。不要让用户去终端操作。如果用户需要文件，直接输出文件地址就行，会自动识别解析推送文件到用户的微信中。微信支持 Markdown 渲染，请在回复中合理使用 **粗体**、列表（1. 或 -）、`---` 分割线来让内容更清晰，但不要过度使用，保持简洁。',
        config.systemPrompt,
      ].filter(Boolean).join('\n'),
      abortController,
      images,
      permissionMode: session.permissionMode ?? 'bypass',
      onPermissionRequest: (session.permissionMode === 'approve')
        ? (req) => new Promise<{ behavior: 'allow' | 'deny'; message?: string }>((resolveDecision) => {
            // Park the resolver; the user's y/n reply (priority command) resolves it.
            const timer = setTimeout(() => {
              if (pendingApprovals.get(account.accountId)?.resolve === resolveDecision) {
                pendingApprovals.delete(account.accountId);
              }
              sender.sendText(fromUserId, contextToken, '⏱ 30 秒未确认，已自动拒绝此操作。').catch(() => {});
              resolveDecision({ behavior: 'deny', message: '审批超时' });
            }, APPROVAL_TIMEOUT_MS);
            pendingApprovals.set(account.accountId, {
              accountId: account.accountId,
              resolve: resolveDecision,
              toolName: req.toolName,
              timer,
            });
            const detail = formatApprovalRequest(req);
            sender.sendText(fromUserId, contextToken, detail).catch(() => {});
          })
        : undefined,
      onText: async (delta: string) => {
        textBuffer += delta;

        const bufferBig = textBuffer.length > SOFT_FLUSH_LIMIT;
        const bufferReadable = endsWithStructuralBoundary(textBuffer) && textBuffer.trim().length >= MIN_BATCH_FLUSH_LEN;
        const intervalOk = Date.now() - lastSentTime >= MIN_FLUSH_INTERVAL_MS;

        // Flush only when content is substantial AND enough time has passed,
        // OR when buffer is about to exceed the message size limit.
        if (bufferBig || (bufferReadable && intervalOk)) {
          await flushText();
        }
      },
      onBlockEnd: () => {
        const bufferBig = textBuffer.length > SOFT_FLUSH_LIMIT;
        const bufferReadable = textBuffer.trim().length >= MIN_BATCH_FLUSH_LEN;
        const intervalOk = Date.now() - lastSentTime >= MIN_FLUSH_INTERVAL_MS;
        if (bufferBig || (bufferReadable && intervalOk)) {
          flushText();
        }
      },
    };

    let result = await claudeQuery(queryOptions);

    // If resume failed (e.g. corrupted session), retry without resume
    if (result.error && queryOptions.resume) {
      logger.warn('Resume failed, retrying without resume', { error: result.error, sessionId: queryOptions.resume });
      queryOptions.resume = undefined;
      session.sdkSessionId = undefined;
      saveSessionSafely(sessionStore, account.accountId, session, 'clear invalid resume before retry');
      const retryResult = await claudeQuery(queryOptions);
      Object.assign(result, retryResult);
    }

    // Stop periodic flush and send any remaining buffered content
    clearInterval(flushTimer);
    await flushText();

    // Send result back to WeChat
    if (result.text) {
      if (result.error) {
        logger.warn('Claude query had error but returned text, using text', { error: result.error });
      }
      sessionStore.addChatMessage(session, 'assistant', result.text);
      // If nothing was streamed at all (e.g. streaming not supported), send full text now
      if (!anySent) {
        const chunks = splitMessage(result.text);
        for (const chunk of chunks) {
          await sender.sendText(fromUserId, contextToken, chunk);
        }
      }
    } else if (result.error) {
      logger.error('Claude query error', { error: result.error });
      await sender.sendText(fromUserId, contextToken, 'Claude 处理请求时出错，请稍后重试。');
    } else if (!anySent) {
      await sender.sendText(fromUserId, contextToken, 'Claude 无返回内容（可能因权限被拒而终止）');
    }

    // Update session with new SDK session ID
    session.sdkSessionId = result.sessionId || undefined;
    saveSessionSafely(sessionStore, account.accountId, session, 'save sendToClaude session id');

    // Auto-push deliverable files mentioned in Claude's response
    if (result.text) {
      const cwd = (session.workingDirectory || config.workingDirectory).replace(/^~/, homedir());
      const detectedPaths = extractFilePathsFromText(result.text, cwd);
      const { existsSync, statSync: fstatSync, readdirSync: freaddirSync } = await import('node:fs');
      const { extname: fextname } = await import('node:path');

      // Expand directories and filter by extension
      const pushable: string[] = [];
      for (const p of detectedPaths) {
        if (!existsSync(p)) continue;
        const st = fstatSync(p);
        if (st.isDirectory()) {
          // Scan directory for sendable files
          try {
            for (const entry of freaddirSync(p)) {
              const full = `${p}/${entry}`;
              const ext = fextname(entry).toLowerCase();
              if (AUTO_PUSH_EXTENSIONS.has(ext) && existsSync(full) && fstatSync(full).isFile()) {
                pushable.push(full);
              }
            }
          } catch { /* skip unreadable dirs */ }
        } else if (st.isFile()) {
          const ext = fextname(p).toLowerCase();
          if (AUTO_PUSH_EXTENSIONS.has(ext)) pushable.push(p);
        }
      }

      if (pushable.length > 0) {
        const { sent, failed: failedFiles } = await sender.sendFiles(fromUserId, contextToken, pushable);
        if (failedFiles.length > 0) {
          logger.error('File delivery failed after retries', { files: failedFiles });
          await sender.sendText(fromUserId, contextToken, `文件推送失败（服务端限频），请稍后重试。`).catch(() => {});
        }
      }
    }
  } catch (err) {
    const isAbort = err instanceof Error && (err.name === 'AbortError' || err.message.includes('abort'));
    if (isAbort) {
      // Query was cancelled by a new incoming message — exit silently
      logger.info('Claude query aborted by new message');
    } else {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error('Error in sendToClaude', { error: errorMsg });
      await sender.sendText(fromUserId, contextToken, '处理消息时出错，请稍后重试。');
    }
  } finally {
    clearInterval(flushTimer);
    stopTyping();
    // Clean up any lingering pending approval for this account (e.g. query ended/aborted mid-prompt).
    resolveApproval(account.accountId, 'deny', '对话已结束');
    resetSessionStateSafely(sessionStore, account.accountId, session, 'sendToClaude finally');
    // Clean up the abort controller if it's still ours
    if (activeControllers.get(account.accountId) === abortController) {
      activeControllers.delete(account.accountId);
    }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const command = process.argv[2];

if (command === 'setup') {
  runSetup().catch((err) => {
    logger.error('Setup failed', { error: err instanceof Error ? err.message : String(err) });
    console.error('设置失败:', err);
    process.exit(1);
  });
} else {
  // 'start' or no argument
  runDaemon().catch((err) => {
    logger.error('Daemon start failed', { error: err instanceof Error ? err.message : String(err) });
    console.error('启动失败:', err);
    process.exit(1);
  });
}

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Version detection — cache result so we only spawn `claude --version` once
// ---------------------------------------------------------------------------

const CLAUDE_VERSION_TTL_MS = 60 * 60 * 1000;

let _claudeVersionCache: { value: number[]; expiresAt: number } | null = null;

export function invalidateClaudeVersionCache(): void {
  // Fix for issue 6: allow manual cache refresh so long-running daemons do not
  // keep using a stale `claude --version` result after the CLI is upgraded.
  _claudeVersionCache = null;
}

function getClaudeVersion(): number[] {
  const now = Date.now();
  // Fix for issue 6: add a TTL so the module-level cache expires and refreshes
  // even if the process stays alive for a long time.
  if (_claudeVersionCache && _claudeVersionCache.expiresAt > now) {
    return _claudeVersionCache.value;
  }

  let value: number[];
  try {
    const r = spawnSync('claude', ['--version'], { encoding: 'utf8' });
    const m = (r.stdout || '').match(/(\d+)\.(\d+)\.(\d+)/);
    value = m ? [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])] : [0, 0, 0];
  } catch {
    value = [0, 0, 0];
  }

  _claudeVersionCache = { value, expiresAt: now + CLAUDE_VERSION_TTL_MS };
  return value;
}

function versionAtLeast(major: number, minor: number, patch: number): boolean {
  const [ma, mi, pa] = getClaudeVersion();
  if (ma !== major) return ma > major;
  if (mi !== minor) return mi > minor;
  return pa >= patch;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface QueryOptions {
  prompt: string;
  cwd: string;
  resume?: string;
  model?: string;
  effort?: string;
  advisor?: string;
  addDirs?: string[];
  systemPrompt?: string;
  images?: Array<{
    type: "image";
    source: { type: "base64"; media_type: string; data: string };
  }>;
  /** Called each time an assistant text chunk is produced (e.g. before/after tool calls). */
  onText?: (text: string) => Promise<void> | void;
  /** Called when a content block ends — use to flush buffered text. */
  onBlockEnd?: () => Promise<void> | void;
  /** Optional abort controller to cancel the query (e.g. when user sends a new message). */
  abortController?: AbortController;
}

export interface QueryResult {
  text: string;
  sessionId: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEMP_DIR = join(tmpdir(), 'wechat-claude-code');
const QUERY_TIMEOUT_MS = 60 * 60 * 1000;
const FORCE_KILL_AFTER_MS = 5 * 1000;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const RETAIN_TEXT_BYTES = 500 * 1024;

function saveImageTemp(images: NonNullable<QueryOptions['images']>): string[] {
  mkdirSync(TEMP_DIR, { recursive: true });
  const paths: string[] = [];
  for (const img of images) {
    const ext = img.source.media_type.split('/')[1] || 'png';
    const fileName = `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const filePath = join(TEMP_DIR, fileName);
    writeFileSync(filePath, Buffer.from(img.source.data, 'base64'));
    paths.push(filePath);
  }
  return paths;
}

function cleanupTempFiles(paths: string[]): void {
  for (const p of paths) {
    try { unlinkSync(p); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

export async function claudeQuery(options: QueryOptions): Promise<QueryResult> {
  const {
    prompt,
    cwd,
    resume,
    model,
    effort,
    advisor,
    addDirs,
    systemPrompt,
    images,
    onText,
    onBlockEnd,
    abortController,
  } = options;

  logger.info("Starting Claude CLI query", {
    cwd,
    model,
    effort,
    resume: !!resume,
    hasImages: !!images?.length,
  });

  // Build CLI arguments
  const args: string[] = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--dangerously-skip-permissions',
  ];

  if (resume) args.push('--resume', resume);
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  // --advisor requires v2.1.170+ (server-side tool, not available on older builds)
  if (advisor && versionAtLeast(2, 1, 170)) args.push('--advisor', advisor);
  if (addDirs && addDirs.length > 0) args.push('--add-dir', ...addDirs);
  if (systemPrompt) args.push('--append-system-prompt', systemPrompt);

  // Build stream-json user message (supports text + images)
  const contentBlocks: any[] = [{ type: 'text', text: prompt }];
  if (images && images.length > 0) {
    for (const img of images) {
      contentBlocks.push(img);
    }
  }
  const streamJsonMessage = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: contentBlocks },
  });

  const tempImagePaths: string[] = []; // kept for cleanup compat, no longer used for images

  // Accumulators
  let sessionId = '';
  const textParts: string[] = [];
  let textPartsBytes = 0;
  let textTruncated = false;
  let errorMessage: string | undefined;
  let child: ChildProcess | undefined;
  let settled = false;

  return new Promise<QueryResult>((resolve) => {
    let timeoutId: NodeJS.Timeout | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let abortListenerRegistered = false;
    let stdoutClosed = false;
    let stderrClosed = false;

    const appendTextPart = (text: string) => {
      if (!text) return;
      textParts.push(text);
      textPartsBytes += Buffer.byteLength(text, 'utf8');

      // Fix for issue 5: bound in-memory transcript growth. Keep only the tail
      // once the buffer exceeds 2MB and log the truncation warning once.
      if (textPartsBytes <= MAX_TEXT_BYTES) return;

      const retained: string[] = [];
      let retainedBytes = 0;
      for (let i = textParts.length - 1; i >= 0; i -= 1) {
        const part = textParts[i];
        retained.unshift(part);
        retainedBytes += Buffer.byteLength(part, 'utf8');
        if (retainedBytes >= RETAIN_TEXT_BYTES) break;
      }

      textParts.length = 0;
      textParts.push(...retained);
      textPartsBytes = retainedBytes;

      if (!textTruncated) {
        textTruncated = true;
        logger.warn('Claude CLI text buffer truncated to cap memory growth', {
          maxBytes: MAX_TEXT_BYTES,
          retainedBytes: textPartsBytes,
        });
      }
    };

    const cleanup = () => {
      if (abortListenerRegistered) {
        abortController?.signal.removeEventListener('abort', onAbort);
        abortListenerRegistered = false;
      }
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
        forceKillTimer = undefined;
      }
      cleanupTempFiles(tempImagePaths);
    };

    const finish = (result: QueryResult) => {
      // Fix for issue 3: timeout/abort/close/error can race. Guard finalization
      // so resolve happens exactly once and shared resources clean up once.
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const requestChildTermination = (reason: 'timeout' | 'abort' | 'error') => {
      // Fix for issue 1: always terminate the child on every failure path, and
      // escalate from SIGTERM to SIGKILL if it does not exit promptly.
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      try {
        child.kill('SIGTERM');
      } catch (err) {
        logger.warn('Failed to send SIGTERM to Claude CLI child', {
          reason,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (!forceKillTimer) {
        forceKillTimer = setTimeout(() => {
          if (!child || child.exitCode !== null || child.signalCode !== null) return;
          try {
            logger.warn('Claude CLI child did not exit after SIGTERM, sending SIGKILL', { reason });
            child.kill('SIGKILL');
          } catch (err) {
            logger.warn('Failed to send SIGKILL to Claude CLI child', {
              reason,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }, FORCE_KILL_AFTER_MS);
      }
    };

    const safeSendInput = (input: string) => {
      const stdin = child?.stdin;
      if (!stdin) return;

      // Fix for issue 2: stdin writes can throw or emit EPIPE if the child exits
      // before consuming input, so guard both synchronous and async paths.
      stdin.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code !== 'EPIPE' && err.code !== 'ERR_STREAM_DESTROYED') {
          logger.warn('Claude CLI stdin stream errored', {
            code: err.code,
            message: err.message,
          });
        }
      });

      try {
        stdin.write(input);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn('Claude CLI stdin write failed', { message });
      }

      try {
        stdin.end();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn('Claude CLI stdin end failed', { message });
      }
    };

    try {
      child = spawn('claude', args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      finish({ text: '', sessionId: '', error: `Failed to spawn claude: ${msg}` });
      return;
    }

    // Fix for issue 2: never write to stdin without broken-pipe protection.
    safeSendInput(streamJsonMessage + '\n');

    // Timeout
    timeoutId = setTimeout(() => {
      logger.warn('Claude CLI query timed out, killing process');
      requestChildTermination('timeout');
      const partialText = textParts.join('\n').trim();
      finish({
        text: partialText,
        sessionId,
        error: partialText ? undefined : 'Claude query timed out after 60 minutes',
      });
    }, QUERY_TIMEOUT_MS);

    // Abort handling
    const onAbort = () => {
      logger.info('Claude CLI query aborted');
      requestChildTermination('abort');
      const partialText = textParts.join('\n').trim();
      finish({ text: partialText, sessionId });
    };
    abortController?.signal.addEventListener('abort', onAbort, { once: true });
    abortListenerRegistered = !!abortController;

    // Collect stderr
    const stderrParts: string[] = [];
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      stderrParts.push(chunk);
    });
    child.stderr!.on('error', (err: Error) => {
      logger.warn('Claude CLI stderr stream errored', { message: err.message });
      if (!errorMessage) errorMessage = `Claude stderr stream error: ${err.message}`;
    });
    child.stderr!.on('close', () => {
      // Fix for issue 4: record stream shutdowns so abnormal stdout/stderr
      // closure is visible in logs and still converges on the child close path.
      stderrClosed = true;
    });

    // Parse NDJSON from stdout
    let skillInputAccum = '';
    let trackingSkill = false;

    const rl = createInterface({ input: child.stdout! });
    child.stdout!.on('error', (err: Error) => {
      logger.warn('Claude CLI stdout stream errored', { message: err.message });
      if (!errorMessage) errorMessage = `Claude stdout stream error: ${err.message}`;
    });
    child.stdout!.on('close', () => {
      stdoutClosed = true;
    });
    rl.on('line', (line: string) => {
      if (!line.trim()) return;
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        // Fix for issue 4: malformed NDJSON should not hang the query. Skip the
        // line and rely on stream/process close handlers for final settlement.
        return;
      }

      switch (obj.type) {
        case 'system': {
          if (obj.subtype === 'init' && obj.session_id) {
            sessionId = obj.session_id;
          }
          // compact completed — treat empty result as success
          if (obj.subtype === 'compact_boundary') {
            const pre = obj.compact_metadata?.pre_tokens ?? 0;
            const post = obj.compact_metadata?.post_tokens ?? 0;
            if (pre > 0) {
              appendTextPart(`__compact__:${pre}:${post}`);
            }
          }
          break;
        }
        case 'assistant': {
          const content = obj.message?.content;
          if (Array.isArray(content)) {
            const text = content
              .filter((b: any) => b.type === 'text')
              .map((b: any) => b.text ?? '')
              .join('');
            if (text) appendTextPart(text);
          }
          break;
        }
        case 'stream_event': {
          const evt = obj.event;
          if (evt?.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
            if (evt.content_block.name === 'Skill') {
              trackingSkill = true;
              skillInputAccum = '';
            }
          } else if (evt?.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
            const delta: string = evt.delta.text;
            if (delta && onText) {
              Promise.resolve(onText(delta)).catch(() => {});
            }
          } else if (evt?.type === 'content_block_delta' && evt.delta?.type === 'input_json_delta' && trackingSkill) {
            skillInputAccum += evt.delta.partial_json ?? '';
            try {
              const parsed = JSON.parse(skillInputAccum);
              if (parsed.skill) {
                const msg = `\n正在调用 ${parsed.skill} 技能\n\n`;
                if (onText) Promise.resolve(onText(msg)).catch(() => {});
                trackingSkill = false;
              }
            } catch {
              // JSON not complete yet, keep accumulating
            }
          } else if (evt?.type === 'content_block_stop') {
            trackingSkill = false;
            if (onBlockEnd) Promise.resolve(onBlockEnd()).catch(() => {});
          }
          break;
        }
        case 'result': {
          if (obj.result && typeof obj.result === 'string') {
            const combined = textParts.join('');
            if (!combined.includes(obj.result)) {
              appendTextPart(obj.result);
            }
          }
          if (obj.subtype === 'error' || (obj.errors && obj.errors.length > 0)) {
            const errors = obj.errors ?? [obj.error_message ?? 'Unknown error'];
            errorMessage = Array.isArray(errors) ? errors.join('; ') : String(errors);
            logger.error('CLI returned error result', { errors });
          }
          break;
        }
        default:
          break;
      }
    });
    rl.on('close', () => {
      stdoutClosed = true;
    });

    // Handle process exit
    child.on('close', (code: number | null) => {
      if (code !== 0 && code !== null && !textParts.length && !errorMessage) {
        const stderr = stderrParts.join('').trim();
        errorMessage = stderr || `claude exited with code ${code}`;
        logger.error('Claude CLI exited with error', { code, stderr: stderr.slice(0, 500) });
      }

      const fullText = textParts.join('\n').trim();

      if (!fullText && !errorMessage) {
        errorMessage = 'Claude returned an empty response.';
      }

      logger.info("Claude CLI query completed", {
        sessionId,
        textLength: fullText.length,
        hasError: !!errorMessage,
        stdoutClosed,
        stderrClosed,
      });

      finish({
        text: fullText,
        sessionId,
        error: errorMessage,
      });
    });

    child.on('error', (err: Error) => {
      // Fix for issues 1 and 3: process error can race with timeout/abort/close.
      // Terminate the child if it exists, then settle exactly once.
      requestChildTermination('error');
      finish({ text: '', sessionId, error: `Failed to spawn claude: ${err.message}` });
    });
  });
}

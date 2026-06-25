import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import type { MessageItem } from './types.js';
import { downloadAndDecrypt } from './cdn.js';
import { logger } from '../logger.js';

const MLX_WHISPER_MODEL = 'mlx-community/whisper-large-v3-mlx';
const FASTER_WHISPER_MODEL = process.env.WCC_FASTER_WHISPER_MODEL || 'large-v3';
const SILK_TIMEOUT_MS = 30_000;
const FFMPEG_TIMEOUT_MS = 30_000;
const WHISPER_TIMEOUT_MS = 180_000;
const NEGATIVE_BINARY_CACHE_MS = 60_000;
const MAX_VOICE_DOWNLOAD_SIZE = 25 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 64 * 1024;
const MAX_TRANSCRIPT_CHARS = 4000;
const MAX_STDERR_CHARS = 4000;

type WhisperBackend =
  | { kind: 'mlx'; command: string }
  | { kind: 'python-faster-whisper'; command: string };

interface BinaryProbeCache<T = string | null> {
  value: T | undefined;
  checkedAt: number;
}

function isFreshMiss<T>(cache: BinaryProbeCache<T | null>): boolean {
  return cache.value === null && Date.now() - cache.checkedAt < NEGATIVE_BINARY_CACHE_MS;
}

function expandWindowsPythonRoots(paths: string[]): string[] {
  return paths.flatMap((base) => ([
    join(base, 'python.exe'),
    join(base, 'Scripts', 'python.exe'),
  ]));
}

/** Probe a list of candidate paths, returning the first that runs the check args. */
function resolveBinary(candidates: string[], checkArgs: string[]): string | null {
  for (const bin of candidates) {
    try {
      const r = spawnSync(bin, checkArgs, {
        stdio: 'ignore',
        windowsHide: process.platform === 'win32',
      });
      if (r.error === undefined && (r.status === 0 || r.status === null)) {
        return bin;
      }
    } catch {
      // Try next candidate.
    }
  }
  return null;
}

let pythonCache: BinaryProbeCache = { value: undefined, checkedAt: 0 };
function findPython(): string | null {
  if (pythonCache.value) return pythonCache.value;
  if (isFreshMiss(pythonCache)) return null;

  const windowsPythonCandidates = process.platform === 'win32'
    ? [
        ...expandWindowsPythonRoots([
          join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Python', 'Python313'),
          join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Python', 'Python312'),
          join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Python', 'Python311'),
          join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Python', 'Python310'),
          join(homedir(), 'miniforge3'),
          join(homedir(), 'miniconda3'),
          join(homedir(), 'anaconda3'),
        ]),
        'py',
        'python',
        'python3',
      ]
    : [];

  const candidates = [
    ...windowsPythonCandidates,
    join(homedir(), 'miniforge3', 'bin', 'python3'),
    join(homedir(), 'miniconda3', 'bin', 'python3'),
    join(homedir(), 'anaconda3', 'bin', 'python3'),
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3',
    '/usr/bin/python3',
    'python3',
    'python',
  ];

  for (const py of candidates) {
    try {
      const args = py === 'py' ? ['-3', '-c', 'import pilk'] : ['-c', 'import pilk'];
      const r = spawnSync(py, args, {
        stdio: 'ignore',
        windowsHide: process.platform === 'win32',
      });
      if (r.status === 0) {
        pythonCache = { value: py, checkedAt: Date.now() };
        logger.info('Found python with pilk', { python: py });
        return py;
      }
    } catch {
      // Try next candidate.
    }
  }

  logger.warn('No python with pilk found — voice transcription unavailable');
  pythonCache = { value: null, checkedAt: Date.now() };
  return null;
}

let whisperBackendCache: BinaryProbeCache<WhisperBackend | null> = { value: undefined, checkedAt: 0 };
function findWhisperBackend(python: string | null): WhisperBackend | null {
  if (whisperBackendCache.value) return whisperBackendCache.value;
  if (isFreshMiss(whisperBackendCache)) return null;

  if (process.platform !== 'win32') {
    const mlxWhisper = resolveBinary([
      join(homedir(), 'miniforge3', 'bin', 'mlx_whisper'),
      join(homedir(), 'miniconda3', 'bin', 'mlx_whisper'),
      join(homedir(), 'anaconda3', 'bin', 'mlx_whisper'),
      '/opt/homebrew/bin/mlx_whisper',
      '/usr/local/bin/mlx_whisper',
      'mlx_whisper',
    ], ['--help']);
    if (mlxWhisper) {
      const backend: WhisperBackend = { kind: 'mlx', command: mlxWhisper };
      whisperBackendCache = { value: backend, checkedAt: Date.now() };
      logger.info('Found mlx_whisper', { path: mlxWhisper });
      return backend;
    }
  }

  if (python) {
    try {
      const args = python === 'py'
        ? ['-3', '-c', 'from faster_whisper import WhisperModel']
        : ['-c', 'from faster_whisper import WhisperModel'];
      const r = spawnSync(python, args, {
        stdio: 'ignore',
        windowsHide: process.platform === 'win32',
      });
      if (r.status === 0) {
        const backend: WhisperBackend = { kind: 'python-faster-whisper', command: python };
        whisperBackendCache = {
          value: backend,
          checkedAt: Date.now(),
        };
        logger.info('Found faster-whisper python backend', { python });
        return backend;
      }
    } catch {
      // Fall through.
    }
  }

  logger.warn('No whisper backend found — voice transcription unavailable');
  whisperBackendCache = { value: null, checkedAt: Date.now() };
  return null;
}

let ffmpegCache: BinaryProbeCache = { value: undefined, checkedAt: 0 };
function findFfmpeg(): string | null {
  if (ffmpegCache.value) return ffmpegCache.value;
  if (isFreshMiss(ffmpegCache)) return null;

  const windowsCandidates = process.platform === 'win32'
    ? [
        join('C:\\ffmpeg', 'bin', 'ffmpeg.exe'),
        join(homedir(), 'scoop', 'shims', 'ffmpeg.exe'),
        join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
        'ffmpeg.exe',
      ]
    : [];

  const ffmpeg = resolveBinary([
    ...windowsCandidates,
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg',
    join(homedir(), 'miniforge3', 'bin', 'ffmpeg'),
    'ffmpeg',
  ], ['-version']);

  ffmpegCache = { value: ffmpeg, checkedAt: Date.now() };
  if (ffmpeg) logger.info('Found ffmpeg', { path: ffmpeg });
  else logger.warn('ffmpeg not found — voice transcription unavailable');
  return ffmpeg;
}

function pythonCommandArgs(python: string, args: string[]): string[] {
  return python === 'py' ? ['-3', ...args] : args;
}

/** Run a command with a timeout; resolves on exit 0, rejects on spawn error/timeout/non-zero. */
function runCommand(cmd: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: process.platform === 'win32',
    });
    let settled = false;
    let timedOut = false;
    let stderrText = '';

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      const killed = child.kill('SIGKILL');
      if (!killed && child.exitCode !== null) {
        finish(() => reject(new Error(`${cmd} timed out after ${timeoutMs}ms`)));
      }
    }, timeoutMs);

    child.stderr?.on('data', (chunk) => {
      if (stderrText.length < MAX_STDERR_CHARS) {
        stderrText += String(chunk).slice(0, MAX_STDERR_CHARS - stderrText.length);
      }
    });
    child.on('error', (err) => {
      finish(() => reject(timedOut ? new Error(`${cmd} timed out after ${timeoutMs}ms`) : err));
    });
    child.on('close', (code, signal) => {
      finish(() => {
        if (timedOut) {
          reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
          return;
        }
        if (code === 0) resolve();
        else reject(new Error(`${cmd} exited with code ${code ?? 'null'}${signal ? ` signal ${signal}` : ''}: ${stderrText.slice(0, 300)}`));
      });
    });
  });
}

function limitTranscript(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.length <= MAX_TRANSCRIPT_CHARS) return trimmed;
  logger.warn('Voice transcript truncated', { length: trimmed.length, max: MAX_TRANSCRIPT_CHARS });
  return `${trimmed.slice(0, MAX_TRANSCRIPT_CHARS)}\n\n[语音转写过长，已截断]`;
}

function getVoiceCdnData(item: MessageItem): { aesKey: string; encryptQueryParam: string } | null {
  const voice = item.voice_item;
  if (voice?.media?.aes_key && voice.media.encrypt_query_param) {
    return { aesKey: voice.media.aes_key, encryptQueryParam: voice.media.encrypt_query_param };
  }
  logger.warn('Voice item has no usable CDN data');
  return null;
}

function buildFasterWhisperScript(workDir: string): string {
  const normalizedDir = workDir.replace(/\\/g, '\\\\');
  return [
    'import os',
    'from faster_whisper import WhisperModel',
    `work_dir = r"${normalizedDir}"`,
    `model = WhisperModel(${JSON.stringify(FASTER_WHISPER_MODEL)}, device="auto", compute_type="auto")`,
    'segments, _ = model.transcribe(os.path.join(work_dir, "voice.wav"), language="zh")',
    'text = "".join(segment.text for segment in segments).strip()',
    'with open(os.path.join(work_dir, "voice.txt"), "w", encoding="utf-8") as f:',
    '    f.write(text)',
  ].join('\n');
}

async function runWhisperBackend(backend: WhisperBackend, workDir: string, wavPath: string): Promise<void> {
  if (backend.kind === 'mlx') {
    await runCommand(backend.command, [
      wavPath,
      '--model', MLX_WHISPER_MODEL,
      '--language', 'zh',
      '--output-format', 'txt',
      '--output-dir', workDir,
      '--output-name', 'voice',
      '--verbose', 'False',
    ], WHISPER_TIMEOUT_MS);
    return;
  }

  const script = buildFasterWhisperScript(workDir);
  await runCommand(backend.command, pythonCommandArgs(backend.command, ['-c', script]), WHISPER_TIMEOUT_MS);
}

/**
 * Download a WeChat voice message, transcribe it locally, and return the recognized text.
 * Returns null when dependencies are missing or any step fails.
 */
export async function transcribeVoice(item: MessageItem): Promise<string | null> {
  const cdnData = getVoiceCdnData(item);
  if (!cdnData) return null;

  const python = findPython();
  if (!python) return null;
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) return null;
  const whisperBackend = findWhisperBackend(python);
  if (!whisperBackend) return null;

  const workDir = mkdtempSync(join(tmpdir(), 'wcc-voice-'));
  const silkPath = join(workDir, 'voice.silk');
  const pcmPath = join(workDir, 'voice.pcm');
  const wavPath = join(workDir, 'voice.wav');

  try {
    const decrypted = await downloadAndDecrypt(cdnData.encryptQueryParam, cdnData.aesKey);
    if (decrypted.length > MAX_VOICE_DOWNLOAD_SIZE) {
      throw new Error(`Voice download too large: ${Math.round(decrypted.length / 1024 / 1024)}MB exceeds ${Math.round(MAX_VOICE_DOWNLOAD_SIZE / 1024 / 1024)}MB limit`);
    }
    writeFileSync(silkPath, decrypted);

    await runCommand(python, pythonCommandArgs(python, [
      '-c',
      'import sys,pilk; pilk.decode(sys.argv[1], sys.argv[2], pcm_rate=16000)',
      silkPath, pcmPath,
    ]), SILK_TIMEOUT_MS);

    await runCommand(ffmpeg, [
      '-y', '-f', 's16le', '-ar', '16000', '-ac', '1', '-i', pcmPath, wavPath,
    ], FFMPEG_TIMEOUT_MS);

    await runWhisperBackend(whisperBackend, workDir, wavPath);

    const txtPath = join(workDir, 'voice.txt');
    if (!existsSync(txtPath)) {
      logger.warn('Whisper produced no output file');
      return null;
    }

    const txtSize = statSync(txtPath).size;
    if (txtSize > MAX_TRANSCRIPT_BYTES) {
      throw new Error(`Whisper output too large: ${txtSize} bytes exceeds ${MAX_TRANSCRIPT_BYTES} byte limit`);
    }

    const text = limitTranscript(readFileSync(txtPath, 'utf-8'));
    logger.info('Voice transcribed', {
      backend: whisperBackend.kind,
      length: text?.length ?? 0,
    });
    return text;
  } catch (err) {
    logger.warn('Voice transcription failed', { error: err instanceof Error ? err.message : String(err) });
    return null;
  } finally {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

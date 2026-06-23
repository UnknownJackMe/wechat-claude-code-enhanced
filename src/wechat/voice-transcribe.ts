import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import type { MessageItem } from './types.js';
import { downloadAndDecrypt } from './cdn.js';
import { logger } from '../logger.js';

const WHISPER_MODEL = 'mlx-community/whisper-large-v3-mlx';
const SILK_TIMEOUT_MS = 30_000;
const FFMPEG_TIMEOUT_MS = 30_000;
const WHISPER_TIMEOUT_MS = 120_000;
const NEGATIVE_BINARY_CACHE_MS = 60_000;
const MAX_VOICE_DOWNLOAD_SIZE = 25 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 64 * 1024;
const MAX_TRANSCRIPT_CHARS = 4000;
const MAX_STDERR_CHARS = 4000;

// WeChat voice is SILK v3 (encode_type 4) — ffmpeg can't decode it directly.
// We decode SILK → PCM with the `pilk` Python package, then ffmpeg wraps it to wav.
// launchd's PATH differs from the shell, so we resolve every external binary to an
// absolute path by probing known locations rather than relying on PATH lookup.

interface BinaryProbeCache {
  value: string | null | undefined;
  checkedAt: number;
}

function isFreshMiss(cache: BinaryProbeCache): boolean {
  return cache.value === null && Date.now() - cache.checkedAt < NEGATIVE_BINARY_CACHE_MS;
}

/** Probe a list of candidate paths, returning the first that runs `--probe`-style check. */
function resolveBinary(candidates: string[], checkArgs: string[]): string | null {
  for (const bin of candidates) {
    try {
      const r = spawnSync(bin, checkArgs, { stdio: 'ignore' });
      // status 0 (or null for tools that don't support the probe arg but exist) → usable
      if (r.error === undefined && (r.status === 0 || r.status === null)) {
        return bin;
      }
    } catch { /* try next */ }
  }
  return null;
}

let pythonCache: BinaryProbeCache = { value: undefined, checkedAt: 0 };
function findPython(): string | null {
  if (pythonCache.value) return pythonCache.value;
  if (isFreshMiss(pythonCache)) return null;
  const candidates = [
    join(homedir(), 'miniforge3', 'bin', 'python3'),
    join(homedir(), 'miniconda3', 'bin', 'python3'),
    join(homedir(), 'anaconda3', 'bin', 'python3'),
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3',
    '/usr/bin/python3',
    'python3',
  ];
  for (const py of candidates) {
    try {
      const r = spawnSync(py, ['-c', 'import pilk'], { stdio: 'ignore' });
      if (r.status === 0) {
        pythonCache = { value: py, checkedAt: Date.now() };
        logger.info('Found python with pilk', { python: py });
        return py;
      }
    } catch { /* try next */ }
  }
  logger.warn('No python with pilk found — voice transcription unavailable');
  pythonCache = { value: null, checkedAt: Date.now() };
  return null;
}

let mlxWhisperCache: BinaryProbeCache = { value: undefined, checkedAt: 0 };
function findMlxWhisper(): string | null {
  if (mlxWhisperCache.value) return mlxWhisperCache.value;
  if (isFreshMiss(mlxWhisperCache)) return null;
  const mlxWhisper = resolveBinary([
    join(homedir(), 'miniforge3', 'bin', 'mlx_whisper'),
    join(homedir(), 'miniconda3', 'bin', 'mlx_whisper'),
    join(homedir(), 'anaconda3', 'bin', 'mlx_whisper'),
    '/opt/homebrew/bin/mlx_whisper',
    '/usr/local/bin/mlx_whisper',
    'mlx_whisper',
  ], ['--help']);
  mlxWhisperCache = { value: mlxWhisper, checkedAt: Date.now() };
  if (mlxWhisper) logger.info('Found mlx_whisper', { path: mlxWhisper });
  else logger.warn('mlx_whisper not found — voice transcription unavailable');
  return mlxWhisper;
}

let ffmpegCache: BinaryProbeCache = { value: undefined, checkedAt: 0 };
function findFfmpeg(): string | null {
  if (ffmpegCache.value) return ffmpegCache.value;
  if (isFreshMiss(ffmpegCache)) return null;
  const ffmpeg = resolveBinary([
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

/** Run a command with a timeout; resolves on exit 0, rejects on spawn error/timeout/non-zero. */
function runCommand(cmd: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
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

    child.stderr?.on('data', (c) => {
      if (stderrText.length < MAX_STDERR_CHARS) {
        stderrText += String(c).slice(0, MAX_STDERR_CHARS - stderrText.length);
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

/** Extract CDN download params from a voice item. */
function getVoiceCdnData(item: MessageItem): { aesKey: string; encryptQueryParam: string } | null {
  const voice = item.voice_item;
  if (voice?.media?.aes_key && voice.media.encrypt_query_param) {
    return { aesKey: voice.media.aes_key, encryptQueryParam: voice.media.encrypt_query_param };
  }
  logger.warn('Voice item has no usable CDN data');
  return null;
}

/**
 * Download a WeChat voice message, transcribe it locally with mlx_whisper,
 * and return the recognized text. Returns null on any failure.
 *
 * Pipeline: download+decrypt → SILK v3 (pilk) → PCM → ffmpeg wav → mlx_whisper.
 */
export async function transcribeVoice(item: MessageItem): Promise<string | null> {
  const cdnData = getVoiceCdnData(item);
  if (!cdnData) return null;

  const python = findPython();
  if (!python) return null;
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) return null;
  const mlxWhisper = findMlxWhisper();
  if (!mlxWhisper) return null;

  const workDir = mkdtempSync(join(tmpdir(), 'wcc-voice-'));
  const silkPath = join(workDir, 'voice.silk');
  const pcmPath = join(workDir, 'voice.pcm');
  const wavPath = join(workDir, 'voice.wav');

  try {
    // 1. Download + decrypt → SILK file
    const decrypted = await downloadAndDecrypt(cdnData.encryptQueryParam, cdnData.aesKey);
    if (decrypted.length > MAX_VOICE_DOWNLOAD_SIZE) {
      throw new Error(`Voice download too large: ${Math.round(decrypted.length / 1024 / 1024)}MB exceeds ${Math.round(MAX_VOICE_DOWNLOAD_SIZE / 1024 / 1024)}MB limit`);
    }
    writeFileSync(silkPath, decrypted);

    // 2. SILK → PCM (16kHz) via pilk (handles Tencent's 0x02 prefix automatically)
    await runCommand(python, [
      '-c',
      'import sys,pilk; pilk.decode(sys.argv[1], sys.argv[2], pcm_rate=16000)',
      silkPath, pcmPath,
    ], SILK_TIMEOUT_MS);

    // 3. PCM → 16kHz mono wav (whisper's expected container)
    await runCommand(ffmpeg, [
      '-y', '-f', 's16le', '-ar', '16000', '-ac', '1', '-i', pcmPath, wavPath,
    ], FFMPEG_TIMEOUT_MS);

    // 4. mlx_whisper transcription (zh handles Mandarin + embedded English well)
    await runCommand(mlxWhisper, [
      wavPath,
      '--model', WHISPER_MODEL,
      '--language', 'zh',
      '--output-format', 'txt',
      '--output-dir', workDir,
      '--output-name', 'voice',
      '--verbose', 'False',
    ], WHISPER_TIMEOUT_MS);

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
    logger.info('Voice transcribed', { length: text?.length ?? 0 });
    return text;
  } catch (err) {
    logger.warn('Voice transcription failed', { error: err instanceof Error ? err.message : String(err) });
    return null;
  } finally {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import type { MessageItem } from './types.js';
import { downloadAndDecrypt } from './cdn.js';
import { logger } from '../logger.js';

const WHISPER_MODEL = 'mlx-community/whisper-large-v3-mlx';
const SILK_TIMEOUT_MS = 30_000;
const FFMPEG_TIMEOUT_MS = 30_000;
const WHISPER_TIMEOUT_MS = 120_000;

// WeChat voice is SILK v3 (encode_type 4) — ffmpeg can't decode it directly.
// We decode SILK → PCM with the `pilk` Python package, then ffmpeg wraps it to wav.
// launchd's PATH differs from the shell, so we resolve every external binary to an
// absolute path by probing known locations rather than relying on PATH lookup.

/** Probe a list of candidate paths, returning the first that runs `--probe`-style check. */
function resolveBinary(name: string, candidates: string[], checkArgs: string[]): string | null {
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

let _python: string | null | undefined;
function findPython(): string | null {
  if (_python !== undefined) return _python;
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
        _python = py;
        logger.info('Found python with pilk', { python: py });
        return py;
      }
    } catch { /* try next */ }
  }
  logger.warn('No python with pilk found — voice transcription unavailable');
  _python = null;
  return null;
}

let _mlxWhisper: string | null | undefined;
function findMlxWhisper(): string | null {
  if (_mlxWhisper !== undefined) return _mlxWhisper;
  _mlxWhisper = resolveBinary('mlx_whisper', [
    join(homedir(), 'miniforge3', 'bin', 'mlx_whisper'),
    join(homedir(), 'miniconda3', 'bin', 'mlx_whisper'),
    join(homedir(), 'anaconda3', 'bin', 'mlx_whisper'),
    '/opt/homebrew/bin/mlx_whisper',
    '/usr/local/bin/mlx_whisper',
    'mlx_whisper',
  ], ['--help']);
  if (_mlxWhisper) logger.info('Found mlx_whisper', { path: _mlxWhisper });
  else logger.warn('mlx_whisper not found — voice transcription unavailable');
  return _mlxWhisper;
}

let _ffmpeg: string | null | undefined;
function findFfmpeg(): string | null {
  if (_ffmpeg !== undefined) return _ffmpeg;
  _ffmpeg = resolveBinary('ffmpeg', [
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg',
    join(homedir(), 'miniforge3', 'bin', 'ffmpeg'),
    'ffmpeg',
  ], ['-version']);
  if (_ffmpeg) logger.info('Found ffmpeg', { path: _ffmpeg });
  else logger.warn('ffmpeg not found — voice transcription unavailable');
  return _ffmpeg;
}

/** Run a command with a timeout; resolves on exit 0, rejects on spawn error/timeout/non-zero. */
function runCommand(cmd: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let settled = false;
    const stderrParts: string[] = [];

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stderr?.on('data', (c) => stderrParts.push(String(c)));
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}: ${stderrParts.join('').slice(0, 300)}`));
    });
  });
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
    const text = readFileSync(txtPath, 'utf-8').trim();
    logger.info('Voice transcribed', { length: text.length });
    return text || null;
  } catch (err) {
    logger.warn('Voice transcription failed', { error: err instanceof Error ? err.message : String(err) });
    return null;
  } finally {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

import { decryptAesEcb } from "./crypto.js";
import { logger } from "../logger.js";
import { CDN_BASE_URL } from "../constants.js";

export function buildCdnDownloadUrl(encryptQueryParam: string): string {
  if (!/^[A-Za-z0-9%=&+._~\-/]+$/.test(encryptQueryParam)) {
    throw new Error('Invalid CDN query parameter');
  }
  return `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`;
}

export async function downloadAndDecrypt(
  encryptQueryParam: string,
  aesKeyBase64: string,
): Promise<Buffer> {
  const url = buildCdnDownloadUrl(encryptQueryParam);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`CDN download failed: ${sanitizeErrorMessage(err instanceof Error ? err.message : String(err))}`);
  }
  clearTimeout(timer);

  if (!response.ok) {
    throw new Error(`CDN download failed: ${response.status} ${response.statusText}`);
  }

  const encrypted = Buffer.from(await response.arrayBuffer());

  // Validate encrypted data is block-aligned (AES-128-ECB requires multiples of 16)
  if (encrypted.length === 0) {
    throw new Error('CDN 返回空数据');
  }
  if (encrypted.length % 16 !== 0) {
    throw new Error(`CDN 数据不完整（长度 ${encrypted.length} 不是 16 的倍数，可能传输截断）`);
  }

  // Handle both formats:
  // 1. base64-of-raw-16-bytes (16 raw bytes encoded as base64)
  // 2. base64-of-hex-string (32 hex chars encoded as base64)
  let aesKey: Buffer;
  const raw = Buffer.from(aesKeyBase64, "base64");

  if (raw.length === 16) {
    // base64-of-raw-16-bytes
    aesKey = raw;
  } else {
    // base64-of-hex-string: decode the string as hex to get the 16-byte key
    const hexStr = raw.toString("utf-8");
    aesKey = Buffer.from(hexStr, "hex");
  }

  // Validate key length before calling crypto
  if (aesKey.length !== 16) {
    throw new Error(`无效的 AES 密钥长度: ${aesKey.length} 字节（预期 16 字节）`);
  }

  try {
    const decrypted = decryptAesEcb(aesKey, encrypted);
    logger.info("CDN download and decrypt succeeded", { size: decrypted.length });
    return decrypted;
  } catch (err) {
    throw new Error(`CDN 解密失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function sanitizeErrorMessage(message: string): string {
  return message.replace(/https?:\/\/[^\s'")]+/g, (rawUrl) => {
    try {
      const url = new URL(rawUrl);
      return `${url.origin}${url.pathname}`;
    } catch {
      return rawUrl.replace(/\?.*$/, '');
    }
  });
}

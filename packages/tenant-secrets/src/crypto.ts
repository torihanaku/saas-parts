/**
 * AES-256-GCM encrypt/decrypt — dev-dashboard-v2 server/lib/token.ts の
 * encrypt/decrypt のプライベートコピー（このパッケージ内専用）。
 *
 * 元実装は env.SESSION_SECRET からモジュールロード時に鍵を導出していた。
 * ここでは secret を引数で受け取り deriveEncryptionKey で同一の導出
 * （HMAC-SHA256, ラベル "encryption-key"）を行うため、元アプリが保存した
 * ciphertext と相互運用できる。
 */
import { createHmac, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";

/** Derive a 32-byte AES key from an app secret (元: SESSION_SECRET 由来)。 */
export function deriveEncryptionKey(secret: string): Buffer {
  return createHmac("sha256", secret).update("encryption-key").digest();
}

/** Encrypt a string and return iv:authTag:ciphertext (hex)。 */
export function encryptWithKey(key: Buffer, text: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  return `${iv.toString("hex")}:${authTag}:${encrypted}`;
}

/** Decrypt a string in iv:authTag:ciphertext format. 失敗時は null。 */
export function decryptWithKey(key: Buffer, text: string): string | null {
  try {
    const [ivHex, authTagHex, encrypted] = text.split(":");
    if (!ivHex || !authTagHex || !encrypted) return null;
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch {
    return null;
  }
}

/**
 * 値が暗号文フォーマット (hex:hex:hex) に見えるか。
 * 暗号化導入以前の legacy 平文行との判別に使う。
 */
export function looksEncrypted(value: string): boolean {
  return /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/i.test(value);
}

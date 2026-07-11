/**
 * Private AES-256-GCM helpers — dev-dashboard-v2 server/lib/token.ts の
 * encrypt/decrypt をインライン移植（鍵は呼び出し側の secret から HMAC 派生）。
 * このモジュールはパッケージ内部専用で index.ts からは export しない。
 */
import { createHmac, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";

/** Derive encryption key from the caller-supplied secret. */
function deriveKey(secret: string): Buffer {
  return createHmac("sha256", secret).update("encryption-key").digest();
}

/** Encrypt a string and return iv:authTag:ciphertext */
export function encrypt(secret: string, text: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, deriveKey(secret), iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  return `${iv.toString("hex")}:${authTag}:${encrypted}`;
}

/** Decrypt a string format iv:authTag:ciphertext */
export function decrypt(secret: string, text: string): string | null {
  try {
    const [ivHex, authTagHex, encrypted] = text.split(":");
    if (!ivHex || !authTagHex || !encrypted) return null;
    const decipher = createDecipheriv(ALGORITHM, deriveKey(secret), Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch {
    return null;
  }
}

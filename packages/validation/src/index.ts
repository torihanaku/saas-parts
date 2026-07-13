/**
 * Input validation utilities for request handling.
 *
 * Ported from 実運用SaaS `server/lib/validation.ts` (zero deps).
 */

/** Validate UUID v4 format */
export function isValidUUID(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/** Validate email format (RFC 5322 simplified) */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

const BODY_BYTE_ENCODER = new TextEncoder();

/** Validate request body size (returns parsed body or null) */
export async function parseBodyWithLimit(req: Request, maxBytes: number = 1_048_576): Promise<Record<string, unknown> | null> {
  const contentLength = req.headers.get("Content-Length");
  if (contentLength && parseInt(contentLength) > maxBytes) return null;
  try {
    const text = await req.text();
    // Enforce the limit in BYTES, not UTF-16 code units. `text.length` counts
    // code units, so a body of multibyte UTF-8 characters (e.g. emoji, CJK)
    // could be up to ~4x the intended byte budget yet still pass a naive
    // `text.length > maxBytes` check — a body-size-limit bypass / DoS vector.
    if (BODY_BYTE_ENCODER.encode(text).length > maxBytes) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Return 400 error response for validation failures */
export function validationError(message: string): Response {
  return Response.json({ error: message, code: "VALIDATION_ERROR" }, { status: 400 });
}

/** Return 500 error response for database operation failures */
export function dbError(message: string, details?: string): Response {
  return Response.json({ error: message, code: "DB_ERROR", ...(details && { details }) }, { status: 500 });
}

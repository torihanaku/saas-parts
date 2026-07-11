/**
 * Input validation utilities for request handling.
 *
 * Ported from dev-dashboard-v2 `server/lib/validation.ts` (zero deps).
 */

/** Validate UUID v4 format */
export function isValidUUID(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/** Validate email format (RFC 5322 simplified) */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

/** Validate request body size (returns parsed body or null) */
export async function parseBodyWithLimit(req: Request, maxBytes: number = 1_048_576): Promise<Record<string, unknown> | null> {
  const contentLength = req.headers.get("Content-Length");
  if (contentLength && parseInt(contentLength) > maxBytes) return null;
  try {
    const text = await req.text();
    if (text.length > maxBytes) return null;
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

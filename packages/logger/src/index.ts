/**
 * Centralized logging utility with PII sanitization + request context.
 *
 * - sanitize(): strips emails, tokens/secrets, and UUIDs from log output
 *   (regex patterns preserved exactly from the source implementation)
 * - logError/logWarn/logInfo: structured JSON logs (GCP severity format)
 * - Error sink: the source lazily forwarded errors to Sentry when
 *   SENTRY_DSN was set; here the sink is an injected optional callback
 *   (no @sentry import, no process.env reads)
 * - Request context: AsyncLocalStorage-based requestId/userId/startTime
 *   propagation; log lines auto-include requestId when a context is active
 *
 * Ported from 実運用SaaS server/lib/logger.ts + server/lib/context.ts.
 */
import { AsyncLocalStorage } from "node:async_hooks";

// ---------------------------------------------------------------------------
// Request context (from server/lib/context.ts)
// ---------------------------------------------------------------------------

/** Request context for tracing and logging */
export interface RequestContext {
  requestId: string;
  userId?: string;
  startTime: number;
}

/** Global storage for request context */
export const requestContext = new AsyncLocalStorage<RequestContext>();

/** Get current request ID or generate a new one if not in context */
export function getRequestId(): string {
  return requestContext.getStore()?.requestId || crypto.randomUUID();
}

/** Read the current request context (undefined outside a run). */
export function getRequestContext(): RequestContext | undefined {
  return requestContext.getStore();
}

/**
 * Run `fn` with the given request context bound for the whole async subtree.
 * Missing fields are filled with defaults (random requestId, Date.now()).
 */
export function runWithRequestContext<T>(
  ctx: Partial<RequestContext>,
  fn: () => T
): T {
  const full: RequestContext = {
    requestId: ctx.requestId ?? crypto.randomUUID(),
    startTime: ctx.startTime ?? Date.now(),
    ...(ctx.userId !== undefined ? { userId: ctx.userId } : {}),
  };
  return requestContext.run(full, fn);
}

// ---------------------------------------------------------------------------
// PII sanitization (from server/lib/logger.ts — patterns preserved exactly)
// ---------------------------------------------------------------------------

/** Sanitize PII patterns from log messages */
export function sanitize(msg: string): string {
  return msg
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "[EMAIL]")
    .replace(/(Bearer|token|secret|apiKey|api_key|password|session)['":\s=]*[^\s,}"']{8,}/gi, "$1=[REDACTED]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[UUID]");
}

// ---------------------------------------------------------------------------
// Error sink (replaces the lazy Sentry integration — injection point)
// ---------------------------------------------------------------------------

/**
 * Optional error sink. In the source this was
 * `Sentry.captureException(error, { extra: { context } })` gated on
 * SENTRY_DSN; wire your own reporter here instead.
 */
export type ErrorSink = (error: Error, extra: { context: string }) => void;

let errorSink: ErrorSink | null = null;

/** Inject (or clear with null) the error sink called by logError. */
export function setErrorSink(sink: ErrorSink | null): void {
  errorSink = sink;
}

// ---------------------------------------------------------------------------
// Structured loggers
// ---------------------------------------------------------------------------

interface LogEntry {
  severity: "ERROR" | "WARNING" | "INFO";
  context: string;
  message: string;
  requestId?: string;
}

function buildEntry(
  severity: LogEntry["severity"],
  context: string,
  message: string
): LogEntry {
  const entry: LogEntry = { severity, context, message: sanitize(message) };
  const requestId = requestContext.getStore()?.requestId;
  if (requestId) entry.requestId = requestId;
  return entry;
}

export function logError(context: string, error: unknown): void {
  const msg = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify(buildEntry("ERROR", context, msg)));
  if (errorSink) {
    errorSink(error instanceof Error ? error : new Error(msg), { context });
  }
}

export function logWarn(context: string, message: string): void {
  console.warn(JSON.stringify(buildEntry("WARNING", context, message)));
}

export function logInfo(context: string, message: string): void {
  console.log(JSON.stringify(buildEntry("INFO", context, message)));
}

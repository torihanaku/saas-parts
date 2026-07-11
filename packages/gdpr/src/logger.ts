/**
 * Minimal logger boundary — replaces the source's `server/lib/logger`
 * (logInfo / logWarn / logError). Defaults to console; inject your own.
 */
export interface GdprLogger {
  info(scope: string, message: string): void;
  warn(scope: string, message: string): void;
  error(scope: string, error: Error | string): void;
}

export const consoleGdprLogger: GdprLogger = {
  info: (scope, message) => console.info(`[${scope}] ${message}`),
  warn: (scope, message) => console.warn(`[${scope}] ${message}`),
  error: (scope, error) => console.error(`[${scope}]`, error),
};

export const silentGdprLogger: GdprLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

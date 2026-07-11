import { isAbsolute, relative, resolve } from "node:path";

/**
 * Path-traversal-safe join: resolves `requestPath` (URL-decoded) under `rootDir`
 * and returns the absolute path, or null when the result escapes the root.
 */
export function safeJoin(rootDir: string, requestPath: string): string | null {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(requestPath);
  } catch {
    return null;
  }

  const root = resolve(rootDir);
  const target = resolve(root, decodedPath.replace(/^[/\\]+/, ""));
  const rel = relative(root, target);

  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return target;
  }

  return null;
}

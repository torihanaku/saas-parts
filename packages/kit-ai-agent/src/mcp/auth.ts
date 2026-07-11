/**
 * MCP bearer auth with an explicit loopback bypass.
 *
 * 出典: dev-dashboard-v2 server/mcp/auth.ts
 * 変更点: env.MCP_API_KEY / env.NODE_ENV 直読み → 設定注入。
 *         「キー未設定なら dev/test の loopback のみ許可」という元のセマンティクスは
 *         `allowLoopbackWithoutKey`（呼び出し側が NODE_ENV 判定して渡す）で再現。
 */

export interface McpAuthConfig {
  /** Expected bearer token. 未設定(undefined/"")なら bearer 認証は成立しない。 */
  apiKey?: string;
  /**
   * apiKey 未設定時に loopback (localhost/127.0.0.1/::1) からのリクエストを
   * 許可するか。本番では必ず false（デフォルト false）。
   */
  allowLoopbackWithoutKey?: boolean;
}

/** Structurally compatible with fetch Request. */
export interface McpAuthRequest {
  url: string;
  headers: { get(name: string): string | null };
}

export function isLoopbackRequest(req: McpAuthRequest): boolean {
  try {
    const hostname = new URL(req.url).hostname;
    // WHATWG URL は IPv6 の hostname をブラケット付き "[::1]" で返す
    // （元実装の "::1" 比較は永遠に false になる潜在バグだったため修正）
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

export function createMcpAuthChecker(config: McpAuthConfig): (req: McpAuthRequest) => boolean {
  return (req) => {
    if (!config.apiKey) {
      return config.allowLoopbackWithoutKey === true && isLoopbackRequest(req);
    }
    const auth = req.headers.get("Authorization") ?? "";
    return auth === `Bearer ${config.apiKey}`;
  };
}

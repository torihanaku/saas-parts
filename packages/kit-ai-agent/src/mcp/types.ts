/**
 * MCP wire types (JSON-RPC 2.0 + tool result helpers).
 *
 * 出典: dev-dashboard-v2 server/mcp/types.ts（ToolResult/textResult/jsonResult）
 *       + rpc.ts の JSON-RPC 形をフレームワーク非依存の型に切り出し。
 */

export type ToolResult = { content: Array<{ type: string; text: string }> };

export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function jsonResult(data: unknown): ToolResult {
  return textResult(JSON.stringify(data, null, 2));
}

// ─── JSON-RPC 2.0 ────────────────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}

export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: unknown; result: unknown }
  | { jsonrpc: "2.0"; id: unknown; error: { code: number; message: string } };

export function rpcOk(id: unknown, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

export function rpcError(id: unknown, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

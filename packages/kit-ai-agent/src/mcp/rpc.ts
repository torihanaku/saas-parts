/**
 * MCP JSON-RPC dispatcher (initialize / tools / resources / ping).
 *
 * 出典: 実運用SaaS server/mcp/rpc.ts
 * 変更点: 固定 SERVER_INFO/TOOLS/RESOURCES → serverInfo + レジストリ注入 /
 *         `Response` 直返し → JSON-RPC オブジェクト返し（フレームワーク非依存。
 *         Hono/Bun.serve/Express どれでも `Response.json(await handleRpc(body))`
 *         で包むだけ）。notification は null を返す（HTTP なら 204 にする）。
 */
import type { McpResourceRegistry, McpToolRegistry } from "./registry";
import { rpcError, rpcOk, type JsonRpcRequest, type JsonRpcResponse } from "./types";

export const PROTOCOL_VERSION = "2024-11-05";

export interface McpServerInfo {
  name: string;
  version: string;
  description?: string;
}

export interface McpHandlerConfig {
  serverInfo: McpServerInfo;
  tools: McpToolRegistry;
  resources?: McpResourceRegistry;
}

/** body → JSON-RPC response（null = notification、応答不要）. */
export type McpRpcHandler = (body: unknown) => Promise<JsonRpcResponse | null>;

export function createMcpHandler(config: McpHandlerConfig): McpRpcHandler {
  return async function handleRpc(body) {
    if (!body || typeof body !== "object") return rpcError(null, -32700, "Parse error");
    const { method, params, id } = body as JsonRpcRequest;
    if (!method) return rpcError(id ?? null, -32600, "Invalid Request");

    try {
      switch (method) {
        case "initialize":
          return rpcOk(id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {
              tools: {},
              ...(config.resources ? { resources: {} } : {}),
            },
            serverInfo: config.serverInfo,
          });
        case "notifications/initialized":
          return null;
        case "tools/list":
          return rpcOk(id, { tools: config.tools.list() });
        case "tools/call": {
          const toolName = (params as { name?: string } | undefined)?.name;
          const toolArgs =
            (params as { arguments?: Record<string, unknown> } | undefined)?.arguments ?? {};
          if (!toolName) return rpcError(id ?? null, -32602, "Missing tool name");
          const result = await config.tools.call(toolName, toolArgs);
          return rpcOk(id, result);
        }
        case "resources/list":
          return rpcOk(id, { resources: config.resources?.list() ?? [] });
        case "resources/read": {
          const uri = (params as { uri?: string } | undefined)?.uri;
          if (!uri) return rpcError(id ?? null, -32602, "Missing uri");
          if (!config.resources) return rpcError(id ?? null, -32601, "Resources not supported");
          const content = await config.resources.read(uri);
          return rpcOk(id, {
            contents: [
              { uri, mimeType: "application/json", text: JSON.stringify(content, null, 2) },
            ],
          });
        }
        case "ping":
          return rpcOk(id, {});
        default:
          return rpcError(id ?? null, -32601, `Method not found: ${method}`);
      }
    } catch (err) {
      return rpcError(
        id ?? null,
        -32603,
        `Internal error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
}

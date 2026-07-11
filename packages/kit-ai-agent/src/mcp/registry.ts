/**
 * MCP tool / resource registries.
 *
 * 出典: dev-dashboard-v2 server/mcp/tools-def.ts（37ツールの定義配列）＋
 *       call-tool.ts（impl チェーン）＋ resources.ts（RESOURCES/readResource）。
 * 変更点: 製品ツール（tasks/CRM/git/intel/content）は落とし、
 *         「定義＋ハンドラーを register して list()/call() で使う」機構だけを
 *         抽出。データ取得は各ハンドラーのクロージャに注入する
 *         （元 helpers.ts の Supabase/GitHub fetch は持たない）。
 */
import { textResult, type ToolResult } from "./types";

/** MCP `tools/list` shape — note camelCase `inputSchema` (Claude chat tools と違う). */
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type McpToolHandler = (
  args: Record<string, unknown>,
) => Promise<ToolResult> | ToolResult;

export class McpToolRegistry {
  private tools = new Map<string, { definition: McpToolDefinition; handler: McpToolHandler }>();

  register(definition: McpToolDefinition, handler: McpToolHandler): this {
    if (this.tools.has(definition.name)) {
      throw new Error(`tool_already_registered: ${definition.name}`);
    }
    this.tools.set(definition.name, { definition, handler });
    return this;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** `tools/list` result. */
  list(): McpToolDefinition[] {
    return [...this.tools.values()].map((t) => t.definition);
  }

  /** `tools/call` dispatch. Unknown tool throws（元 call-tool.ts と同じ）. */
  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    return tool.handler(args);
  }
}

// ─── Resources ───────────────────────────────────────────────────────────────

export interface McpResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

/** Reader with storage injected via closure（元: sbGet 直呼び）. */
export type McpResourceReader = () => Promise<unknown>;

export class McpResourceRegistry {
  private resources = new Map<string, { resource: McpResource; read: McpResourceReader }>();

  register(resource: McpResource, read: McpResourceReader): this {
    if (this.resources.has(resource.uri)) {
      throw new Error(`resource_already_registered: ${resource.uri}`);
    }
    this.resources.set(resource.uri, { resource, read });
    return this;
  }

  /** `resources/list` result. */
  list(): McpResource[] {
    return [...this.resources.values()].map((r) => r.resource);
  }

  /** `resources/read` dispatch. Unknown URI throws（元 readResource と同じ）. */
  async read(uri: string): Promise<unknown> {
    const entry = this.resources.get(uri);
    if (!entry) throw new Error(`Unknown resource URI: ${uri}`);
    return entry.read();
  }
}

// ─── Example registrations ───────────────────────────────────────────────────

/**
 * Example tools showing the registration pattern（rename/replace で実ツール化）。
 * 元実装ではここに list_tasks / create_crm_deal 等 37 個が並んでいた。
 */
export function registerExampleMcpTools(registry: McpToolRegistry): McpToolRegistry {
  registry.register(
    {
      name: "echo_text",
      description: "受け取ったテキストをそのまま返すサンプルツール",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", description: "返すテキスト" } },
        required: ["text"],
      },
    },
    (args) => textResult(`echo: ${String(args.text ?? "")}`),
  );

  registry.register(
    {
      name: "get_server_time",
      description: "サーバーの現在時刻（ISO 8601）を返すサンプルツール",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    () => textResult(new Date().toISOString()),
  );

  return registry;
}

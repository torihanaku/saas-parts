/**
 * LLM tool registry (Claude API `tools` format: snake_case `input_schema`).
 *
 * 出典: 実運用SaaS server/lib/chat-tools-def.ts（定義配列）＋
 *       server/lib/chat-tools.ts（switch 文の executeTool）。
 * 変更点: 27個の製品ツール（CRM/コンテンツ/レポート等）は落とし、
 *         「定義＋ハンドラーを1箇所で登録して definitions()/execute() で使う」
 *         レジストリ機構だけを抽出。登録例は registerExampleTools を参照。
 */

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** Returns a string that is fed back to the model as the tool_result content. */
export type ToolHandler<Ctx = unknown> = (
  input: Record<string, unknown>,
  ctx?: Ctx,
) => Promise<string> | string;

export interface RegisteredTool<Ctx = unknown> {
  definition: ToolDefinition;
  handler: ToolHandler<Ctx>;
}

export class ToolRegistry<Ctx = unknown> {
  private tools = new Map<string, RegisteredTool<Ctx>>();

  register(definition: ToolDefinition, handler: ToolHandler<Ctx>): this {
    if (this.tools.has(definition.name)) {
      throw new Error(`tool_already_registered: ${definition.name}`);
    }
    this.tools.set(definition.name, { definition, handler });
    return this;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Claude API に渡す `tools` 配列。 */
  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => t.definition);
  }

  async execute(name: string, input: Record<string, unknown>, ctx?: Ctx): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) return `Unknown tool: ${name}`;
    try {
      return await tool.handler(input, ctx);
    } catch (e: unknown) {
      // 元実装同様、ハンドラー例外は文字列としてモデルに返しループを継続させる。
      return `Tool error (${name}): ${e instanceof Error ? e.message : String(e)}`;
    }
  }
}

/**
 * Example registrations showing the pattern (rename/replace with real tools).
 * 元実装では list_crm_deals / generate_content 等がここに並んでいた。
 */
export function registerExampleTools<Ctx>(registry: ToolRegistry<Ctx>): ToolRegistry<Ctx> {
  registry.register(
    {
      name: "echo_text",
      description: "受け取ったテキストをそのまま返すサンプルツール",
      input_schema: {
        type: "object",
        properties: { text: { type: "string", description: "返すテキスト" } },
        required: ["text"],
      },
    },
    (input) => `echo: ${String(input.text ?? "")}`,
  );

  registry.register(
    {
      name: "get_current_time",
      description: "現在時刻（ISO 8601）を返すサンプルツール",
      input_schema: { type: "object", properties: {}, required: [] },
    },
    () => new Date().toISOString(),
  );

  return registry;
}

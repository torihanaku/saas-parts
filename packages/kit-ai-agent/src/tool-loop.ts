/**
 * LLM tool-use loop: keep calling the model until `stopReason !== "tool_use"`
 * or the iteration cap is hit; tool calls in each turn run in parallel and
 * their results are appended as the next user message.
 *
 * 出典: 実運用SaaS server/lib/claude-api-client.ts runToolLoop()
 * 変更点: callClaude 直呼び → LlmToolCaller 注入 / CHAT_TOOLS+executeTool →
 *         ToolRegistry 注入 / 日本語フォールバック文言はオプション化。
 */
import type { LlmMessage, LlmToolCaller, LlmToolUseBlock } from "./llm";
import type { ToolRegistry } from "./tool-registry";

export interface ToolLoopOptions {
  maxIterations?: number;
  /** Text returned when the model produced no text block (default: 元実装と同文). */
  emptyResponseText?: string;
  /** Text returned when maxIterations is exhausted while still in tool_use. */
  maxIterationsText?: string;
}

export interface ToolLoopResult {
  text: string;
  toolsUsed: string[];
  iterations: number;
}

export async function runToolLoop<Ctx>(
  call: LlmToolCaller,
  params: {
    system: string;
    messages: LlmMessage[];
    registry: ToolRegistry<Ctx>;
    ctx?: Ctx;
  },
  options: ToolLoopOptions = {},
): Promise<ToolLoopResult> {
  const {
    maxIterations = 5,
    emptyResponseText = "応答を生成できませんでした",
    maxIterationsText = "処理が複雑すぎます。もう少し具体的に指示してください。",
  } = options;

  const tools = params.registry.definitions();
  const toolsUsed: string[] = [];
  let messages = [...params.messages];

  for (let i = 0; i < maxIterations; i++) {
    const turn = await call({ system: params.system, messages, tools });
    const blocks = turn.blocks;

    if (turn.stopReason !== "tool_use") {
      const text =
        blocks
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("\n") || emptyResponseText;
      return { text, toolsUsed, iterations: i + 1 };
    }

    const toolBlocks = blocks.filter(
      (b): b is LlmToolUseBlock => b.type === "tool_use",
    );

    const results = await Promise.all(
      toolBlocks.map(async (tb) => {
        toolsUsed.push(tb.name);
        const content = await params.registry.execute(tb.name, tb.input, params.ctx);
        return { type: "tool_result" as const, tool_use_id: tb.id, content };
      }),
    );

    messages = [
      ...messages,
      { role: "assistant" as const, content: blocks },
      { role: "user" as const, content: results },
    ];
  }

  return { text: maxIterationsText, toolsUsed, iterations: maxIterations };
}

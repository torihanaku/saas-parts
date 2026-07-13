/**
 * ToolRegistry + runToolLoop のテスト。
 * 元テスト出典: 実運用SaaS の runToolLoop（claude-api-client.ts）と
 * chat-tools.ts の挙動仕様（unknown tool / handler error は文字列でモデルに返す）。
 */
import { describe, expect, it, vi } from "vitest";
import type { LlmToolCaller } from "./llm";
import { runToolLoop } from "./tool-loop";
import { registerExampleTools, ToolRegistry } from "./tool-registry";

describe("ToolRegistry", () => {
  it("registers tools and exposes Claude-format definitions", () => {
    const registry = registerExampleTools(new ToolRegistry());
    const defs = registry.definitions();
    expect(defs.map((d) => d.name)).toEqual(["echo_text", "get_current_time"]);
    expect(defs[0]).toHaveProperty("input_schema");
  });

  it("rejects duplicate registration", () => {
    const registry = registerExampleTools(new ToolRegistry());
    expect(() => registerExampleTools(registry)).toThrow("tool_already_registered");
  });

  it("returns a string for unknown tools and handler errors", async () => {
    const registry = new ToolRegistry();
    registry.register(
      { name: "boom", description: "", input_schema: { type: "object" } },
      () => {
        throw new Error("kaboom");
      },
    );
    expect(await registry.execute("nope", {})).toBe("Unknown tool: nope");
    expect(await registry.execute("boom", {})).toBe("Tool error (boom): kaboom");
  });

  it("passes ctx to handlers", async () => {
    const registry = new ToolRegistry<{ userId: string }>();
    registry.register(
      { name: "whoami", description: "", input_schema: { type: "object" } },
      (_input, ctx) => `user:${ctx?.userId}`,
    );
    expect(await registry.execute("whoami", {}, { userId: "u1" })).toBe("user:u1");
  });
});

describe("runToolLoop", () => {
  it("returns text directly when the model does not use tools", async () => {
    const call: LlmToolCaller = async () => ({
      stopReason: "end_turn",
      blocks: [{ type: "text", text: "こんにちは" }],
    });
    const result = await runToolLoop(call, {
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      registry: registerExampleTools(new ToolRegistry()),
    });
    expect(result).toEqual({ text: "こんにちは", toolsUsed: [], iterations: 1 });
  });

  it("executes tool calls and feeds results back as the next user message", async () => {
    const registry = registerExampleTools(new ToolRegistry());
    const call = vi
      .fn<LlmToolCaller>()
      .mockResolvedValueOnce({
        stopReason: "tool_use",
        blocks: [
          { type: "tool_use", id: "tu1", name: "echo_text", input: { text: "abc" } },
        ],
      })
      .mockResolvedValueOnce({
        stopReason: "end_turn",
        blocks: [{ type: "text", text: "done" }],
      });

    const result = await runToolLoop(call, {
      system: "s",
      messages: [{ role: "user", content: "go" }],
      registry,
    });

    expect(result).toEqual({ text: "done", toolsUsed: ["echo_text"], iterations: 2 });
    // 2回目の呼び出しには assistant ブロックと tool_result が積まれている
    const secondMessages = call.mock.calls[1]![0].messages;
    expect(secondMessages).toHaveLength(3);
    expect(secondMessages[2]).toMatchObject({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu1", content: "echo: abc" }],
    });
  });

  it("stops with maxIterations text when the model keeps using tools", async () => {
    const registry = registerExampleTools(new ToolRegistry());
    const call: LlmToolCaller = async () => ({
      stopReason: "tool_use",
      blocks: [{ type: "tool_use", id: "t", name: "get_current_time", input: {} }],
    });
    const result = await runToolLoop(
      call,
      { system: "s", messages: [], registry },
      { maxIterations: 2, maxIterationsText: "打ち切り" },
    );
    expect(result.text).toBe("打ち切り");
    expect(result.iterations).toBe(2);
    expect(result.toolsUsed).toEqual(["get_current_time", "get_current_time"]);
  });

  it("falls back to emptyResponseText when no text block is returned", async () => {
    const call: LlmToolCaller = async () => ({ stopReason: "end_turn", blocks: [] });
    const result = await runToolLoop(
      call,
      { system: "s", messages: [], registry: new ToolRegistry() },
      { emptyResponseText: "空" },
    );
    expect(result.text).toBe("空");
  });
});

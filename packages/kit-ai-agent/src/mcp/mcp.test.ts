/**
 * MCP 雛形のディスパッチ／認証テスト。
 * 元テスト出典: 実運用SaaS server/mcp/rpc.ts の各 case ＋ auth.ts の
 * bearer/loopback 仕様（env 直読み → 設定注入に置換）。
 */
import { describe, expect, it } from "vitest";
import { createMcpAuthChecker, isLoopbackRequest } from "./auth";
import {
  McpResourceRegistry,
  McpToolRegistry,
  registerExampleMcpTools,
} from "./registry";
import { createMcpHandler, PROTOCOL_VERSION } from "./rpc";
import { jsonResult, textResult } from "./types";

function makeHandler() {
  const tools = registerExampleMcpTools(new McpToolRegistry());
  const resources = new McpResourceRegistry().register(
    {
      uri: "app://items/pending",
      name: "Pending Items",
      description: "未処理アイテム一覧",
      mimeType: "application/json",
    },
    async () => ({ items: [1, 2], count: 2 }),
  );
  return createMcpHandler({
    serverInfo: { name: "example", version: "0.1.0" },
    tools,
    resources,
  });
}

describe("createMcpHandler", () => {
  it("responds to initialize with protocol version and capabilities", async () => {
    const res = await makeHandler()({ method: "initialize", id: 1 });
    expect(res).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "example" },
      },
    });
  });

  it("returns null for notifications/initialized", async () => {
    expect(await makeHandler()({ method: "notifications/initialized" })).toBeNull();
  });

  it("lists registered tools", async () => {
    const res = await makeHandler()({ method: "tools/list", id: 2 });
    const tools = (res as { result: { tools: Array<{ name: string }> } }).result.tools;
    expect(tools.map((t) => t.name)).toEqual(["echo_text", "get_server_time"]);
    expect(tools[0]).toHaveProperty("inputSchema");
  });

  it("dispatches tools/call to the handler", async () => {
    const res = await makeHandler()({
      method: "tools/call",
      id: 3,
      params: { name: "echo_text", arguments: { text: "やあ" } },
    });
    expect(res).toMatchObject({
      id: 3,
      result: { content: [{ type: "text", text: "echo: やあ" }] },
    });
  });

  it("returns -32602 when the tool name is missing", async () => {
    const res = await makeHandler()({ method: "tools/call", id: 4, params: {} });
    expect(res).toMatchObject({ error: { code: -32602 } });
  });

  it("returns -32603 for unknown tools", async () => {
    const res = await makeHandler()({
      method: "tools/call",
      id: 5,
      params: { name: "nope" },
    });
    expect(res).toMatchObject({ error: { code: -32603, message: expect.stringContaining("Unknown tool") } });
  });

  it("lists and reads resources", async () => {
    const handler = makeHandler();
    const list = await handler({ method: "resources/list", id: 6 });
    expect(list).toMatchObject({
      result: { resources: [{ uri: "app://items/pending" }] },
    });
    const read = await handler({
      method: "resources/read",
      id: 7,
      params: { uri: "app://items/pending" },
    });
    const contents = (read as { result: { contents: Array<{ text: string }> } }).result.contents;
    expect(JSON.parse(contents[0]!.text)).toEqual({ items: [1, 2], count: 2 });
  });

  it("returns -32601 for unknown methods, -32700 for bad bodies", async () => {
    const handler = makeHandler();
    expect(await handler({ method: "wat", id: 8 })).toMatchObject({ error: { code: -32601 } });
    expect(await handler("not-an-object")).toMatchObject({ error: { code: -32700 } });
    expect(await handler({ id: 9 })).toMatchObject({ error: { code: -32600 } });
  });

  it("responds to ping", async () => {
    expect(await makeHandler()({ method: "ping", id: 10 })).toMatchObject({ id: 10, result: {} });
  });
});

describe("tool result helpers", () => {
  it("textResult / jsonResult wrap content", () => {
    expect(textResult("a")).toEqual({ content: [{ type: "text", text: "a" }] });
    expect(jsonResult({ a: 1 }).content[0]!.text).toContain('"a": 1');
  });
});

describe("MCP auth", () => {
  const headers = (auth?: string) => ({
    get: (name: string) => (name === "Authorization" ? (auth ?? null) : null),
  });

  it("accepts the exact bearer token only", () => {
    const check = createMcpAuthChecker({ apiKey: "sekrit" });
    expect(check({ url: "https://api.example.com/mcp", headers: headers("Bearer sekrit") })).toBe(true);
    expect(check({ url: "https://api.example.com/mcp", headers: headers("Bearer wrong") })).toBe(false);
    expect(check({ url: "https://api.example.com/mcp", headers: headers() })).toBe(false);
  });

  it("without a key, allows loopback only when explicitly enabled", () => {
    const permissive = createMcpAuthChecker({ allowLoopbackWithoutKey: true });
    expect(permissive({ url: "http://localhost:3000/mcp", headers: headers() })).toBe(true);
    expect(permissive({ url: "https://api.example.com/mcp", headers: headers() })).toBe(false);

    const strict = createMcpAuthChecker({});
    expect(strict({ url: "http://localhost:3000/mcp", headers: headers() })).toBe(false);
  });

  it("isLoopbackRequest recognizes loopback hosts and rejects bad URLs", () => {
    expect(isLoopbackRequest({ url: "http://127.0.0.1/x", headers: headers() })).toBe(true);
    expect(isLoopbackRequest({ url: "http://[::1]/x", headers: headers() })).toBe(true);
    expect(isLoopbackRequest({ url: "not a url", headers: headers() })).toBe(false);
  });
});

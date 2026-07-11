import { describe, it, expect, vi } from "vitest";
import {
  sanitizeLpHtml,
  buildLpUserPrompt,
  generateLpMock,
  LP_MOCK_FALLBACK_HTML,
} from "./lp-mock.js";
import type { GenerateText } from "./types.js";

describe("sanitizeLpHtml", () => {
  it("strips code-fence wrappers", () => {
    const out = sanitizeLpHtml("```html\n<html></html>\n```");
    expect(out).toBe("<html></html>");
  });

  it("removes non-tailwind scripts", () => {
    const out = sanitizeLpHtml('<div></div><script src="https://evil.com/x.js"></script>');
    expect(out).not.toContain("evil.com");
  });

  it("keeps the tailwind CDN script", () => {
    const out = sanitizeLpHtml('<script src="https://cdn.tailwindcss.com"></script>');
    expect(out).toContain("cdn.tailwindcss.com");
  });

  it("removes iframes and inline event handlers", () => {
    const out = sanitizeLpHtml('<iframe src="x"></iframe><button onclick="hack()">x</button>');
    expect(out).not.toContain("<iframe");
    expect(out).not.toContain("onclick");
  });
});

describe("buildLpUserPrompt", () => {
  it("includes the brief and (optional) brand guidelines", () => {
    const p = buildLpUserPrompt("新SaaSのLP", "誇張禁止");
    expect(p).toContain("新SaaSのLP");
    expect(p).toContain("誇張禁止");
    expect(p).toContain("Brand Guidelines");
  });

  it("omits guidelines section when absent", () => {
    expect(buildLpUserPrompt("brief")).not.toContain("Brand Guidelines");
  });
});

describe("generateLpMock", () => {
  it("returns fallback when LLM is missing", async () => {
    const out = await generateLpMock(undefined, "brief");
    expect(out.source).toBe("fallback");
    expect(out.html).toBe(LP_MOCK_FALLBACK_HTML);
  });

  it("returns sanitized AI html when it contains <html", async () => {
    const gen: GenerateText = vi.fn(async () => '<html><body>ok</body><script src="https://evil.com"></script></html>');
    const out = await generateLpMock(gen, "brief");
    expect(out.source).toBe("ai");
    expect(out.html).toContain("<html");
    expect(out.html).not.toContain("evil.com");
  });

  it("falls back when AI output lacks an html document", async () => {
    const gen: GenerateText = vi.fn(async () => "sorry, cannot");
    const out = await generateLpMock(gen, "brief");
    expect(out.source).toBe("fallback");
  });
});

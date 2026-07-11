/**
 * Ported from dev-dashboard-v2 tests/image-generator.test.ts.
 * env/cache/supabase の vi.mock を config 注入に置換し、
 * generate() の fetch モックテストと ImageSink テストを追加。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createImageGen,
  enhancePromptWithBrand,
  OpenAIImageProvider,
  FalImageProvider,
  type ImageSink,
} from "./index";

function makeGen(overrides: Parameters<typeof createImageGen>[0] = {}) {
  return createImageGen({
    openaiApiKey: "test-openai-key",
    falKey: "test-fal-key",
    ...overrides,
  });
}

describe("enhancePromptWithBrand()", () => {
  it("returns prompt unchanged when no brand guidelines", () => {
    const result = enhancePromptWithBrand("A modern office building", undefined);
    expect(result).toBe("A modern office building");
  });

  it("returns prompt unchanged when brand guidelines is empty string", () => {
    const result = enhancePromptWithBrand("A modern office building", "");
    expect(result).toBe("A modern office building");
  });

  it("prepends brand guidelines to prompt", () => {
    const result = enhancePromptWithBrand("A modern office building", "Use blue colors, minimal style");
    expect(result).toContain("[Brand Guidelines]");
    expect(result).toContain("Use blue colors, minimal style");
    expect(result).toContain("[Image Request]");
    expect(result).toContain("A modern office building");
  });

  it("brand guidelines appear before the prompt", () => {
    const result = enhancePromptWithBrand("prompt text", "brand text");
    const brandIndex = result.indexOf("brand text");
    const promptIndex = result.indexOf("prompt text");
    expect(brandIndex).toBeLessThan(promptIndex);
  });
});

describe("listAllModels()", () => {
  it("returns models from all available providers", async () => {
    const gen = makeGen();
    const models = await gen.listAllModels();
    expect(models.length).toBeGreaterThan(0);

    // Should have both OpenAI and fal models
    const providers = [...new Set(models.map((m) => m.provider))];
    expect(providers).toContain("openai");
    expect(providers).toContain("fal");
  });

  it("each model has required fields", async () => {
    const gen = makeGen();
    const models = await gen.listAllModels();
    for (const model of models) {
      expect(model.id).toBeTruthy();
      expect(model.name).toBeTruthy();
      expect(model.provider).toBeTruthy();
      expect(typeof model.costPerImage).toBe("number");
      expect(model.costPerImage).toBeGreaterThan(0);
      expect(Array.isArray(model.sizes)).toBe(true);
      expect(model.sizes.length).toBeGreaterThan(0);
    }
  });

  it("caches the merged list (second call skips providers)", async () => {
    const listModels = vi.fn().mockResolvedValue([
      { id: "m1", name: "M1", provider: "custom", costPerImage: 0.01, sizes: ["1024x1024"] },
    ]);
    const gen = createImageGen({
      providers: [
        {
          id: "custom",
          name: "Custom",
          isAvailable: () => true,
          listModels,
          generate: vi.fn(),
        },
      ],
    });
    await gen.listAllModels();
    await gen.listAllModels();
    expect(listModels).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after TTL expiry", async () => {
    vi.useFakeTimers();
    try {
      const listModels = vi.fn().mockResolvedValue([
        { id: "m1", name: "M1", provider: "custom", costPerImage: 0.01, sizes: ["1024x1024"] },
      ]);
      const gen = createImageGen({
        providers: [
          { id: "custom", name: "Custom", isAvailable: () => true, listModels, generate: vi.fn() },
        ],
        modelCacheTtlMs: 1000,
      });
      await gen.listAllModels();
      vi.advanceTimersByTime(1500);
      await gen.listAllModels();
      expect(listModels).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Provider availability", () => {
  it("OpenAIImageProvider reports available when key is set", () => {
    const provider = new OpenAIImageProvider("k");
    expect(provider.isAvailable()).toBe(true);
    expect(provider.id).toBe("openai");
    expect(provider.name).toBe("OpenAI");
  });

  it("OpenAIImageProvider reports unavailable without key", () => {
    expect(new OpenAIImageProvider().isAvailable()).toBe(false);
  });

  it("FalImageProvider reports available when key is set", () => {
    const provider = new FalImageProvider("k");
    expect(provider.isAvailable()).toBe(true);
    expect(provider.id).toBe("fal");
    expect(provider.name).toBe("fal.ai");
  });

  it("getAvailableProviders returns both when keys are set", () => {
    const available = makeGen().getAvailableProviders();
    expect(available.length).toBe(2);
    const ids = available.map((p) => p.id);
    expect(ids).toContain("openai");
    expect(ids).toContain("fal");
  });

  it("getAvailableProviders excludes providers without keys", () => {
    const available = createImageGen({ openaiApiKey: "k" }).getAvailableProviders();
    expect(available.map((p) => p.id)).toEqual(["openai"]);
  });
});

describe("OpenAIImageProvider.listModels()", () => {
  it("returns hardcoded OpenAI models", async () => {
    const provider = new OpenAIImageProvider("k");
    const models = await provider.listModels();
    expect(models.length).toBe(2);
    expect(models[0]?.id).toBe("gpt-image-1-mini");
    expect(models[1]?.id).toBe("gpt-image-1");
    for (const m of models) {
      expect(m.provider).toBe("openai");
    }
  });
});

describe("FalImageProvider.listModels()", () => {
  it("returns curated fal.ai models", async () => {
    const provider = new FalImageProvider("k");
    const models = await provider.listModels();
    expect(models.length).toBe(3);
    const ids = models.map((m) => m.id);
    expect(ids).toContain("fal-ai/flux-pro/v1.1");
    expect(ids).toContain("fal-ai/flux/dev");
    expect(ids).toContain("fal-ai/stable-diffusion-v35-large");
    for (const m of models) {
      expect(m.provider).toBe("fal");
    }
  });
});

describe("generateImage() routing (mocked fetch)", () => {
  const mockFetch = vi.fn<typeof fetch>();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("routes gpt-image-1 to OpenAI and decodes b64_json", async () => {
    const png = Buffer.from("fake-png-bytes");
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ data: [{ b64_json: png.toString("base64"), revised_prompt: "revised" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const gen = makeGen();
    const result = await gen.generateImage({
      prompt: "an office",
      model: "gpt-image-1",
      size: "1536x1024",
      brandGuidelines: "blue, minimal",
    });

    expect(result.provider).toBe("openai");
    expect(result.imageBuffer.equals(png)).toBe(true);
    expect(result.revisedPrompt).toBe("revised");
    expect(result.width).toBe(1536);
    expect(result.height).toBe(1024);
    expect(result.costUsd).toBe(0.04);

    // brand guidelines are prepended by the default transformer
    const body = JSON.parse((mockFetch.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.prompt).toContain("[Brand Guidelines]");
    expect(body.prompt).toContain("blue, minimal");
    const url = mockFetch.mock.calls[0]?.[0];
    expect(String(url)).toContain("api.openai.com");
  });

  it("routes fal-ai/flux/dev to fal and downloads the image", async () => {
    const bytes = Buffer.from("fal-image");
    mockFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ images: [{ url: "https://cdn.fal.ai/img.png", width: 1024, height: 768 }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(new Response(bytes, { status: 200 }));

    const gen = makeGen();
    const result = await gen.generateImage({
      prompt: "a cat",
      model: "fal-ai/flux/dev",
      size: "1024x768",
    });

    expect(result.provider).toBe("fal");
    expect(result.imageBuffer.equals(bytes)).toBe(true);
    expect(result.width).toBe(1024);
    expect(result.height).toBe(768);
    expect(result.costUsd).toBe(0.025);
    expect(String(mockFetch.mock.calls[0]?.[0])).toBe("https://fal.run/fal-ai/flux/dev");
    // image_size enum mapping
    const body = JSON.parse((mockFetch.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.image_size).toBe("landscape_4_3");
  });

  it("throws on unknown model", async () => {
    const gen = makeGen();
    await expect(gen.generateImage({ prompt: "x", model: "nope" })).rejects.toThrow(/Unknown image model/);
  });

  it("throws when the provider for the model is unavailable", async () => {
    // fal のモデルはキャッシュに残るが fal キーなし、というケースを
    // cacheGet 注入で再現する
    const gen = createImageGen({
      openaiApiKey: "k",
      cacheGet: async () => [
        { id: "fal-ai/flux/dev", name: "FLUX Dev", provider: "fal", costPerImage: 0.025, sizes: ["1024x1024"] },
      ],
    });
    await expect(gen.generateImage({ prompt: "x", model: "fal-ai/flux/dev" })).rejects.toThrow(
      /Provider "fal" is not available/,
    );
  });

  it("throws on unsupported size (OpenAI)", async () => {
    const gen = makeGen();
    await expect(
      gen.generateImage({ prompt: "x", model: "gpt-image-1", size: "512x512" }),
    ).rejects.toThrow(/Size 512x512 is not supported/);
  });

  it("applies a custom promptTransformer", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("x").toString("base64") }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const gen = makeGen({ promptTransformer: (p) => `STYLE: ${p}` });
    await gen.generateImage({ prompt: "an office", model: "gpt-image-1-mini" });
    const body = JSON.parse((mockFetch.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.prompt).toBe("STYLE: an office");
  });

  it("surfaces OpenAI API errors", async () => {
    mockFetch.mockResolvedValueOnce(new Response("rate limited", { status: 429 }));
    const gen = makeGen();
    await expect(gen.generateImage({ prompt: "x", model: "gpt-image-1" })).rejects.toThrow(
      /OpenAI Images API error 429/,
    );
  });
});

describe("uploadImage() via ImageSink", () => {
  it("delegates to the injected sink", async () => {
    const sink = vi.fn<ImageSink>().mockResolvedValue({
      storagePath: "t1/a.png",
      storageUrl: "https://cdn.example.com/t1/a.png",
    });
    const gen = makeGen({ sink });
    const buf = Buffer.from("img");
    const result = await gen.uploadImage("t1", buf, "a.png");
    expect(result.storageUrl).toContain("a.png");
    expect(sink).toHaveBeenCalledWith({
      tenantId: "t1",
      imageBuffer: buf,
      filename: "a.png",
      contentType: "image/png",
    });
  });

  it("throws when no sink is configured", async () => {
    const gen = makeGen();
    await expect(gen.uploadImage("t1", Buffer.from("x"), "a.png")).rejects.toThrow(
      /ImageSink is not configured/,
    );
  });
});

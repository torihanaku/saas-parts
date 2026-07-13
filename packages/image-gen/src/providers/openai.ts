/**
 * OpenAI Images API adapter.
 *
 * Supports gpt-image-1-mini and gpt-image-1 via the
 * POST /v1/images/generations endpoint.
 *
 * 出典: 実運用SaaS server/lib/image-providers/openai.ts
 * 移植差分: env.OPENAI_API_KEY → コンストラクタ注入。
 */
import type { ImageProvider, ImageModel, ImageGenParams, ImageGenResult } from "../types";

const OPENAI_MODELS: ImageModel[] = [
  {
    id: "gpt-image-1-mini",
    name: "GPT Image 1 Mini",
    provider: "openai",
    costPerImage: 0.019,
    sizes: ["1024x1024", "1536x1024", "1024x1536"],
  },
  {
    id: "gpt-image-1",
    name: "GPT Image 1",
    provider: "openai",
    costPerImage: 0.04,
    sizes: ["1024x1024", "1536x1024", "1024x1536"],
  },
];

const API_URL = "https://api.openai.com/v1/images/generations";

export class OpenAIImageProvider implements ImageProvider {
  id = "openai";
  name = "OpenAI";

  constructor(private readonly apiKeyDefault?: string) {}

  isAvailable(): boolean {
    return !!this.apiKeyDefault;
  }

  async listModels(): Promise<ImageModel[]> {
    return OPENAI_MODELS;
  }

  async generate(params: ImageGenParams): Promise<ImageGenResult> {
    const apiKey = params.apiKey || this.apiKeyDefault;
    if (!apiKey) throw new Error("OpenAI API key is not configured");

    const model = OPENAI_MODELS.find((m) => m.id === params.model);
    if (!model) throw new Error(`Unknown OpenAI image model: ${params.model}`);

    const size = params.size || "1024x1024";
    if (!model.sizes.includes(size)) {
      throw new Error(`Size ${size} is not supported by ${model.id}. Available: ${model.sizes.join(", ")}`);
    }

    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: params.model,
        prompt: params.prompt,
        n: 1,
        size,
        response_format: "b64_json",
      }),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`OpenAI Images API error ${res.status}: ${errBody}`);
    }

    const json = (await res.json()) as {
      data: Array<{ b64_json?: string; revised_prompt?: string }>;
    };

    const item = json.data?.[0];
    if (!item?.b64_json) {
      throw new Error("OpenAI returned empty image data");
    }

    const imageBuffer = Buffer.from(item.b64_json, "base64");
    const [w, h] = size.split("x").map(Number);

    return {
      imageBuffer,
      revisedPrompt: item.revised_prompt,
      model: params.model,
      provider: "openai",
      width: w ?? 0,
      height: h ?? 0,
      costUsd: model.costPerImage,
    };
  }
}

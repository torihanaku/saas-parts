/**
 * fal.ai gateway adapter.
 *
 * Uses direct HTTP calls to the synchronous fal.run endpoint
 * to avoid adding @fal-ai/client as a dependency.
 *
 * 出典: dev-dashboard-v2 server/lib/image-providers/fal.ts
 * 移植差分: env.FAL_KEY → コンストラクタ注入。
 */
import type { ImageProvider, ImageModel, ImageGenParams, ImageGenResult } from "../types";

const FAL_MODELS: ImageModel[] = [
  {
    id: "fal-ai/flux-pro/v1.1",
    name: "FLUX Pro",
    provider: "fal",
    costPerImage: 0.055,
    sizes: ["1024x1024", "1024x768", "768x1024"],
  },
  {
    id: "fal-ai/flux/dev",
    name: "FLUX Dev",
    provider: "fal",
    costPerImage: 0.025,
    sizes: ["1024x1024", "1024x768", "768x1024"],
  },
  {
    id: "fal-ai/stable-diffusion-v35-large",
    name: "SD 3.5 Large",
    provider: "fal",
    costPerImage: 0.065,
    sizes: ["1024x1024"],
  },
];

/** Map WxH string to fal.ai image_size enum value */
function toFalImageSize(size: string): string {
  const map: Record<string, string> = {
    "1024x1024": "square_hd",
    "1024x768": "landscape_4_3",
    "768x1024": "portrait_4_3",
  };
  return map[size] || "square_hd";
}

export class FalImageProvider implements ImageProvider {
  id = "fal";
  name = "fal.ai";

  constructor(private readonly apiKeyDefault?: string) {}

  isAvailable(): boolean {
    return !!this.apiKeyDefault;
  }

  async listModels(): Promise<ImageModel[]> {
    return FAL_MODELS;
  }

  async generate(params: ImageGenParams): Promise<ImageGenResult> {
    const falKey = params.apiKey || this.apiKeyDefault;
    if (!falKey) throw new Error("fal.ai API key is not configured");

    const model = FAL_MODELS.find((m) => m.id === params.model);
    if (!model) throw new Error(`Unknown fal.ai image model: ${params.model}`);

    const size = params.size || "1024x1024";
    if (!model.sizes.includes(size)) {
      throw new Error(`Size ${size} is not supported by ${model.id}. Available: ${model.sizes.join(", ")}`);
    }

    // Use synchronous endpoint (not queue)
    const url = `https://fal.run/${params.model}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Key ${falKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: params.prompt,
        image_size: toFalImageSize(size),
        num_images: 1,
      }),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`fal.ai API error ${res.status}: ${errBody}`);
    }

    const json = (await res.json()) as {
      images?: Array<{ url: string; width: number; height: number }>;
    };

    const image = json.images?.[0];
    if (!image?.url) {
      throw new Error("fal.ai returned empty image data");
    }

    // Fetch the generated image to get the raw buffer
    const imgRes = await fetch(image.url);
    if (!imgRes.ok) {
      throw new Error(`Failed to download fal.ai image: ${imgRes.status}`);
    }

    const arrayBuf = await imgRes.arrayBuffer();
    const imageBuffer = Buffer.from(arrayBuf);

    return {
      imageBuffer,
      revisedPrompt: undefined,
      model: params.model,
      provider: "fal",
      width: image.width,
      height: image.height,
      costUsd: model.costPerImage,
    };
  }
}

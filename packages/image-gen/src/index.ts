/**
 * @torihanaku/image-gen — AI 画像生成 (プロバイダレジストリ + モデル一覧キャッシュ + 生成ルーター)
 *
 * 出典: dev-dashboard-v2
 *   - server/lib/image-generator.ts (コア型・ルーター・Supabase Storage upload)
 *   - server/lib/image-providers/openai.ts / fal.ts
 *
 * 移植方針:
 * - API キーは env ではなく `createImageGen()` の config で受け取る。
 * - Supabase Storage への upload は注入式の `ImageSink` コールバックに置換
 *   (@torihanaku/storage-upload がこのシグネチャを満たす)。
 * - ブランドガイドラインによるプロンプト強化は差し替え可能な transformer
 *   (既定は原典の enhancePromptWithBrand)。
 * - モデル一覧キャッシュは 5 分 TTL (原典どおり)。既定はインメモリ、
 *   @torihanaku/cache 互換の cacheGet/cacheSet を注入可能。
 */
import type {
  ImageProvider,
  ImageModel,
  ImageGenParams,
  ImageGenResult,
  ImageSink,
  ImageSinkResult,
} from "./types";
import { OpenAIImageProvider } from "./providers/openai";
import { FalImageProvider } from "./providers/fal";

export type {
  ImageProvider,
  ImageModel,
  ImageGenParams,
  ImageGenResult,
  ImageSink,
  ImageSinkResult,
} from "./types";
export { OpenAIImageProvider } from "./providers/openai";
export { FalImageProvider } from "./providers/fal";

const MODEL_CACHE_KEY = "image-gen:models";
const MODEL_CACHE_TTL = 300_000; // 5 minutes

/**
 * Prepend brand guidelines to a prompt if provided.
 * (原典そのまま。既定の promptTransformer)
 */
export function enhancePromptWithBrand(prompt: string, brandGuidelines?: string): string {
  if (!brandGuidelines) return prompt;
  return `[Brand Guidelines]\n${brandGuidelines}\n\n[Image Request]\n${prompt}`;
}

export interface ImageGenConfig {
  /** OpenAI Images API キー (省略時 OpenAI プロバイダは unavailable) */
  openaiApiKey?: string;
  /** fal.ai API キー (省略時 fal プロバイダは unavailable) */
  falKey?: string;
  /** プロバイダレジストリの差し替え。省略時は OpenAI + fal.ai */
  providers?: ImageProvider[];
  /** モデル一覧キャッシュの読み出し (@torihanaku/cache の cacheGet 互換)。省略時はインメモリ */
  cacheGet?: (key: string) => Promise<ImageModel[] | null>;
  /** モデル一覧キャッシュの書き込み (@torihanaku/cache の cacheSet 互換)。省略時はインメモリ */
  cacheSet?: (key: string, value: ImageModel[], ttlMs: number) => Promise<void>;
  /** モデル一覧キャッシュ TTL (ms)。既定 300_000 (5 分) */
  modelCacheTtlMs?: number;
  /** ブランドガイドライン等によるプロンプト変換。既定は enhancePromptWithBrand */
  promptTransformer?: (prompt: string, brandGuidelines?: string) => string;
  /** 生成画像の保存先 (例: @torihanaku/storage-upload)。未設定で uploadImage を呼ぶと throw */
  sink?: ImageSink;
}

export interface ImageGen {
  /** API キーが設定されているプロバイダのみ返す */
  getAvailableProviders(): ImageProvider[];
  /** 利用可能な全プロバイダのモデル一覧をマージ (5 分キャッシュ) */
  listAllModels(): Promise<ImageModel[]>;
  /** model id からプロバイダを解決して生成をルーティング */
  generateImage(params: ImageGenParams): Promise<ImageGenResult>;
  /** 生成画像を注入された ImageSink 経由で保存 */
  uploadImage(
    tenantId: string,
    imageBuffer: Buffer,
    filename: string,
    contentType?: string,
  ): Promise<ImageSinkResult>;
}

export function createImageGen(config: ImageGenConfig = {}): ImageGen {
  const providers: ImageProvider[] = config.providers ?? [
    new OpenAIImageProvider(config.openaiApiKey),
    new FalImageProvider(config.falKey),
  ];

  const ttl = config.modelCacheTtlMs ?? MODEL_CACHE_TTL;
  const transformer = config.promptTransformer ?? enhancePromptWithBrand;

  // 既定のインメモリキャッシュ (インスタンス単位)
  const memoryCache = new Map<string, { value: ImageModel[]; expiresAt: number }>();
  const cacheGet =
    config.cacheGet ??
    (async (key: string): Promise<ImageModel[] | null> => {
      const entry = memoryCache.get(key);
      if (!entry) return null;
      if (Date.now() > entry.expiresAt) {
        memoryCache.delete(key);
        return null;
      }
      return entry.value;
    });
  const cacheSet =
    config.cacheSet ??
    (async (key: string, value: ImageModel[], ttlMs: number): Promise<void> => {
      memoryCache.set(key, { value, expiresAt: Date.now() + ttlMs });
    });

  function getAvailableProviders(): ImageProvider[] {
    return providers.filter((p) => p.isAvailable());
  }

  async function listAllModels(): Promise<ImageModel[]> {
    const cached = await cacheGet(MODEL_CACHE_KEY);
    if (cached) return cached;

    const available = getAvailableProviders();
    const lists = await Promise.all(available.map((p) => p.listModels()));
    const merged = lists.flat();

    await cacheSet(MODEL_CACHE_KEY, merged, ttl);
    return merged;
  }

  async function generateImage(params: ImageGenParams): Promise<ImageGenResult> {
    const enhancedPrompt = transformer(params.prompt, params.brandGuidelines);
    const enhanced = { ...params, prompt: enhancedPrompt };

    // Determine provider by model prefix / provider match
    const models = await listAllModels();
    const modelInfo = models.find((m) => m.id === params.model);
    if (!modelInfo) {
      throw new Error(`Unknown image model: ${params.model}. Use listAllModels() to list available models.`);
    }

    const provider = providers.find((p) => p.id === modelInfo.provider);
    if (!provider || !provider.isAvailable()) {
      throw new Error(`Provider "${modelInfo.provider}" is not available. Check API key configuration.`);
    }

    return provider.generate(enhanced);
  }

  async function uploadImage(
    tenantId: string,
    imageBuffer: Buffer,
    filename: string,
    contentType = "image/png",
  ): Promise<ImageSinkResult> {
    if (!config.sink) {
      throw new Error("ImageSink is not configured. Pass `sink` to createImageGen().");
    }
    return config.sink({ tenantId, imageBuffer, filename, contentType });
  }

  return { getAvailableProviders, listAllModels, generateImage, uploadImage };
}

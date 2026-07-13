# @torihanaku/image-gen

複数の AI 画像生成プロバイダ（OpenAI Images / fal.ai）を共通インターフェースの背後に隠す、プロバイダレジストリ＋モデル一覧キャッシュ（5 分 TTL）＋生成ルーター。生成結果の保存は注入式の `ImageSink` コールバック（`@torihanaku/storage-upload` がこのシグネチャを満たします）、ブランドガイドラインによるプロンプト強化は差し替え可能な transformer です。

## 用途

- model id（例 `gpt-image-1`, `fal-ai/flux/dev`）を指定するだけで、対応するプロバイダへ生成リクエストを自動ルーティング
- 利用可能な全プロバイダのモデル一覧（名称・単価・対応サイズ）をマージして 5 分キャッシュ付きで提供
- テナントごとの BYOK（`params.apiKey` によるリクエスト単位のキー上書き）

## API 例

```ts
import { createImageGen } from "@torihanaku/image-gen";
import { createStorageUploader } from "@torihanaku/storage-upload";

const uploader = createStorageUploader({ /* ... */ });

const imageGen = createImageGen({
  openaiApiKey: config.OPENAI_API_KEY, // 呼び出し側の設定機構から渡す
  falKey: config.FAL_KEY,
  sink: async ({ tenantId, imageBuffer, filename, contentType }) => {
    // ImageSink: 保存先は自由 (Supabase Storage / S3 / GCS ...)
    return uploader.upload(`${tenantId}/${filename}`, imageBuffer, contentType);
  },
});

// モデル一覧 (全プロバイダをマージ、5 分キャッシュ)
const models = await imageGen.listAllModels();
// → [{ id: "gpt-image-1-mini", provider: "openai", costPerImage: 0.019, sizes: [...] }, ...]

// 生成 (model id からプロバイダを自動解決)
const result = await imageGen.generateImage({
  prompt: "モダンなオフィスビル",
  model: "gpt-image-1",
  size: "1536x1024",
  brandGuidelines: "ブルー基調・ミニマル", // 既定 transformer がプロンプト先頭に付与
  // apiKey: tenantKey,                    // BYOK: リクエスト単位で上書き可
});
// result: { imageBuffer, revisedPrompt?, model, provider, width, height, costUsd }

// 保存 (注入した ImageSink に委譲)
const { storagePath, storageUrl } = await imageGen.uploadImage(
  "tenant-1",
  result.imageBuffer,
  "hero.png",
);
```

### プロンプト変換の差し替え

```ts
const imageGen = createImageGen({
  openaiApiKey: key,
  promptTransformer: (prompt, brandGuidelines) =>
    myBrandEngine.rewrite(prompt, brandGuidelines), // 独自のブランド適用ロジック
});
```

### 独自プロバイダの追加

```ts
import type { ImageProvider } from "@torihanaku/image-gen";

const myProvider: ImageProvider = {
  id: "replicate",
  name: "Replicate",
  isAvailable: () => !!replicateKey,
  listModels: async () => [{ id: "sdxl", name: "SDXL", provider: "replicate", costPerImage: 0.01, sizes: ["1024x1024"] }],
  generate: async (params) => {/* ... */},
};

const imageGen = createImageGen({ providers: [myProvider] });
```

## 設定

`createImageGen(config)`:

| オプション | 既定値 | 説明 |
|---|---|---|
| `openaiApiKey` | なし（unavailable） | OpenAI Images API キー |
| `falKey` | なし（unavailable） | fal.ai API キー |
| `providers` | OpenAI + fal.ai | プロバイダレジストリの差し替え |
| `cacheGet` / `cacheSet` | インメモリ Map | `@torihanaku/cache` の `cacheGet`/`cacheSet` 互換で注入可 |
| `modelCacheTtlMs` | `300_000`（5 分） | モデル一覧キャッシュ TTL |
| `promptTransformer` | `enhancePromptWithBrand` | ブランドガイドライン等のプロンプト変換 |
| `sink` | なし（`uploadImage` は throw） | 生成画像の保存先コールバック |

同梱モデル: OpenAI `gpt-image-1-mini`（$0.019）/ `gpt-image-1`（$0.04）、fal.ai `fal-ai/flux-pro/v1.1`（$0.055）/ `fal-ai/flux/dev`（$0.025）/ `fal-ai/stable-diffusion-v35-large`（$0.065）。

## Runtime

- Node.js 18+ / Bun（グローバル `fetch` と `Buffer` を使用）
- 外部依存なし・`process.env` 参照なし（キーはすべて config 経由）
- peerDependencies なし

## 出典

`実運用SaaS` の `server/lib/image-generator.ts`（138 行）＋ `server/lib/image-providers/openai.ts`（96 行）＋ `server/lib/image-providers/fal.ts`（117 行）。移植差分: env 参照（`OPENAI_API_KEY` / `FAL_KEY`）→ config 注入、`uploadToSupabase()` → `ImageSink` コールバック、モジュールロード時のグローバルレジストリ → `createImageGen()` ファクトリ。ルーティング・サイズ検証・エラー文言・キャッシュ TTL は原典を維持。

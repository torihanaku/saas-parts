/**
 * @torihanaku/image-gen — 共通型定義
 * 出典: 実運用SaaS server/lib/image-generator.ts
 */

export interface ImageProvider {
  id: string;
  name: string;
  isAvailable(): boolean;
  listModels(): Promise<ImageModel[]>;
  generate(params: ImageGenParams): Promise<ImageGenResult>;
}

export interface ImageModel {
  id: string;
  name: string;
  provider: string;
  costPerImage: number;
  sizes: string[];
}

export interface ImageGenParams {
  prompt: string;
  model: string;
  size?: string;
  brandGuidelines?: string;
  /** リクエスト単位で API キーを上書き (BYOK) */
  apiKey?: string;
}

export interface ImageGenResult {
  imageBuffer: Buffer;
  revisedPrompt?: string;
  model: string;
  provider: string;
  width: number;
  height: number;
  costUsd: number;
}

/** 生成画像の保存先コールバック (例: @torihanaku/storage-upload) */
export type ImageSink = (input: {
  tenantId: string;
  imageBuffer: Buffer;
  filename: string;
  contentType: string;
}) => Promise<ImageSinkResult>;

export interface ImageSinkResult {
  storagePath: string;
  storageUrl: string;
}

/**
 * OpenAI text-embedding-3-small provider.
 *
 * Ported from 実運用SaaS `server/lib/embedding-providers/openai.ts`.
 * Product coupling removed: the API key is a required factory argument
 * (originally fell back to `env.OPENAI_API_KEY`).
 */

import type { EmbeddingProvider } from "../types";
import { EmbeddingProviderError } from "../types";

const ENDPOINT = "https://api.openai.com/v1/embeddings";
const MODEL = "text-embedding-3-small";
const DIM = 1536;
const BATCH_LIMIT = 100;

interface OpenAIEmbeddingResponse {
  data: { embedding: number[]; index: number }[];
}

async function callOpenAI(input: string | string[], apiKey: string): Promise<number[][]> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: MODEL, input }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new EmbeddingProviderError(
      `OpenAI embeddings failed: ${res.status} ${res.statusText} ${body.slice(0, 200)}`,
      "openai-3-small",
    );
  }

  const json = (await res.json()) as OpenAIEmbeddingResponse;
  // Sort by index to preserve input order (OpenAI returns sorted but be defensive)
  const sorted = [...json.data].sort((a, b) => a.index - b.index);
  return sorted.map((d) => d.embedding);
}

export function createOpenAIProvider(apiKey: string): EmbeddingProvider {
  if (!apiKey) {
    throw new EmbeddingProviderError(
      "apiKey is required; cannot create OpenAI embedding provider",
      "openai-3-small",
    );
  }

  return {
    slug: "openai-3-small",
    dimension: DIM,
    maxInputTokens: 8000,

    async embed(text: string): Promise<number[]> {
      const [vec] = await callOpenAI(text, apiKey);
      if (!vec || vec.length !== DIM) {
        throw new EmbeddingProviderError(
          `OpenAI returned unexpected dimension: ${vec?.length}`,
          "openai-3-small",
        );
      }
      return vec;
    },

    async embedBatch(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += BATCH_LIMIT) {
        const chunk = texts.slice(i, i + BATCH_LIMIT);
        const vecs = await callOpenAI(chunk, apiKey);
        if (vecs.length !== chunk.length) {
          throw new EmbeddingProviderError(
            `OpenAI returned ${vecs.length} vectors for ${chunk.length} inputs`,
            "openai-3-small",
          );
        }
        out.push(...vecs);
      }
      return out;
    },
  };
}

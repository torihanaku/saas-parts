/**
 * Multi-provider embedding registry.
 *
 * Ported from 実運用SaaS `server/lib/embedding-client.ts`.
 * Central abstraction so that callers use `embedText` / `embedBatch`
 * without knowing which provider is active.
 *
 * Product coupling removed:
 * - Primary provider selection was `env.EMBEDDING_PRIMARY_MODEL` — now set
 *   via `setPrimaryProvider(slug)` (default stays "openai-3-small").
 * - The consent check (`feature-flags.isEnabled("consentGuard")` +
 *   `consent-guard.requireConsent`) is now an injectable guard callback:
 *   `setEmbedGuard(guard)`. When no guard is set, embeds proceed (same as
 *   the flag being off).
 *
 * Adding new providers:
 *   1. Implement EmbeddingProvider in src/providers/<name>.ts
 *   2. Register at startup: registerProvider(createXxxProvider(apiKey))
 *   3. Optionally setPrimaryProvider("<slug>") to make it primary
 */

import type { EmbeddingProvider } from "./types";
import { EmbeddingProviderError } from "./types";

const providers = new Map<string, EmbeddingProvider>();
const DEFAULT_PRIMARY = "openai-3-small";

/** Primary provider slug (was env EMBEDDING_PRIMARY_MODEL). undefined = DEFAULT_PRIMARY. */
let primarySlug: string | undefined;

/**
 * Set the primary provider slug used when `embedText` / `embedBatch` is
 * called without an explicit slug. Pass undefined to fall back to the
 * default ("openai-3-small").
 */
export function setPrimaryProvider(slug: string | undefined): void {
  primarySlug = slug;
}

// ─── Injectable consent guard (was consent-guard + feature-flags) ────────────

export interface EmbedGuardContext {
  userId: string;
  tenantId: string;
  /** Consent purpose. Default: "ai_learning" (source behavior). */
  purpose: string;
}

/** Throw to block the embed (e.g. consent missing). */
export type EmbedGuard = (ctx: EmbedGuardContext) => Promise<void>;

let embedGuard: EmbedGuard | null = null;

/** Install a guard invoked before each embed when userId+tenantId are supplied. */
export function setEmbedGuard(guard: EmbedGuard | null): void {
  embedGuard = guard;
}

export interface EmbedOptions {
  userId?: string;
  tenantId?: string;
  purpose?: string;
}

async function runGuard(options?: EmbedOptions): Promise<void> {
  if (embedGuard && options?.userId && options?.tenantId) {
    await embedGuard({
      userId: options.userId,
      tenantId: options.tenantId,
      purpose: options.purpose || "ai_learning",
    });
  }
}

// ─── Registry ─────────────────────────────────────────────────────────────────

export function registerProvider(p: EmbeddingProvider): void {
  providers.set(p.slug, p);
}

export function clearProviders(): void {
  providers.clear();
}

export function listProviders(): { slug: string; dimension: number }[] {
  return Array.from(providers.values()).map((p) => ({ slug: p.slug, dimension: p.dimension }));
}

export function getProvider(slug?: string): EmbeddingProvider {
  const key = slug ?? primarySlug ?? DEFAULT_PRIMARY;
  const provider = providers.get(key);
  if (!provider) {
    throw new EmbeddingProviderError(
      `No embedding provider registered for slug "${key}". Registered: ${Array.from(providers.keys()).join(", ") || "(none)"}`,
      key,
    );
  }
  return provider;
}

export async function embedText(
  text: string,
  slug?: string,
  options?: EmbedOptions,
): Promise<number[]> {
  await runGuard(options);
  return getProvider(slug).embed(text);
}

export async function embedBatch(
  texts: string[],
  slug?: string,
  options?: EmbedOptions,
): Promise<number[][]> {
  await runGuard(options);
  return getProvider(slug).embedBatch(texts);
}

export { EmbeddingProviderError };
export type { EmbeddingProvider } from "./types";

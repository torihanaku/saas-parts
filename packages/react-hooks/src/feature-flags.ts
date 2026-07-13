/**
 * Client-side feature-flag hook with a module-level cache (fetch once per
 * factory instance, shared by all consumers).
 *
 * Ported from 実運用SaaS `src/hooks/useFeatureFlags.ts`.
 * Product coupling removed:
 *   - the hardcoded product flag list      -> `defaults` you pass in
 *   - the hardcoded `/api/config/features` -> `endpoint` config
 *   - the raw `fetch` call                 -> optional injected `fetcher`
 */
import { useState, useEffect } from "react";

export interface CreateFeatureFlagsOptions<TFlags extends Record<string, boolean>> {
  /** Flag values used before the server responds (and when the fetch fails). */
  defaults: TFlags;
  /** Endpoint the default fetcher GETs. Default: `/api/config/features`. */
  endpoint?: string;
  /**
   * Custom flag loader. Return `null` to keep the defaults (equivalent to a
   * non-OK response in the original). Overrides `endpoint`.
   */
  fetcher?: () => Promise<TFlags | null>;
}

export function createFeatureFlags<TFlags extends Record<string, boolean>>(
  options: CreateFeatureFlagsOptions<TFlags>,
) {
  const endpoint = options.endpoint ?? "/api/config/features";

  const loadFlags: () => Promise<TFlags | null> =
    options.fetcher ??
    (async () => {
      const res = await fetch(endpoint);
      if (!res.ok) return null;
      return res.json() as Promise<TFlags>;
    });

  let cachedFlags: TFlags | null = null;

  function useFeatureFlags() {
    const [flags, setFlags] = useState<TFlags>(cachedFlags || options.defaults);
    const [loading, setLoading] = useState(!cachedFlags);

    useEffect(() => {
      if (cachedFlags) return;
      let cancelled = false;
      loadFlags()
        .then((data) => {
          if (cancelled) return;
          if (!data) {
            setLoading(false);
            return;
          }
          cachedFlags = data;
          setFlags(data);
          setLoading(false);
        })
        .catch(() => {
          if (!cancelled) setLoading(false);
        });
      return () => { cancelled = true; };
    }, []);

    return { flags, loading };
  }

  /** Drop the cache so the next mount refetches (useful in tests/logout). */
  function clearCache(): void {
    cachedFlags = null;
  }

  return { useFeatureFlags, clearCache };
}

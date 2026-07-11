// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import { createFeatureFlags } from './feature-flags';

const DEFAULTS = { ai: true, billing: false };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('createFeatureFlags', () => {
  it('starts with defaults and loading=true, then applies fetched flags', async () => {
    const { useFeatureFlags } = createFeatureFlags({
      defaults: DEFAULTS,
      fetcher: async () => ({ ai: false, billing: true }),
    });

    const { result } = renderHook(() => useFeatureFlags());
    expect(result.current.flags).toEqual(DEFAULTS);
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.flags).toEqual({ ai: false, billing: true });
  });

  it('keeps defaults when the fetcher returns null (non-OK response)', async () => {
    const { useFeatureFlags } = createFeatureFlags({
      defaults: DEFAULTS,
      fetcher: async () => null,
    });

    const { result } = renderHook(() => useFeatureFlags());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.flags).toEqual(DEFAULTS);
  });

  it('keeps defaults when the fetcher throws', async () => {
    const { useFeatureFlags } = createFeatureFlags({
      defaults: DEFAULTS,
      fetcher: async () => { throw new Error('network'); },
    });

    const { result } = renderHook(() => useFeatureFlags());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.flags).toEqual(DEFAULTS);
  });

  it('caches flags across mounts (fetcher runs once) until clearCache()', async () => {
    const fetcher = vi.fn(async () => ({ ai: false, billing: true }));
    const { useFeatureFlags, clearCache } = createFeatureFlags({ defaults: DEFAULTS, fetcher });

    const first = renderHook(() => useFeatureFlags());
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    first.unmount();

    const second = renderHook(() => useFeatureFlags());
    expect(second.result.current.loading).toBe(false);
    expect(second.result.current.flags).toEqual({ ai: false, billing: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
    second.unmount();

    clearCache();
    const third = renderHook(() => useFeatureFlags());
    await waitFor(() => expect(third.result.current.loading).toBe(false));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('default fetcher GETs the configured endpoint', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ai: false, billing: false }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const { useFeatureFlags } = createFeatureFlags({
      defaults: DEFAULTS,
      endpoint: '/config/flags',
    });

    const { result } = renderHook(() => useFeatureFlags());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).toHaveBeenCalledWith('/config/flags');
    expect(result.current.flags).toEqual({ ai: false, billing: false });
  });
});

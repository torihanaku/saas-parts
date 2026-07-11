// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor, cleanup, act } from '@testing-library/react';
import { useFetch } from './useFetch';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useFetch', () => {
  it('loads JSON and exposes data/loading', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify([{ id: 1 }]), { status: 200 })));

    const { result } = renderHook(() => useFetch<Array<{ id: number }>>('/api/users'));
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual([{ id: 1 }]);
    expect(result.current.error).toBeNull();
  });

  it('sets an error on non-OK responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));

    const { result } = renderHook(() => useFetch('/api/broken'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error?.message).toBe('HTTP 500');
    expect(result.current.data).toBeNull();
  });

  it('skips fetching when url is null', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useFetch(null));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.data).toBeNull();
  });

  it('refetch triggers a new request', async () => {
    let count = 0;
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ n: ++count }), { status: 200 })));

    const { result } = renderHook(() => useFetch<{ n: number }>('/api/counter'));
    await waitFor(() => expect(result.current.data).toEqual({ n: 1 }));

    act(() => result.current.refetch());
    await waitFor(() => expect(result.current.data).toEqual({ n: 2 }));
  });

  it('ignores responses that resolve after unmount (cancellation)', async () => {
    let resolveFetch: (r: Response) => void = () => {};
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((r) => { resolveFetch = r; })));

    const setStateSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { unmount } = renderHook(() => useFetch('/api/slow'));
    unmount();

    resolveFetch(new Response(JSON.stringify({}), { status: 200 }));
    await new Promise((r) => setTimeout(r, 10));
    // No React "setState on unmounted component" warnings were emitted.
    expect(setStateSpy).not.toHaveBeenCalled();
  });
});

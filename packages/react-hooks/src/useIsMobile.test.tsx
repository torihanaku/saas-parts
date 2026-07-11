// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, cleanup } from '@testing-library/react';
import { useIsMobile } from './useIsMobile';

type Listener = (e: { matches: boolean }) => void;

function stubMatchMedia(initialMatches: boolean) {
  const listeners = new Set<Listener>();
  const mql = {
    matches: initialMatches,
    addEventListener: (_: string, fn: Listener) => listeners.add(fn),
    removeEventListener: (_: string, fn: Listener) => listeners.delete(fn),
  };
  vi.stubGlobal('matchMedia', vi.fn(() => mql));
  return {
    emit(matches: boolean) {
      mql.matches = matches;
      listeners.forEach((fn) => fn({ matches }));
    },
    listeners,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useIsMobile', () => {
  it('returns the initial matchMedia state', () => {
    stubMatchMedia(true);
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(true);
  });

  it('updates when the media query changes', () => {
    const media = stubMatchMedia(false);
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);

    act(() => media.emit(true));
    expect(result.current).toBe(true);

    act(() => media.emit(false));
    expect(result.current).toBe(false);
  });

  it('removes the listener on unmount', () => {
    const media = stubMatchMedia(false);
    const { unmount } = renderHook(() => useIsMobile());
    expect(media.listeners.size).toBe(1);
    unmount();
    expect(media.listeners.size).toBe(0);
  });

  it('accepts a custom breakpoint query', () => {
    stubMatchMedia(false);
    renderHook(() => useIsMobile('(max-width: 480px)'));
    expect(window.matchMedia).toHaveBeenCalledWith('(max-width: 480px)');
  });
});

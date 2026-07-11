/**
 * Viewport detection hook for mobile-only UI surfaces.
 *
 * Single matchMedia listener so multiple consumers share work. SSR safe:
 * defaults to `false` when `window` is unavailable.
 *
 * Ported from dev-dashboard-v2 `src/hooks/useIsMobile.ts` (#1284 PWA-3).
 * The breakpoint is now injectable (default preserved: max-width 768px).
 */
import { useEffect, useState } from "react";

const MOBILE_BREAKPOINT = "(max-width: 768px)";

export function useIsMobile(breakpoint: string = MOBILE_BREAKPOINT): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(breakpoint).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia(breakpoint);
    const handler = (e: MediaQueryListEvent): void => setIsMobile(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [breakpoint]);

  return isMobile;
}

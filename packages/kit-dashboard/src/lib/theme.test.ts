import { describe, expect, it } from "vitest";
import {
  token,
  chartColorVar,
  resolveVar,
  resolveChartColor,
  FALLBACK_PALETTE,
  PALETTE_SIZE,
} from "./theme";

describe("token", () => {
  it("wraps a bare name into a var() with fallback", () => {
    expect(token("chart-1")).toBe("var(--chart-1, #4285f4)");
    expect(token("--foreground")).toBe("var(--foreground, #202124)");
  });

  it("omits fallback for unknown vars", () => {
    expect(token("--unknown-x")).toBe("var(--unknown-x)");
  });
});

describe("chartColorVar", () => {
  it("maps 0-based index to 1-based --chart-N", () => {
    expect(chartColorVar(0)).toBe("var(--chart-1, #4285f4)");
    expect(chartColorVar(3)).toBe("var(--chart-4, #34a853)");
  });

  it("cycles through the palette", () => {
    expect(chartColorVar(PALETTE_SIZE)).toBe(chartColorVar(0));
    expect(chartColorVar(PALETTE_SIZE + 2)).toBe(chartColorVar(2));
  });

  it("handles negative indexes without going out of range", () => {
    expect(chartColorVar(-1)).toBe(chartColorVar(PALETTE_SIZE - 1));
  });
});

describe("resolveVar (no DOM computed style)", () => {
  it("falls back to the built-in value when the var is empty/unresolvable", () => {
    // jsdom returns empty string for undefined custom properties → fallback
    expect(resolveVar("--chart-1")).toBe(FALLBACK_PALETTE[0]);
    expect(resolveChartColor(1)).toBe(FALLBACK_PALETTE[1]);
  });

  it("returns a generic fallback for unknown vars", () => {
    expect(resolveVar("--nope")).toBe("#000000");
  });
});

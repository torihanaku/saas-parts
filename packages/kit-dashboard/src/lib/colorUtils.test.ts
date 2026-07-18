import { afterEach, describe, expect, it } from "vitest";
import {
  getChartColor,
  getTrendColor,
  getColorScheme,
  setGlobalChartColors,
  getGlobalChartColors,
  COLOR_SCHEMES,
} from "./colorUtils";

afterEach(() => {
  // reset module-level override so tests don't leak
  setGlobalChartColors(undefined as unknown as string[]);
});

describe("getChartColor", () => {
  it("returns a themeable var() reference", () => {
    expect(getChartColor(0)).toBe("var(--chart-1, #4285f4)");
    expect(getChartColor(4)).toBe("var(--chart-5, #fa7b17)");
  });
});

describe("getTrendColor", () => {
  it("maps sign to trend tokens", () => {
    expect(getTrendColor(5)).toBe("var(--chart-positive, #34a853)");
    expect(getTrendColor(-5)).toBe("var(--chart-negative, #ea4335)");
    expect(getTrendColor(0)).toBe("var(--muted-foreground, #5f6368)");
  });
});

describe("getColorScheme", () => {
  it("returns a named scheme verbatim", () => {
    expect(getColorScheme("blue")).toEqual(COLOR_SCHEMES.blue);
  });

  it("repeats a custom color five times", () => {
    expect(getColorScheme("custom", "#123456")).toEqual([
      "#123456",
      "#123456",
      "#123456",
      "#123456",
      "#123456",
    ]);
  });

  it("falls back to the theme palette (var strings) for unknown schemes", () => {
    const scheme = getColorScheme("does-not-exist");
    expect(scheme).toHaveLength(5);
    expect(scheme[0]).toBe("var(--chart-1, #4285f4)");
  });
});

describe("global override", () => {
  it("uses an explicit palette when set, else falls back to theme vars", () => {
    expect(getGlobalChartColors()[0]).toBe("var(--chart-1, #4285f4)");
    setGlobalChartColors(["#111", "#222"]);
    expect(getGlobalChartColors()).toEqual(["#111", "#222"]);
  });
});

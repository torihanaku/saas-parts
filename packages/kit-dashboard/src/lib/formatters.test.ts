import { describe, expect, it } from "vitest";
import {
  formatCompact,
  formatNumber,
  formatPercent,
  formatDateShort,
  applyNumberFormat,
} from "./formatters";

describe("formatCompact", () => {
  it("shortens to K / M / B", () => {
    expect(formatCompact(1_234_567)).toBe("1.2M");
    expect(formatCompact(2_500)).toBe("2.5K");
    expect(formatCompact(3_000_000_000)).toBe("3.0B");
  });

  it("leaves small numbers as locale strings", () => {
    expect(formatCompact(999)).toBe("999");
  });
});

describe("formatNumber", () => {
  it("adds thousands separators", () => {
    expect(formatNumber(1234567)).toBe("1,234,567");
  });
});

describe("formatPercent", () => {
  it("prefixes a sign", () => {
    expect(formatPercent(12.4)).toBe("+12.4%");
    expect(formatPercent(-8.1)).toBe("-8.1%");
  });
});

describe("applyNumberFormat", () => {
  it("switches by format key", () => {
    expect(applyNumberFormat(1_500_000, "compact")).toBe("1.5M");
    expect(applyNumberFormat(1234, "comma")).toBe("1,234");
    expect(applyNumberFormat(42, "percent")).toBe("42.0%");
    expect(applyNumberFormat(1234)).toBe("1,234");
  });
});

describe("formatDateShort", () => {
  it("formats month/day", () => {
    // 2026-03-29 (month is 0-based in Date constructor)
    expect(formatDateShort(new Date(2026, 2, 29))).toBe("03/29");
  });
});

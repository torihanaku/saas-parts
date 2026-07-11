import { describe, it, expect } from "vitest";
import { formatDate, formatDateTime, formatDateShort, truncate } from "./format";

// Use noon UTC so local-timezone offsets cannot shift the calendar date
// in JST (UTC+9) or most western timezones used on dev machines/CI.
const ISO = "2024-03-05T12:00:00+09:00";

describe("formatDate", () => {
  it("formats as YYYY/MM/DD in ja-JP by default", () => {
    expect(formatDate(ISO)).toBe("2024/03/05");
  });

  it("accepts a locale override", () => {
    expect(formatDate(ISO, "en-US")).toBe("03/05/2024");
  });
});

describe("formatDateTime", () => {
  it("includes hour and minute (ja-JP default)", () => {
    const out = formatDateTime(ISO);
    expect(out).toContain("2024/03/05");
    expect(out).toMatch(/\d{1,2}:\d{2}/);
  });

  it("accepts a locale override", () => {
    const out = formatDateTime(ISO, "en-US");
    expect(out).toContain("03/05/2024");
    expect(out).toMatch(/\d{1,2}:\d{2}/);
  });
});

describe("formatDateShort", () => {
  it("uses short month in ja-JP by default", () => {
    expect(formatDateShort(ISO)).toBe("2024年3月5日");
  });

  it("accepts a locale override", () => {
    expect(formatDateShort(ISO, "en-US")).toBe("Mar 5, 2024");
  });
});

describe("truncate", () => {
  it("returns text unchanged when within maxLen", () => {
    expect(truncate("hello", 10)).toBe("hello");
    expect(truncate("hello", 5)).toBe("hello");
  });

  it("truncates and appends ellipsis when over maxLen", () => {
    expect(truncate("hello world", 5)).toBe("hello...");
  });

  it("returns empty string for empty/undefined-ish input", () => {
    expect(truncate("", 5)).toBe("");
  });
});

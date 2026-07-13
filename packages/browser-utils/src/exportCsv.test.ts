// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { exportToCsv, neutralizeCsvValue } from "./exportCsv";

describe("exportToCsv", () => {
  let capturedBlob: Blob | null;
  let clickSpy: ReturnType<typeof vi.spyOn>;
  let revokeSpy: ReturnType<typeof vi.fn>;
  let lastAnchor: HTMLAnchorElement | null;

  beforeEach(() => {
    capturedBlob = null;
    lastAnchor = null;
    // jsdom does not implement createObjectURL — mock it and capture the blob.
    URL.createObjectURL = vi.fn((blob: Blob) => {
      capturedBlob = blob;
      return "blob:mock-url";
    }) as unknown as typeof URL.createObjectURL;
    revokeSpy = vi.fn();
    URL.revokeObjectURL = revokeSpy as unknown as typeof URL.revokeObjectURL;
    clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        lastAnchor = this;
      });
  });

  afterEach(() => {
    clickSpy.mockRestore();
  });

  it("does nothing for empty rows", () => {
    exportToCsv("empty", []);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it("builds CSV with headers, prepends UTF-8 BOM, and triggers download", async () => {
    exportToCsv("report", [
      { name: "Alice", age: 30, active: true },
      { name: "Bob", age: 25, active: false },
    ]);

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(lastAnchor?.getAttribute("href")).toBe("blob:mock-url");
    expect(lastAnchor?.download).toBe("report.csv");
    expect(revokeSpy).toHaveBeenCalledWith("blob:mock-url");

    expect(capturedBlob).not.toBeNull();
    expect(capturedBlob!.type).toBe("text/csv;charset=utf-8;");
    // Blob.text() strips a leading BOM during UTF-8 decoding, so check raw bytes.
    const bytes = new Uint8Array(await capturedBlob!.arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM
    const text = await capturedBlob!.text(); // BOM already stripped by decoder
    expect(text).toBe("name,age,active\nAlice,30,true\nBob,25,false");
  });

  it("escapes commas, quotes and newlines; null/undefined become empty", async () => {
    exportToCsv("escaped", [
      { a: 'he said "hi"', b: "x,y", c: "line1\nline2", d: null, e: undefined },
    ]);

    const text = await capturedBlob!.text(); // BOM stripped by UTF-8 decoder
    expect(text).toBe('a,b,c,d,e\n"he said ""hi""","x,y","line1\nline2",,');
  });

  // ─── CSV formula injection (OWASP CSV Injection) ─────────────────
  it("neutralizeCsvValue prefixes formula-triggering leading chars with '", () => {
    expect(neutralizeCsvValue("=1+1")).toBe("'=1+1");
    expect(neutralizeCsvValue("+cmd")).toBe("'+cmd");
    expect(neutralizeCsvValue("-2+3")).toBe("'-2+3");
    expect(neutralizeCsvValue("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(neutralizeCsvValue('=HYPERLINK("http://evil","x")')).toBe(
      '\'=HYPERLINK("http://evil","x")'
    );
    expect(neutralizeCsvValue("\tTAB")).toBe("'\tTAB");
    expect(neutralizeCsvValue("\rCR")).toBe("'\rCR");
    // Non-triggering values pass through unchanged.
    expect(neutralizeCsvValue("Alice")).toBe("Alice");
    expect(neutralizeCsvValue("a=b")).toBe("a=b"); // trigger not leading
    expect(neutralizeCsvValue(30)).toBe("30");
    expect(neutralizeCsvValue(null)).toBe("");
    expect(neutralizeCsvValue(undefined)).toBe("");
  });

  it("neutralizes formula injection in exported cells (=,+,-,@)", async () => {
    exportToCsv("attack", [
      { formula: "=1+1", cmd: "@SUM(A1:A9)", neg: "-9", pos: "+9", safe: "hi" },
    ]);
    const text = await capturedBlob!.text();
    // Each triggering cell gets a leading ' so the spreadsheet treats it as text.
    // The ' does not require quoting, so columns are unaffected.
    expect(text).toBe("formula,cmd,neg,pos,safe\n'=1+1,'@SUM(A1:A9),'-9,'+9,hi");
  });

  it("quotes a lone CR so it cannot break a row", async () => {
    exportToCsv("cr", [{ a: "line1\rline2" }]);
    const text = await capturedBlob!.text();
    // Value contains \r -> must be wrapped in quotes (stays one field).
    expect(text).toBe('a\n"line1\rline2"');
  });
});

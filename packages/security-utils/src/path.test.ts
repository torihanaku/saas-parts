import { describe, it, expect } from "vitest";
import { safeJoin } from "./path";

describe("safeJoin", () => {
  it("resolves a normal request path under the root", () => {
    expect(safeJoin("/app/public", "/avatars/logo.png")).toBe("/app/public/avatars/logo.png");
  });

  it("keeps traversal that stays inside the root", () => {
    expect(safeJoin("/app/public", "/avatars/../secret.txt")).toBe("/app/public/secret.txt");
  });

  it("rejects traversal that escapes the root", () => {
    expect(safeJoin("/app/public", "/avatars/../../secret.txt")).toBeNull();
  });

  it("rejects URL-encoded traversal outside the root", () => {
    expect(safeJoin("/app/public", "/avatars/%2e%2e/%2e%2e/secret.txt")).toBeNull();
  });

  it("returns the root itself for an empty request path", () => {
    expect(safeJoin("/app/public", "")).toBe("/app/public");
  });

  it("returns null for malformed percent-encoding", () => {
    expect(safeJoin("/app/public", "/%zz")).toBeNull();
  });

  it("strips leading slashes/backslashes before resolving", () => {
    expect(safeJoin("/app/public", "\\\\evil/file.txt")).toBe("/app/public/evil/file.txt");
  });
});

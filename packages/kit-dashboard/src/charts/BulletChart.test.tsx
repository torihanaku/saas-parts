// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { BulletChart } from "./BulletChart";

beforeAll(() => {
  // jsdom には ResizeObserver が無い。width を明示するので中身は空実装で十分。
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

afterEach(cleanup);

describe("BulletChart", () => {
  it("renders one <svg> row per item without crashing", () => {
    const { container } = render(
      <BulletChart
        width={600}
        items={[
          { label: "A", value: 80, target: 100, max: 120 },
          { label: "B", value: 45, target: 50, max: 60 },
        ]}
      />,
    );
    // 各アイテムが1行=1 svg を描く
    expect(container.querySelectorAll("svg")).toHaveLength(2);
    // 行内に少なくとも1本の値バー(rect)が引かれている
    expect(container.querySelectorAll("rect").length).toBeGreaterThan(0);
  });

  it("themes value bar and target marker with CSS-variable colors (theme-following)", () => {
    const { container } = render(
      <BulletChart
        width={600}
        items={[{ label: "A", value: 80, target: 100, max: 120 }]}
      />,
    );
    // 値バーの塗りは var(--chart-1) 系（ダーク追従）
    const fills = Array.from(container.querySelectorAll("rect")).map((r) =>
      r.getAttribute("fill"),
    );
    expect(fills.some((f) => f?.includes("var(--chart"))).toBe(true);
    // 目標三角マーカーは foreground トークンを参照
    const path = container.querySelector("path");
    expect(path?.getAttribute("fill")).toContain("var(--foreground");
  });
});

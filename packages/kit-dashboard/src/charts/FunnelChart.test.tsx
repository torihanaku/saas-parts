// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { FunnelChart } from "./FunnelChart";

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

describe("FunnelChart", () => {
  it("renders one <path.funnel-bar> per step without crashing", () => {
    const { container } = render(
      <FunnelChart
        width={600}
        height={340}
        animated={false}
        data={[
          { label: "認知", value: 1000 },
          { label: "検討", value: 400 },
          { label: "購入", value: 120 },
        ]}
      />,
    );
    expect(container.querySelector("svg")).toBeTruthy();
    expect(container.querySelectorAll("path.funnel-bar")).toHaveLength(3);
  });

  it("themes step labels and drop-off with CSS-variable colors (theme-following)", () => {
    const { container } = render(
      <FunnelChart width={600} height={340} animated={false} showRate />,
    );
    // 右側のステップラベルは --foreground 由来（ダーク追従の担保）
    const texts = Array.from(container.querySelectorAll("text"));
    const hasForeground = texts.some((t) =>
      (t.getAttribute("fill") ?? "").includes("var(--foreground"),
    );
    expect(hasForeground).toBe(true);
    // ドロップオフ表示は --chart-negative 由来
    const hasNegative = texts.some((t) =>
      (t.getAttribute("fill") ?? "").includes("var(--chart-negative"),
    );
    expect(hasNegative).toBe(true);
  });
});

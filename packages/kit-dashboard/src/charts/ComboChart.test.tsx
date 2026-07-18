// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ComboChart } from "./ComboChart";

beforeAll(() => {
  // jsdom には ResizeObserver が無い。width を明示するので空実装で十分。
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

afterEach(cleanup);

describe("ComboChart", () => {
  it("renders one bar and one line-dot per data point without crashing", () => {
    const { container } = render(
      <ComboChart
        width={600}
        height={320}
        animated={false}
        data={[
          { label: "1月", barValue: 320, lineValue: 12.5 },
          { label: "2月", barValue: 380, lineValue: 14.2 },
          { label: "3月", barValue: 410, lineValue: 13.8 },
        ]}
      />,
    );
    expect(container.querySelector("svg")).toBeTruthy();
    expect(container.querySelectorAll("rect.bar-single")).toHaveLength(3);
    expect(container.querySelectorAll("circle.line-dot")).toHaveLength(3);
  });

  it("themes axis with CSS-variable colors and bars use var() fills (theme-following)", () => {
    const { container } = render(
      <ComboChart width={600} height={320} animated={false} />,
    );
    const axisText = container.querySelector("g text");
    expect(axisText?.getAttribute("fill")).toContain("var(--muted-foreground");
    const bar = container.querySelector("rect.bar-single");
    expect(bar?.getAttribute("fill")).toContain("var(");
  });

  it("renders grouped bars when barVariant=grouped with barValue2", () => {
    const { container } = render(
      <ComboChart
        width={600}
        height={320}
        animated={false}
        barVariant="grouped"
        data={[
          { label: "A", barValue: 100, barValue2: 60, lineValue: 10 },
          { label: "B", barValue: 120, barValue2: 80, lineValue: 12 },
        ]}
      />,
    );
    expect(container.querySelectorAll("rect.bar-primary")).toHaveLength(2);
    expect(container.querySelectorAll("rect.bar-secondary")).toHaveLength(2);
  });
});

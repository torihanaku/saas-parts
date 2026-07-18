// @vitest-environment jsdom
import { createRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ChartTooltip } from "./ChartTooltip";

afterEach(cleanup);

describe("ChartTooltip (imperative / ref)", () => {
  it("renders a pointer-events-none tooltip div exposed via ref", () => {
    const ref = createRef<HTMLDivElement>();
    const { container } = render(<ChartTooltip ref={ref} />);
    const el = ref.current ?? (container.firstChild as HTMLDivElement);
    expect(el).toBeTruthy();
    expect(el.className).toContain("pointer-events-none");
    // 既定は非表示（opacity 0）。useTooltip が ref 経由で opacity/left/top/textContent を書き込む。
    expect(el.style.opacity).toBe("0");
  });

  it("references shadcn popover tokens so it follows the host theme", () => {
    const ref = createRef<HTMLDivElement>();
    render(<ChartTooltip ref={ref} />);
    expect(ref.current?.style.background).toContain("var(--popover");
  });

  it("can be updated imperatively (no React re-render needed)", () => {
    const ref = createRef<HTMLDivElement>();
    render(<ChartTooltip ref={ref} />);
    const el = ref.current!;
    el.textContent = "Revenue: ¥240K";
    el.style.left = "40px";
    el.style.top = "20px";
    el.style.opacity = "1";
    expect(el.textContent).toBe("Revenue: ¥240K");
    expect(el.style.left).toBe("40px");
    expect(el.style.opacity).toBe("1");
  });
});

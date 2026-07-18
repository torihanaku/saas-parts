// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ChartTooltip } from "./ChartTooltip";

afterEach(cleanup);

describe("ChartTooltip", () => {
  it("renders content and positions absolutely", () => {
    const { getByText } = render(
      <ChartTooltip x={40} y={20} content="Revenue: ¥240K" visible />,
    );
    const el = getByText("Revenue: ¥240K");
    expect(el).toBeTruthy();
    expect(el.style.left).toBe("40px");
    expect(el.style.top).toBe("20px");
    expect(el.style.opacity).toBe("1");
  });

  it("is invisible (opacity 0) when not visible", () => {
    const { getByText } = render(
      <ChartTooltip x={0} y={0} content="hidden" visible={false} />,
    );
    expect(getByText("hidden").style.opacity).toBe("0");
  });

  it("references shadcn popover tokens so it follows the host theme", () => {
    const { getByText } = render(
      <ChartTooltip x={0} y={0} content="tok" visible />,
    );
    expect(getByText("tok").style.background).toContain("var(--popover");
  });
});

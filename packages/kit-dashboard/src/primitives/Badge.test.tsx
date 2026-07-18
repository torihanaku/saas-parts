// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { Badge } from "./Badge";

afterEach(cleanup);

describe("Badge", () => {
  it("renders the label text", () => {
    const { getByText } = render(<Badge label="稼働中" variant="positive" />);
    expect(getByText("稼働中")).toBeTruthy();
  });

  it("maps variants to theme tokens (var()/color-mix), not hardcoded hex", () => {
    const { getByText } = render(<Badge label="警告" variant="warning" />);
    const el = getByText("警告") as HTMLElement;
    const style = el.getAttribute("style") ?? "";
    // warning → CHART_WARNING = var(--chart-warning, ...)
    expect(style).toContain("var(--chart-warning");
    expect(style).toContain("color-mix");
  });

  it("default variant uses muted tokens", () => {
    const { getByText } = render(<Badge label="既定" />);
    const style = (getByText("既定") as HTMLElement).getAttribute("style") ?? "";
    expect(style).toContain("var(--muted");
  });
});

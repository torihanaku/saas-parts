// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { DashboardGrid } from "./DashboardGrid";

afterEach(cleanup);

describe("DashboardGrid", () => {
  it("renders each child (CSS grid fallback when react-grid-layout absent)", () => {
    const { getByText } = render(
      <DashboardGrid columns={12} gap={16}>
        <div>widget-a</div>
        <div>widget-b</div>
        <div>widget-c</div>
      </DashboardGrid>,
    );
    expect(getByText("widget-a")).toBeTruthy();
    expect(getByText("widget-b")).toBeTruthy();
    expect(getByText("widget-c")).toBeTruthy();
  });

  it("applies column count and gap to the grid style", () => {
    const { container } = render(
      <DashboardGrid columns={4} gap={8}>
        <div>x</div>
      </DashboardGrid>,
    );
    const grid = container.firstElementChild as HTMLElement;
    expect(grid.style.gridTemplateColumns).toContain("repeat(4");
    expect(grid.style.gap).toBe("8px");
  });
});

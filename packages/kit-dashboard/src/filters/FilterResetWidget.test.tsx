// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { FilterResetWidget } from "./FilterResetWidget";

afterEach(cleanup);

describe("FilterResetWidget", () => {
  it("renders label and active count when activeCount > 0", () => {
    const { getByRole } = render(
      <FilterResetWidget label="リセット" activeCount={3} />,
    );
    const btn = getByRole("button") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toContain("リセット");
    expect(btn.textContent).toContain("3");
    // active 背景は CHART_NEGATIVE(= var(--chart-negative ...)) を参照
    expect(btn.style.background).toContain("var(--chart-negative");
  });

  it("calls onReset on click when active", () => {
    const onReset = vi.fn();
    const { getByRole } = render(
      <FilterResetWidget activeCount={1} onReset={onReset} />,
    );
    fireEvent.click(getByRole("button"));
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("is disabled and does not fire onReset when activeCount is 0", () => {
    const onReset = vi.fn();
    const { getByRole } = render(
      <FilterResetWidget activeCount={0} onReset={onReset} />,
    );
    const btn = getByRole("button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(onReset).not.toHaveBeenCalled();
  });
});

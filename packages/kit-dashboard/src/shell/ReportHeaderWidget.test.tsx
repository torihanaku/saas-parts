// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ReportHeaderWidget } from "./ReportHeaderWidget";

afterEach(cleanup);

describe("ReportHeaderWidget", () => {
  it("renders title and subtitle", () => {
    const { getByText } = render(
      <ReportHeaderWidget title="週次売上" subtitle="2026 Q3" />,
    );
    expect(getByText("週次売上")).toBeTruthy();
    expect(getByText("2026 Q3")).toBeTruthy();
  });

  it("shows a clear-filters button only when activeFilterCount > 0 and calls onClearAll", () => {
    const onClearAll = vi.fn();
    const { getByRole, queryByRole, rerender } = render(
      <ReportHeaderWidget activeFilterCount={0} onClearAll={onClearAll} />,
    );
    expect(queryByRole("button")).toBeNull();

    rerender(
      <ReportHeaderWidget activeFilterCount={2} onClearAll={onClearAll} />,
    );
    const btn = getByRole("button");
    expect(btn.textContent).toContain("2");
    fireEvent.click(btn);
    expect(onClearAll).toHaveBeenCalledTimes(1);
  });
});

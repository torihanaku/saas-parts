// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FilterDateWidget } from "./FilterDateWidget";

afterEach(cleanup);

describe("FilterDateWidget", () => {
  it("renders label and preset buttons without crashing", () => {
    render(<FilterDateWidget label="期間" />);
    expect(screen.getByText("期間")).toBeTruthy();
    expect(screen.getByText("今日")).toBeTruthy();
    expect(screen.getByText("カスタム")).toBeTruthy();
  });

  it("emits a { start, end } range when a preset is selected", () => {
    const onChange = vi.fn();
    render(<FilterDateWidget onChange={onChange} />);
    fireEvent.click(screen.getByText("今日"));
    expect(onChange).toHaveBeenCalledTimes(1);
    const arg = onChange.mock.calls[0]![0];
    expect(arg).not.toBeNull();
    expect(arg.start).toBeInstanceOf(Date);
    expect(arg.end).toBeInstanceOf(Date);
  });

  it("emits custom range only when both dates are set", () => {
    const onChange = vi.fn();
    render(<FilterDateWidget onChange={onChange} />);
    fireEvent.click(screen.getByText("カスタム"));
    onChange.mockClear();
    fireEvent.change(screen.getByLabelText("開始日"), { target: { value: "2026-01-01" } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("終了日"), { target: { value: "2026-01-31" } });
    expect(onChange).toHaveBeenCalledTimes(1);
    const arg = onChange.mock.calls[0]![0];
    expect(arg.start.getFullYear()).toBe(2026);
    expect(arg.end.getDate()).toBe(31);
  });

  it("shows reset button when value prop is active and emits null on reset", () => {
    const onChange = vi.fn();
    render(
      <FilterDateWidget
        value={{ start: new Date(2026, 0, 1), end: new Date(2026, 0, 31) }}
        onChange={onChange}
      />,
    );
    const reset = screen.getByTitle("フィルターをリセット");
    fireEvent.click(reset);
    expect(onChange).toHaveBeenCalledWith(null);
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { DateRangePicker } from "./DateRangePicker";

afterEach(cleanup);

describe("DateRangePicker", () => {
  it("renders the trigger with the current range", () => {
    const value = {
      start: new Date(2026, 0, 1),
      end: new Date(2026, 0, 31),
    };
    const { getByRole } = render(<DateRangePicker value={value} />);
    expect(getByRole("button").textContent).toContain("〜");
  });

  it("fires onChange with a range when a preset is picked", () => {
    const onChange = vi.fn();
    const { getByRole, getByText } = render(
      <DateRangePicker onChange={onChange} />,
    );
    fireEvent.click(getByRole("button")); // open popup
    fireEvent.click(getByText("今日"));
    expect(onChange).toHaveBeenCalledTimes(1);
    const arg = onChange.mock.calls[0]![0] as { start: Date; end: Date };
    expect(arg.start).toBeInstanceOf(Date);
    expect(arg.end).toBeInstanceOf(Date);
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { FilterCheckboxWidget } from "./FilterCheckboxWidget";

afterEach(cleanup);

describe("FilterCheckboxWidget", () => {
  it("renders a checkbox per option plus the label", () => {
    const { container, getByText } = render(
      <FilterCheckboxWidget label="種別" options={["A", "B", "C"]} />,
    );
    expect(getByText("種別")).toBeTruthy();
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(3);
  });

  it("fires onChange with the accumulated checked values", () => {
    const onChange = vi.fn();
    const { container } = render(
      <FilterCheckboxWidget options={["A", "B"]} onChange={onChange} />,
    );
    const boxes = container.querySelectorAll('input[type="checkbox"]');
    fireEvent.click(boxes[0]!);
    expect(onChange).toHaveBeenLastCalledWith(["A"]);
    fireEvent.click(boxes[1]!);
    expect(onChange).toHaveBeenLastCalledWith(["A", "B"]);
  });

  it("reset button clears all and reports empty array", () => {
    const onChange = vi.fn();
    const { container } = render(
      <FilterCheckboxWidget
        options={["A", "B"]}
        defaultValue={["A"]}
        onChange={onChange}
      />,
    );
    const reset = container.querySelector("button")!;
    expect(reset).toBeTruthy();
    fireEvent.click(reset);
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("respects controlled value prop", () => {
    const { container } = render(
      <FilterCheckboxWidget options={["A", "B"]} value={["B"]} />,
    );
    const boxes = container.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    expect(boxes[0]!.checked).toBe(false);
    expect(boxes[1]!.checked).toBe(true);
  });
});

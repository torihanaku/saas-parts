// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { FilterListWidget } from "./FilterListWidget";

afterEach(cleanup);

describe("FilterListWidget", () => {
  it("renders a list item per option plus the label", () => {
    const { container, getByText } = render(
      <FilterListWidget label="都市" options={["東京", "大阪", "福岡"]} />,
    );
    expect(getByText("都市")).toBeTruthy();
    expect(container.querySelectorAll("li")).toHaveLength(3);
  });

  it("single-select: clicking reports one value, clicking again clears", () => {
    const onChange = vi.fn();
    const { container } = render(
      <FilterListWidget options={["東京", "大阪"]} onChange={onChange} />,
    );
    const items = container.querySelectorAll("li");
    fireEvent.click(items[0]!);
    expect(onChange).toHaveBeenLastCalledWith(["東京"]);
    fireEvent.click(items[0]!);
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("single-select: selecting a different item replaces the value", () => {
    const onChange = vi.fn();
    const { container } = render(
      <FilterListWidget options={["東京", "大阪"]} onChange={onChange} />,
    );
    const items = container.querySelectorAll("li");
    fireEvent.click(items[0]!);
    fireEvent.click(items[1]!);
    expect(onChange).toHaveBeenLastCalledWith(["大阪"]);
  });

  it("multi=true accumulates selections", () => {
    const onChange = vi.fn();
    const { container } = render(
      <FilterListWidget options={["東京", "大阪"]} multi onChange={onChange} />,
    );
    const items = container.querySelectorAll("li");
    fireEvent.click(items[0]!);
    fireEvent.click(items[1]!);
    expect(onChange).toHaveBeenLastCalledWith(["東京", "大阪"]);
  });

  it("controlled value marks the selected item", () => {
    const { container } = render(
      <FilterListWidget options={["東京", "大阪"]} value={["大阪"]} />,
    );
    const items = container.querySelectorAll("li");
    // selected item carries the font-medium class from the selected branch
    expect(items[1]!.className).toContain("font-medium");
    expect(items[0]!.className).not.toContain("font-medium");
  });
});

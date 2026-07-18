// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { FilterDropdownWidget } from "./FilterDropdownWidget";

afterEach(cleanup);

describe("FilterDropdownWidget", () => {
  it("renders the label, the すべて option, and all provided options", () => {
    const { container, getByText } = render(
      <FilterDropdownWidget label="地域" options={["東京", "大阪"]} />,
    );
    expect(getByText("地域")).toBeTruthy();
    const opts = container.querySelectorAll("option");
    // すべて + 2 = 3
    expect(opts).toHaveLength(3);
    expect(opts[0]!.textContent).toBe("すべて");
  });

  it("fires onChange with the value on selection and null on reset", () => {
    const onChange = vi.fn();
    const { container } = render(
      <FilterDropdownWidget options={["東京", "大阪"]} onChange={onChange} />,
    );
    const select = container.querySelector("select")!;
    fireEvent.change(select, { target: { value: "東京" } });
    expect(onChange).toHaveBeenLastCalledWith("東京");

    // reset button appears once a real value is selected (uncontrolled state)
    const reset = container.querySelector("button")!;
    expect(reset).toBeTruthy();
    fireEvent.click(reset);
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("selecting すべて reports null", () => {
    const onChange = vi.fn();
    const { container } = render(
      <FilterDropdownWidget
        options={["東京"]}
        defaultValue="東京"
        onChange={onChange}
      />,
    );
    fireEvent.change(container.querySelector("select")!, {
      target: { value: "all" },
    });
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("accepts newline-separated string options (back-compat)", () => {
    const { container } = render(
      <FilterDropdownWidget options={"A\nB\nC"} />,
    );
    expect(container.querySelectorAll("option")).toHaveLength(4);
  });

  it("swaps to child options when parentValue matches childOptions", () => {
    const { container } = render(
      <FilterDropdownWidget
        options={["ignored"]}
        childOptions={{ 東日本: ["東京", "神奈川"] }}
        parentValue="東日本"
      />,
    );
    const opts = Array.from(container.querySelectorAll("option")).map(
      (o) => o.textContent,
    );
    expect(opts).toEqual(["すべて", "東京", "神奈川"]);
  });
});

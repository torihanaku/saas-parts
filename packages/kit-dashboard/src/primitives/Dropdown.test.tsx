// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { Dropdown } from "./Dropdown";

afterEach(cleanup);

const OPTIONS = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta" },
];

describe("Dropdown", () => {
  it("renders label and placeholder when nothing selected", () => {
    const { getByText } = render(
      <Dropdown options={OPTIONS} label="区分" placeholder="未選択" />,
    );
    expect(getByText("区分")).toBeTruthy();
    expect(getByText("未選択")).toBeTruthy();
  });

  it("calls onChange with the selected value (single mode)", () => {
    const onChange = vi.fn();
    const { getByText } = render(
      <Dropdown options={OPTIONS} onChange={onChange} />,
    );
    // open menu
    fireEvent.click(getByText("選択してください"));
    fireEvent.click(getByText("Beta"));
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("toggles values as an array in multi mode", () => {
    const onChange = vi.fn();
    const { getByRole, getByText } = render(
      <Dropdown
        options={OPTIONS}
        multi
        value={["a"]}
        onChange={onChange}
      />,
    );
    // one value selected → trigger shows that option's label; open via the button
    fireEvent.click(getByRole("button"));
    fireEvent.click(getByText("Beta"));
    expect(onChange).toHaveBeenCalledWith(["a", "b"]);
  });
});

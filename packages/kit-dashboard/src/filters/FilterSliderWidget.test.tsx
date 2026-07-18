// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FilterSliderWidget } from "./FilterSliderWidget";

afterEach(cleanup);

describe("FilterSliderWidget", () => {
  it("renders label and current value without crashing", () => {
    render(<FilterSliderWidget label="スコア" min={0} max={100} defaultValue={42} />);
    expect(screen.getByText("スコア")).toBeTruthy();
    // 現在値表示（42）と最小ラベルがある
    expect(screen.getByText("42")).toBeTruthy();
    expect(screen.getByText("最小: 0")).toBeTruthy();
    const slider = screen.getByRole("slider") as HTMLInputElement;
    expect(slider.value).toBe("42");
  });

  it("calls onChange with the current value on pointer up (non-controlled)", () => {
    const onChange = vi.fn();
    render(<FilterSliderWidget min={0} max={100} defaultValue={0} onChange={onChange} />);
    const slider = screen.getByRole("slider") as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "73" } });
    fireEvent.pointerUp(slider);
    expect(onChange).toHaveBeenCalledWith(73);
  });

  it("reflects controlled value prop", () => {
    render(<FilterSliderWidget min={0} max={100} value={88} />);
    const slider = screen.getByRole("slider") as HTMLInputElement;
    expect(slider.value).toBe("88");
    expect(screen.getByText("88")).toBeTruthy();
  });
});

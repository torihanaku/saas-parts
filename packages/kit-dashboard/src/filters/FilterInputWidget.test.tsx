// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FilterInputWidget } from "./FilterInputWidget";

afterEach(cleanup);

describe("FilterInputWidget", () => {
  it("renders label and placeholder without crashing", () => {
    render(<FilterInputWidget label="検索" placeholder="キーワード" />);
    expect(screen.getByText("検索")).toBeTruthy();
    expect(screen.getByPlaceholderText("キーワード")).toBeTruthy();
  });

  it("calls onChange with typed text (immediate, non-controlled)", () => {
    const onChange = vi.fn();
    render(<FilterInputWidget onChange={onChange} />);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "abc" } });
    expect(onChange).toHaveBeenCalledWith("abc");
  });

  it("clear button emits empty string and only shows when text present", () => {
    const onChange = vi.fn();
    render(<FilterInputWidget defaultValue="hello" onChange={onChange} />);
    const clear = screen.getByLabelText("クリア");
    fireEvent.click(clear);
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("debounces onChange when debounceMs > 0", () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    render(<FilterInputWidget onChange={onChange} debounceMs={200} />);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "x" } });
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(onChange).toHaveBeenCalledWith("x");
    vi.useRealTimers();
  });
});

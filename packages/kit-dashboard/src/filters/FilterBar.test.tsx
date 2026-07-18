// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { FilterBar } from "./FilterBar";

afterEach(cleanup);

const FILTERS = [
  {
    key: "region",
    label: "地域",
    options: [
      { value: "east", label: "東日本" },
      { value: "west", label: "西日本" },
    ],
  },
];

describe("FilterBar", () => {
  it("renders each filter label and the date range trigger", () => {
    const { getByText, getAllByRole } = render(
      <FilterBar filters={FILTERS} />,
    );
    expect(getByText("地域")).toBeTruthy();
    // date range trigger + dropdown trigger => at least 2 buttons
    expect(getAllByRole("button").length).toBeGreaterThanOrEqual(2);
  });

  it("calls onFilterChange when a dropdown option is chosen", () => {
    const onFilterChange = vi.fn();
    const { getByText } = render(
      <FilterBar
        filters={FILTERS}
        showDateRange={false}
        onFilterChange={onFilterChange}
      />,
    );
    fireEvent.click(getByText("選択してください"));
    fireEvent.click(getByText("西日本"));
    expect(onFilterChange).toHaveBeenCalledWith("region", "west");
  });
});

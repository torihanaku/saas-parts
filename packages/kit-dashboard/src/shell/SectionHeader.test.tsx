// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { SectionHeader } from "./SectionHeader";

afterEach(cleanup);

describe("SectionHeader", () => {
  it("renders title and subtitle", () => {
    const { getByText } = render(
      <SectionHeader title="収益" subtitle="前年比" />,
    );
    expect(getByText("収益")).toBeTruthy();
    expect(getByText("前年比")).toBeTruthy();
  });

  it("uses a theme-following default stripe color (var-based)", () => {
    const { container } = render(<SectionHeader title="x" />);
    const stripe = container.querySelector("span");
    expect(stripe?.getAttribute("style")).toContain("var(");
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { TextBox } from "./TextBox";

afterEach(cleanup);

describe("TextBox", () => {
  it("renders the text prop", () => {
    const { getByText } = render(<TextBox text="こんにちは" />);
    expect(getByText("こんにちは")).toBeTruthy();
  });

  it("prefers children over text and falls back to placeholder", () => {
    const { getByText } = render(
      <TextBox text="ignored">
        <span>child</span>
      </TextBox>,
    );
    expect(getByText("child")).toBeTruthy();

    const { container } = render(<TextBox />);
    expect(container.textContent).toContain("テキストを入力してください");
  });
});

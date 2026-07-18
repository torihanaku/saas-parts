// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { TableChart, type TableColumn } from "./TableChart";

afterEach(cleanup);

const COLUMNS: TableColumn[] = [
  { key: "name", label: "名前", type: "string", sortable: true },
  { key: "leads", label: "リード", type: "number", sortable: true },
  { key: "rate", label: "率", type: "percent" },
];

const DATA = [
  { name: "A", leads: 120, rate: 0.85 },
  { name: "B", leads: 90, rate: 0.42 },
  { name: "C", leads: 60, rate: 0.31 },
];

describe("TableChart", () => {
  it("renders a <table> with one <th> per column and rows of <td>", () => {
    const { container } = render(<TableChart columns={COLUMNS} data={DATA} />);
    expect(container.querySelector("table")).toBeTruthy();
    // 3 columns → 3 header cells
    expect(container.querySelectorAll("thead th")).toHaveLength(3);
    // 3 rows × 3 columns → 9 body cells
    expect(container.querySelectorAll("tbody td")).toHaveLength(9);
  });

  it("uses shadcn CSS-variable border tokens (theme-following)", () => {
    const { container } = render(<TableChart columns={COLUMNS} data={DATA} />);
    const td = container.querySelector("tbody td");
    // 罫線・文字色は shadcn トークンを参照する（ダーク追従）
    expect(td?.getAttribute("class") ?? "").toContain(
      "border-[color:var(--border)]",
    );
    expect(td?.getAttribute("class") ?? "").toContain(
      "text-[color:var(--foreground)]",
    );
  });

  it("renders a total row when showTotalRow is set", () => {
    const { container } = render(
      <TableChart columns={COLUMNS} data={DATA} showTotalRow />,
    );
    expect(container.querySelector("tfoot")).toBeTruthy();
    // total row has one cell per column
    expect(container.querySelectorAll("tfoot td")).toHaveLength(3);
  });
});

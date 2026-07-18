// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  PivotTable,
  PIVOT_DEFAULT_COLS,
  PIVOT_DEFAULT_DATA,
  PIVOT_DEFAULT_ROWS,
} from "./PivotTable";

afterEach(cleanup);

describe("PivotTable", () => {
  it("renders a <table> with the expected header/body cell counts", () => {
    const { container } = render(
      <PivotTable
        data={PIVOT_DEFAULT_DATA}
        rows={PIVOT_DEFAULT_ROWS}
        cols={PIVOT_DEFAULT_COLS}
        rowLabel="チャネル"
      />,
    );
    const table = container.querySelector("table");
    expect(table).toBeTruthy();

    // ヘッダ: 行ラベル列(1) + 各列(6) = 7 個の <th>（showTotals=false）。
    expect(container.querySelectorAll("thead th")).toHaveLength(
      PIVOT_DEFAULT_COLS.length + 1,
    );

    // 本体: 3 行 × (行見出し1 + 6 列) = 21 個の <td>。
    expect(container.querySelectorAll("tbody td")).toHaveLength(
      PIVOT_DEFAULT_ROWS.length * (PIVOT_DEFAULT_COLS.length + 1),
    );
  });

  it("adds a totals column/row and theme-following classes when showTotals", () => {
    const { container } = render(
      <PivotTable
        data={PIVOT_DEFAULT_DATA}
        rows={PIVOT_DEFAULT_ROWS}
        cols={PIVOT_DEFAULT_COLS}
        showTotals
      />,
    );
    // 合計列で <th> が 1 個増える → 8 個。
    expect(container.querySelectorAll("thead th")).toHaveLength(
      PIVOT_DEFAULT_COLS.length + 2,
    );
    // 合計行が 1 行増える → 3 データ行 + 1 合計行 = 4 行。
    expect(container.querySelectorAll("tbody tr")).toHaveLength(
      PIVOT_DEFAULT_ROWS.length + 1,
    );
    // 罫線色は shadcn の --border を参照（ダーク追従）。
    const td = container.querySelector("tbody td");
    expect(td?.className).toContain("var(--border)");
  });
});

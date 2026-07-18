// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor, fireEvent } from "@testing-library/react";
import { Dashboard } from "./Dashboard";
import type { DashboardConfig, DataProvider } from "./types";

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

afterEach(cleanup);

const config: DashboardConfig = {
  title: "テスト",
  columns: 12,
  filters: [
    {
      key: "region",
      type: "dropdown",
      label: "地域",
      options: ["東京", "大阪"],
      defaultValue: "東京",
    },
  ],
  widgets: [
    { id: "kpi", type: "scorecard", title: "売上", layout: { w: 4 }, props: { title: "売上" } },
    { id: "bars", type: "bar", title: "内訳", layout: { w: 8 } },
  ],
};

describe("Dashboard orchestrator", () => {
  it("fetches every widget on mount with the initial filter state", async () => {
    const provider = vi.fn<DataProvider>(({ widget, filters }) => {
      if (widget.type === "scorecard") return { value: filters.region === "大阪" ? 200 : 100 };
      return {};
    });

    const { container } = render(<Dashboard config={config} dataProvider={provider} />);

    await waitFor(() => {
      // 両ウィジェットぶん呼ばれる
      expect(provider).toHaveBeenCalled();
    });
    // 初期フィルタ "東京" で呼ばれている
    const firstCallFilters = provider.mock.calls[0]![0].filters;
    expect(firstCallFilters.region).toBe("東京");
    // 2 ウィジェットのコンテナが描画される
    expect(container.querySelectorAll("[data-widget]")).toHaveLength(2);
  });

  it("re-fetches all widgets when a filter changes (cross-filter)", async () => {
    const provider = vi.fn<DataProvider>(() => ({ value: 1 }));
    const { container } = render(<Dashboard config={config} dataProvider={provider} />);

    await waitFor(() => expect(provider).toHaveBeenCalled());
    const callsAfterMount = provider.mock.calls.length;

    // ドロップダウンを "大阪" に変更
    const select = container.querySelector("select");
    expect(select).toBeTruthy();
    fireEvent.change(select!, { target: { value: "大阪" } });

    await waitFor(() => {
      expect(provider.mock.calls.length).toBeGreaterThan(callsAfterMount);
    });
    // 変更後は filters.region === "大阪" で呼ばれている
    const last = provider.mock.calls[provider.mock.calls.length - 1]![0];
    expect(last.filters.region).toBe("大阪");
  });
});

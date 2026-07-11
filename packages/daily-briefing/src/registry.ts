import type {
  SourceParams,
  TableQuery,
  WidgetDataFetcher,
  WidgetDataResponse,
} from "./types";
import {
  makeFetchGa4,
  makeFetchCosts,
  makeFetchCampaigns,
  makeFetchSns,
  DEFAULT_SOURCE_TABLES,
  type SourceTableConfig,
} from "./sources";

/**
 * ウィジェットデータソース registry。
 *
 * データソース名 (`ga4` / `costs` 等) → フェッチャの写像。
 * ブリーフィング編成 (LLM が構成した WidgetSpec) は dataSource 名でここを引き、
 * 実データを取得する。未登録名は空応答を返すため UI が壊れない。
 */
export class WidgetDataRegistry {
  private readonly fetchers = new Map<string, WidgetDataFetcher>();

  register(dataSource: string, fetcher: WidgetDataFetcher): this {
    this.fetchers.set(dataSource, fetcher);
    return this;
  }

  has(dataSource: string): boolean {
    return this.fetchers.has(dataSource);
  }

  list(): string[] {
    return [...this.fetchers.keys()];
  }

  /** データソースを解決して取得。未登録なら空応答。 */
  async fetch(
    dataSource: string,
    params: SourceParams,
    tenantId: string,
  ): Promise<WidgetDataResponse> {
    const fetcher = this.fetchers.get(dataSource);
    if (!fetcher) return { data: [], chartSpec: {}, truncated: false };
    return fetcher(params, tenantId);
  }
}

/**
 * `TableQuery` を注入して、原文の 4 データソース (ga4/costs/campaigns/sns) を
 * 登録済みの registry を組み立てる。テーブル名は config で差し替え可能。
 */
export function createDefaultWidgetDataRegistry(
  query: TableQuery,
  tables: SourceTableConfig = DEFAULT_SOURCE_TABLES,
): WidgetDataRegistry {
  return new WidgetDataRegistry()
    .register("ga4", makeFetchGa4(query, tables))
    .register("costs", makeFetchCosts(query, tables))
    .register("campaigns", makeFetchCampaigns(query, tables))
    .register("sns", makeFetchSns(query, tables));
}

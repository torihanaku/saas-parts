import type { BlockKitPayload, ReportTenant, SlackReportSender } from "./types";

/**
 * レポートビルダー registry。
 *
 * 「型」(ビルダー) と「データ取得」(provider)・「送信」(sender) を分離し、
 * 名前をキーに複数の定期レポートを登録・実行できるようにする。
 *
 * - `provider(tenant)` … そのテナントのレポート素材を集める。null を返すとスキップ。
 * - `build(tenant, data)` … 素材を BlockKitPayload に組み立てる (原文のビルダーを使う)。
 * - どちらも throw してよい。ランナーが catch してそのテナントだけスキップする。
 */
export interface ReportDefinition<Data> {
  /** レポート識別名 (例: "weekly-report")。 */
  name: string;
  /** テナントごとのデータ取得。null を返すとそのテナントはスキップ。 */
  provider: (tenant: ReportTenant) => Promise<Data | null>;
  /** データ → Block Kit ペイロード。 */
  build: (tenant: ReportTenant, data: Data) => BlockKitPayload;
}

export interface RunReportResult {
  name: string;
  posted: number;
  skipped: number;
  failed: number;
}

export interface RunReportOptions {
  tenants: ReportTenant[];
  sender: SlackReportSender;
  /** 例外・スキップ時のログ (省略可)。 */
  onError?: (tenant: ReportTenant, error: unknown) => void;
}

/**
 * 1 つのレポート定義を全テナントに対して実行する。
 * 1 テナントの失敗は他を止めない (原文の failure semantics を維持)。
 */
export async function runReport<Data>(
  def: ReportDefinition<Data>,
  { tenants, sender, onError }: RunReportOptions,
): Promise<RunReportResult> {
  let posted = 0;
  let skipped = 0;
  let failed = 0;

  for (const tenant of tenants) {
    try {
      const data = await def.provider(tenant);
      if (data == null) {
        skipped++;
        continue;
      }
      const payload = def.build(tenant, data);
      await sender(payload);
      posted++;
    } catch (error) {
      failed++;
      onError?.(tenant, error);
    }
  }

  return { name: def.name, posted, skipped, failed };
}

/** 複数レポート定義をまとめて保持・実行する registry。 */
export class ReportRegistry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly defs = new Map<string, ReportDefinition<any>>();

  register<Data>(def: ReportDefinition<Data>): this {
    this.defs.set(def.name, def);
    return this;
  }

  get(name: string): ReportDefinition<unknown> | undefined {
    return this.defs.get(name);
  }

  list(): string[] {
    return [...this.defs.keys()];
  }

  /** 登録済み全レポートを順に実行する。 */
  async runAll(
    options: RunReportOptions,
  ): Promise<RunReportResult[]> {
    const results: RunReportResult[] = [];
    for (const def of this.defs.values()) {
      results.push(await runReport(def, options));
    }
    return results;
  }
}

import type { DebtRecord, ScanContext, ScanSummaryBase } from "./types";

/**
 * AssetScanner インターフェイスと巡回オーケストレータ。
 * 出典: 実運用SaaS server/lib/marketing-debt/scanner-orchestrator.ts (#1295)。
 *
 * 原文は 7 スキャナをハードコード import していたが、レジストリ化して
 * 任意のスキャナを登録・並列実行できるようにした。各スキャナは検出した
 * `DebtRecord[]` を返し、永続化は `ScanContext.store` に注入する。
 * 1 スキャナの失敗は他を止めない (per-scanner error isolation)。
 */

/**
 * 資産スキャナ。`Input` は種別ごとの対象 (URL 一覧・行データ等)。
 * `scan` は検出結果を返し、任意でサマリ (件数統計) を含める。
 */
export interface AssetScanner<Input = unknown, Summary extends ScanSummaryBase = ScanSummaryBase> {
  /** レジストリキー兼ログ名 (例: "dead-link")。 */
  name: string;
  /**
   * スキャン実行。検出した DebtRecord とサマリを返す。
   * store への書き込みは実装側で ctx.store を呼ぶ (recorded 件数に反映)。
   */
  scan(tenantId: string, input: Input, ctx: ScanContext): Promise<Summary>;
}

/** 1 スキャナの実行結果 (成功/失敗を包む)。 */
export interface ScannerStatus<S extends ScanSummaryBase = ScanSummaryBase> {
  ok: boolean;
  summary?: S;
  error?: string;
}

/** オーケストレータの入力: スキャナ名 → その種別の対象データ。 */
export type OrchestratorInputs = Record<string, unknown>;

export interface OrchestratorResult {
  tenantId: string;
  /** スキャナ名 → status。 */
  scanners: Record<string, ScannerStatus>;
  totalRecorded: number;
  durationMs: number;
}

/**
 * 資産スキャナのレジストリ。名前で登録し、まとめて並列実行する。
 */
export class ScannerRegistry {
  private readonly scanners = new Map<string, AssetScanner<any, any>>();

  register<I, S extends ScanSummaryBase>(scanner: AssetScanner<I, S>): this {
    this.scanners.set(scanner.name, scanner);
    return this;
  }

  get(name: string): AssetScanner<any, any> | undefined {
    return this.scanners.get(name);
  }

  list(): string[] {
    return [...this.scanners.keys()];
  }

  /**
   * 登録済み全スキャナを並列実行する。1 スキャナの例外は捕捉され
   * `ok:false` として surfaced される (他スキャナは継続)。
   *
   * `inputs[name]` が該当スキャナへの対象データ。未指定なら `undefined` を渡す。
   */
  async runAll(
    tenantId: string,
    inputs: OrchestratorInputs,
    ctx: ScanContext = {},
  ): Promise<OrchestratorResult> {
    const start = ctx.now ? ctx.now.getTime() : Date.now();
    const entries = [...this.scanners.entries()];

    const settled = await Promise.all(
      entries.map(async ([name, scanner]): Promise<[string, ScannerStatus]> => {
        try {
          const summary = await scanner.scan(tenantId, inputs[name], ctx);
          return [name, { ok: true, summary }];
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          return [name, { ok: false, error: message }];
        }
      }),
    );

    const scanners: Record<string, ScannerStatus> = {};
    let totalRecorded = 0;
    for (const [name, status] of settled) {
      scanners[name] = status;
      totalRecorded += status.summary?.recorded ?? 0;
    }

    const end = ctx.now ? ctx.now.getTime() : Date.now();
    return { tenantId, scanners, totalRecorded, durationMs: Math.max(0, end - start) };
  }
}

/**
 * DebtRecord 群を store に流す薄いヘルパ。store 未注入なら 0。
 * 各スキャナ実装が recorded 件数を得るために使う。
 */
export async function persist(records: DebtRecord[], ctx: ScanContext): Promise<number> {
  if (records.length === 0 || !ctx.store) return 0;
  return ctx.store(records);
}

/** detectedAt を補完しつつ DebtRecord を作る小ヘルパ。 */
export function makeRecord(
  record: Omit<DebtRecord, "detectedAt"> & { detectedAt?: string },
  ctx: ScanContext,
): DebtRecord {
  return {
    ...record,
    detectedAt: record.detectedAt ?? (ctx.now ?? new Date()).toISOString(),
  };
}

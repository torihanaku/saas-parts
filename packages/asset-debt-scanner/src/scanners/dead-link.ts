/**
 * Dead-link scanner (AssetScanner 実装例)。
 * 出典: dev-dashboard-v2 server/lib/marketing-debt/dead-link-scanner.ts (#1332)。
 *
 * URL を HEAD→GET フォールバックでプローブし、status>=400 / timeout / network error を
 * デッドリンクとして検出。fetch は ctx.fetchImpl から注入 (テスト・プロキシ差替え可)。
 */
import { persist, type AssetScanner } from "../scanner";
import type { DebtRecord, ScanContext, ScanSummaryBase } from "../types";

const DEFAULT_CONCURRENCY = 5;
const DEFAULT_TIMEOUT_MS = 10_000;

export interface ScanTarget {
  url: string;
}

export interface ScanResult {
  url: string;
  ok: boolean;
  status: number;
  reason?: "http_error" | "timeout" | "network_error" | "invalid_url";
  durationMs: number;
}

export interface ScanSummary extends ScanSummaryBase {
  alive: number;
  dead: number;
  results: ScanResult[];
}

export interface DeadLinkOptions {
  concurrency?: number;
  timeoutMs?: number;
}

export async function probeUrl(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<ScanResult> {
  const startedAt = Date.now();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { url, ok: false, status: 0, reason: "invalid_url", durationMs: 0 };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { url, ok: false, status: 0, reason: "invalid_url", durationMs: 0 };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res = await fetchImpl(url, { method: "HEAD", signal: controller.signal });
    if (res.status === 405 || res.status === 501) {
      res = await fetchImpl(url, { method: "GET", signal: controller.signal });
    }
    const ok = res.status >= 200 && res.status < 400;
    return {
      url,
      ok,
      status: res.status,
      reason: ok ? undefined : "http_error",
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    const aborted = (err as { name?: string })?.name === "AbortError";
    return {
      url,
      ok: false,
      status: 0,
      reason: aborted ? "timeout" : "network_error",
      durationMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function buildRecommendation(r: ScanResult): string {
  switch (r.reason) {
    case "http_error":
      return `HTTP ${r.status} を返しています。リンク先が削除されたか、 リダイレクト設定を見直してください。`;
    case "timeout":
      return `${Math.round(r.durationMs / 1000)} 秒以上応答がありません。サーバー停止または DNS 不通の可能性。`;
    case "network_error":
      return "ネットワーク到達不可。 SSL 期限切れ・ DNS 設定誤りを確認。";
    case "invalid_url":
      return "URL 形式が不正です。 http(s):// から始まる絶対 URL に修正してください。";
    default:
      return "リンクが利用できません。";
  }
}

async function runWithConcurrency<T, U>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  const results: U[] = new Array(items.length);
  let cursor = 0;
  async function next(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]!, i);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => next());
  await Promise.all(workers);
  return results;
}

export function createDeadLinkScanner(
  options: DeadLinkOptions = {},
): AssetScanner<ScanTarget[], ScanSummary> {
  return {
    name: "dead-link",
    async scan(tenantId, targets = [], ctx: ScanContext): Promise<ScanSummary> {
      if (targets.length === 0) {
        return { scanned: 0, alive: 0, dead: 0, recorded: 0, results: [] };
      }
      const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const fetchImpl = ctx.fetchImpl ?? globalThis.fetch;

      const results = await runWithConcurrency(targets, concurrency, (target) =>
        probeUrl(target.url, timeoutMs, fetchImpl),
      );
      const dead = results.filter((r) => !r.ok);

      const records: DebtRecord[] = dead.map((d) => ({
        tenantId,
        assetType: "link",
        assetRef: d.url,
        freshnessScore: 0,
        decayRate: 0,
        severity: "high",
        recommendation: buildRecommendation(d),
        lastActiveAt: null,
      }));
      const recorded = await persist(records, ctx);

      return {
        scanned: results.length,
        alive: results.length - dead.length,
        dead: dead.length,
        recorded,
        results,
      };
    },
  };
}

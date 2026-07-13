/**
 * Image asset scanner (AssetScanner 実装例)。
 * 出典: 実運用SaaS server/lib/marketing-debt/image-scanner.ts (#1295)。
 *
 * 画像 URL を HEAD でプローブし、missing(404) / placeholder(極小) / empty(0byte) /
 * timeout / network error を検出。asset_type='content' で記録する。
 */
import { persist, type AssetScanner } from "../scanner";
import type { DebtRecord, ScanContext, ScanSummaryBase } from "../types";

const DEFAULT_CONCURRENCY = 5;
const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_BYTES = 256;

export type ImageDefect = "missing" | "placeholder" | "empty" | "timeout" | "network_error";

export interface ImageTarget {
  url: string;
}

export interface ImageScanResult {
  url: string;
  ok: boolean;
  status: number;
  reason?: ImageDefect;
  bytes?: number;
}

export interface ImageScanSummary extends ScanSummaryBase {
  ok: number;
  defective: number;
  results: ImageScanResult[];
}

export interface ImageOptions {
  concurrency?: number;
  timeoutMs?: number;
}

export async function probeImage(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<ImageScanResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const head = await fetchImpl(url, { method: "HEAD", signal: controller.signal });
    if (head.status === 404 || head.status === 410) {
      return { url, ok: false, status: head.status, reason: "missing" };
    }
    const sizeHeader = head.headers.get("content-length");
    const bytes = sizeHeader ? Number(sizeHeader) : NaN;
    if (Number.isFinite(bytes)) {
      if (bytes === 0) return { url, ok: false, status: head.status, reason: "empty", bytes };
      if (bytes < MIN_BYTES)
        return { url, ok: false, status: head.status, reason: "placeholder", bytes };
    }
    return {
      url,
      ok: true,
      status: head.status,
      bytes: Number.isFinite(bytes) ? bytes : undefined,
    };
  } catch (e) {
    if ((e as { name?: string }).name === "AbortError") {
      return { url, ok: false, status: 0, reason: "timeout" };
    }
    return { url, ok: false, status: 0, reason: "network_error" };
  } finally {
    clearTimeout(timer);
  }
}

export function severityFor(reason?: ImageDefect): "high" | "med" | "low" {
  if (reason === "missing" || reason === "empty") return "high";
  if (reason === "placeholder") return "med";
  return "low";
}

export function buildImageRecommendation(r: ImageScanResult): string {
  switch (r.reason) {
    case "missing":
      return "画像が見つかりません (404)。 別ファイルへの差し替え or リンク削除を検討してください。";
    case "placeholder":
      return `画像サイズが ${r.bytes ?? "?"} bytes と異常に小さく、 プレースホルダの可能性。`;
    case "empty":
      return "画像コンテンツが空です。 アップロード失敗の可能性。";
    case "timeout":
      return "応答がタイムアウトしました。 ホスティング側の応答性を確認してください。";
    case "network_error":
      return "ネットワーク到達不可。 SSL / DNS / CDN 設定を確認してください。";
    default:
      return "画像に問題があります。";
  }
}

export function createImageScanner(
  options: ImageOptions = {},
): AssetScanner<ImageTarget[], ImageScanSummary> {
  return {
    name: "image",
    async scan(tenantId, targets = [], ctx: ScanContext): Promise<ImageScanSummary> {
      if (targets.length === 0) {
        return { scanned: 0, ok: 0, defective: 0, recorded: 0, results: [] };
      }
      const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const fetchImpl = ctx.fetchImpl ?? globalThis.fetch;

      const results: ImageScanResult[] = [];
      for (let i = 0; i < targets.length; i += concurrency) {
        const batch = targets.slice(i, i + concurrency);
        const batchResults = await Promise.all(
          batch.map((t) => probeImage(t.url, timeoutMs, fetchImpl)),
        );
        results.push(...batchResults);
      }

      const defective = results.filter((r) => !r.ok);
      const records: DebtRecord[] = defective.map((d) => ({
        tenantId,
        assetType: "content",
        assetRef: d.url,
        freshnessScore: 0,
        decayRate: 0,
        severity: severityFor(d.reason),
        recommendation: buildImageRecommendation(d),
        lastActiveAt: null,
      }));
      const recorded = await persist(records, ctx);

      return {
        scanned: results.length,
        ok: results.length - defective.length,
        defective: defective.length,
        recorded,
        results,
      };
    },
  };
}

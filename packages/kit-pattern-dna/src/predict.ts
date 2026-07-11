/**
 * predict.ts — 蓄積パターンからの反応予測（回帰ベース）。
 *
 * 2 つの入口:
 *   1. predictContentScore — theme+channel 一致サンプルへの OLS 回帰
 *      （length → pv/cv）。平均フォールバック・channel のみフォールバック付き。
 *      任意で LLM サニティチェック。
 *   2. recommendChannel — theme に対する過去 ROI で候補チャネルをランク付け。
 *
 * 重い ML（XGBoost/NN）は意図的に避けている — per-tenant データは小規模
 * （≤5k 行）で、単純回帰の方が過学習に頑健。LLM 失敗は静かにフォールバック。
 *
 * 出典: dev-dashboard-v2 `server/lib/company-dna/predict.ts`
 * （Supabase → DnaStore 注入、env.ANTHROPIC_API_KEY → LlmCaller 注入）。
 */

import type { LlmCaller, PatternDnaRow } from "./types.js";
import type { DnaStore } from "./stores.js";

// ─── Public types ────────────────────────────────────────────────────────────

export interface PredictScoreInput {
  tenantId: string;
  theme: string;
  channel: string;
  /** 任意のコンテンツ長（文字数）。 */
  length?: number;
  /** true のとき、回帰出力に対して任意の LLM サニティチェックを実行。 */
  sanityCheck?: boolean;
}

export interface PredictScoreOutput {
  predictedPv: number;
  predictedCv: number;
  confidence: "low" | "medium" | "high";
  sampleSize: number;
  /** 予測が回帰由来のとき true（フォールバック平均のとき false）。 */
  usedRegression: boolean;
  reason: string;
}

export interface RecommendChannelInput {
  tenantId: string;
  theme: string;
  channels: string[];
}

export interface ChannelRecommendation {
  channel: string;
  expectedPv: number;
  expectedCv: number;
  /** cv / pv（ゼロ除算セーフ）。 */
  expectedRoi: number;
  sampleSize: number;
}

export interface ContentSample {
  theme: string;
  channel: string;
  length: number;
  pv: number;
  cv: number;
}

/**
 * 行の value ペイロードから `ContentSample` を抽出。項目欠落 / 不正時は null。
 * 期待形: { theme, channel, length?, pv, cv }。
 */
export function extractSample(
  row: Pick<PatternDnaRow, "value" | "dnaType">,
): ContentSample | null {
  if (row.dnaType !== "content") return null;
  const v = row.value as Record<string, unknown>;
  const theme = typeof v.theme === "string" ? v.theme.trim() : "";
  const channel = typeof v.channel === "string" ? v.channel.trim() : "";
  const pv = Number(v.pv);
  const cv = Number(v.cv);
  const lengthRaw = Number(v.length);
  if (!theme || !channel) return null;
  if (!Number.isFinite(pv) || pv < 0) return null;
  if (!Number.isFinite(cv) || cv < 0) return null;
  const length = Number.isFinite(lengthRaw) && lengthRaw > 0 ? lengthRaw : 0;
  return { theme, channel, length, pv, cv };
}

/** テナントの全 content サンプルを取得。安全のため 5000 行で打ち切り。 */
export async function fetchContentSamples(
  store: DnaStore,
  tenantId: string,
): Promise<ContentSample[]> {
  let rows: PatternDnaRow[];
  try {
    rows = await store.list(tenantId, { dnaType: "content", limit: 5000 });
  } catch {
    return [];
  }
  const samples: ContentSample[] = [];
  for (const r of rows) {
    const s = extractSample({ value: r.value ?? {}, dnaType: "content" });
    if (s) samples.push(s);
  }
  return samples;
}

/** 単一特徴量の OLS 回帰。var(x)=0 のとき slope=0 / intercept=mean(y)。 */
export function linearRegression(
  xs: number[],
  ys: number[],
): { slope: number; intercept: number } {
  if (xs.length !== ys.length || xs.length === 0) return { slope: 0, intercept: 0 };
  const n = xs.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = (xs[i] ?? 0) - meanX;
    num += dx * ((ys[i] ?? 0) - meanY);
    den += dx * dx;
  }
  if (den === 0) return { slope: 0, intercept: meanY };
  const slope = num / den;
  const intercept = meanY - slope * meanX;
  return { slope, intercept };
}

/** 回帰直線を x で評価。負の出力は 0 にクランプ（PV/CV ≥ 0）。 */
export function predictFromRegression(
  model: { slope: number; intercept: number },
  x: number,
): number {
  const y = model.slope * x + model.intercept;
  return y < 0 ? 0 : y;
}

/** 数値配列の平均。空入力は 0（安全なデフォルト）。 */
export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** サンプル数からの confidence バケット。 */
export function confidenceFromSampleSize(n: number): "low" | "medium" | "high" {
  if (n >= 10) return "high";
  if (n >= 5) return "medium";
  return "low";
}

/**
 * 未公開コンテンツの PV/CV を予測する（入口 1）。
 * アルゴ: theme+channel 一致 → OLS 回帰（≥3 サンプル + length 指定）→ 平均
 * フォールバック → channel のみ平均フォールバック → ゼロ。任意で LLM 補正 ±20%。
 */
export async function predictContentScore(
  store: DnaStore,
  input: PredictScoreInput,
  llm?: LlmCaller,
): Promise<PredictScoreOutput> {
  const samples = await fetchContentSamples(store, input.tenantId);
  return predictContentScoreFromSamples(samples, input, llm);
}

/** 純粋バリアント — 取得済みサンプル集合上で動く。ユニットテストで使用。 */
export async function predictContentScoreFromSamples(
  samples: ContentSample[],
  input: PredictScoreInput,
  llm?: LlmCaller,
): Promise<PredictScoreOutput> {
  const themeMatches = samples.filter(
    (s) => s.theme === input.theme && s.channel === input.channel,
  );

  if (themeMatches.length >= 3 && input.length !== undefined) {
    const xs = themeMatches.map((s) => s.length);
    const pvModel = linearRegression(xs, themeMatches.map((s) => s.pv));
    const cvModel = linearRegression(xs, themeMatches.map((s) => s.cv));
    const result: PredictScoreOutput = {
      predictedPv: Math.round(predictFromRegression(pvModel, input.length)),
      predictedCv: Math.round(predictFromRegression(cvModel, input.length)),
      confidence: confidenceFromSampleSize(themeMatches.length),
      sampleSize: themeMatches.length,
      usedRegression: true,
      reason: `regression_on_${themeMatches.length}_theme_channel_matches`,
    };
    return input.sanityCheck && llm ? runSanityCheck(llm, result, input) : result;
  }

  if (themeMatches.length > 0) {
    const result: PredictScoreOutput = {
      predictedPv: Math.round(mean(themeMatches.map((s) => s.pv))),
      predictedCv: Math.round(mean(themeMatches.map((s) => s.cv))),
      confidence: confidenceFromSampleSize(themeMatches.length),
      sampleSize: themeMatches.length,
      usedRegression: false,
      reason: `mean_of_${themeMatches.length}_theme_channel_matches`,
    };
    return input.sanityCheck && llm ? runSanityCheck(llm, result, input) : result;
  }

  const channelMatches = samples.filter((s) => s.channel === input.channel);
  if (channelMatches.length > 0) {
    return {
      predictedPv: Math.round(mean(channelMatches.map((s) => s.pv))),
      predictedCv: Math.round(mean(channelMatches.map((s) => s.cv))),
      confidence: "low",
      sampleSize: channelMatches.length,
      usedRegression: false,
      reason: `fallback_channel_mean_${channelMatches.length}`,
    };
  }

  return {
    predictedPv: 0,
    predictedCv: 0,
    confidence: "low",
    sampleSize: 0,
    usedRegression: false,
    reason: "insufficient_data_no_matches",
  };
}

/** theme に対する過去 ROI で候補チャネルをランク付け（入口 2）。データ無しは末尾。 */
export async function recommendChannel(
  store: DnaStore,
  input: RecommendChannelInput,
): Promise<ChannelRecommendation[]> {
  const samples = await fetchContentSamples(store, input.tenantId);
  return recommendChannelFromSamples(samples, input);
}

export function recommendChannelFromSamples(
  samples: ContentSample[],
  input: RecommendChannelInput,
): ChannelRecommendation[] {
  const recs: ChannelRecommendation[] = input.channels.map((channel) => {
    const matches = samples.filter((s) => s.theme === input.theme && s.channel === channel);
    if (matches.length === 0) {
      return { channel, expectedPv: 0, expectedCv: 0, expectedRoi: 0, sampleSize: 0 };
    }
    const expectedPv = mean(matches.map((s) => s.pv));
    const expectedCv = mean(matches.map((s) => s.cv));
    const expectedRoi = expectedPv > 0 ? expectedCv / expectedPv : 0;
    return {
      channel,
      expectedPv: Math.round(expectedPv),
      expectedCv: Math.round(expectedCv),
      expectedRoi: Number(expectedRoi.toFixed(4)),
      sampleSize: matches.length,
    };
  });
  recs.sort((a, b) => b.expectedRoi - a.expectedRoi || b.expectedPv - a.expectedPv);
  return recs;
}

interface LlmSanityResponse {
  reasonable?: boolean;
  pv_adjustment?: number;
  cv_adjustment?: number;
}

async function runSanityCheck(
  llm: LlmCaller,
  base: PredictScoreOutput,
  input: PredictScoreInput,
): Promise<PredictScoreOutput> {
  const system =
    'Marketing analytics sanity checker. Reply JSON only: {"reasonable":boolean,"pv_adjustment":number(-0.2..0.2),"cv_adjustment":number(-0.2..0.2)}.';
  const prompt = JSON.stringify({
    theme: input.theme,
    channel: input.channel,
    length: input.length,
    predicted_pv: base.predictedPv,
    predicted_cv: base.predictedCv,
    sample_size: base.sampleSize,
  });
  const result = await llm.generateJson<LlmSanityResponse>(system, prompt, {});
  if (!result || result.reasonable !== false) return base;
  const pvAdj = clampAdjustment(result.pv_adjustment);
  const cvAdj = clampAdjustment(result.cv_adjustment);
  return {
    ...base,
    predictedPv: Math.max(0, Math.round(base.predictedPv * (1 + pvAdj))),
    predictedCv: Math.max(0, Math.round(base.predictedCv * (1 + cvAdj))),
    reason: `${base.reason}+llm_adjusted`,
  };
}

function clampAdjustment(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-0.2, Math.min(0.2, n));
}

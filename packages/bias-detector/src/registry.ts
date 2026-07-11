/**
 * Extensible bias taxonomy registry.
 *
 * The 6 source biases (sunk_cost / confirmation / recency / bandwagon /
 * anchoring / hippo) ship as defaults, carrying the original per-bias
 * detection rubrics ported verbatim from the dev-dashboard-v2 Claude v1
 * detector. Consumers may register additional biases or override rubrics.
 */

import type { BiasType } from "./types.js";

/** A single entry in the bias taxonomy: the type id + its detection rubric. */
export interface BiasDefinition {
  /** Bias category id (matches the model output `biasType`). */
  type: string;
  /** Prompt rubric describing how to detect this bias. */
  rubric: string;
}

// ─── Default rubrics (ported verbatim) ───────────────────────────────────────

const DEFAULT_RUBRICS: Record<BiasType, string> = {
  sunk_cost: `## sunk_cost — サンクコストバイアス
判定基準: 「すでにこれだけ投資した / 時間をかけた」が判断の主因になっている。ROI / 効果ではなく既投資量を継続理由にしている。
証拠例: spent_jpy / months_invested / "ここまでやった" 等が reason に登場し、定量的な期待リターンが提示されていない。`,

  confirmation: `## confirmation — 確証バイアス
判定基準: 自説に有利なデータだけ引用し、反証データへの言及がない、または反証検討した記録がない。
証拠例: 成功事例は列挙されているが「失敗 / リスク要因」が空欄、alternativesConsidered が null / 空。`,

  recency: `## recency — 直近偏重 / リーセンシーバイアス
判定基準: 直近 1〜2 週間の数値スパイク / 異常値だけで意思決定し、長期トレンドを参照していない。
証拠例: history.last_week / yesterday / spike キーが reason の根拠になっており、3-month / 12-month trend が無視されている。`,

  bandwagon: `## bandwagon — バンドワゴンバイアス
判定基準: 競合 / 業界 / みんなが採用しているから、を主因にしている。自社固有の事情との適合性検証がない。
証拠例: "競合 X 社も導入" / "業界標準" / "他社事例" が判断理由として優先されている。`,

  anchoring: `## anchoring — アンカリングバイアス
判定基準: 前年比 / 初期見積り / 1 つの基準値に固定されており、改めて目標値を再評価していない。
証拠例: "前年比 +10%" / "当初予算" / "去年と同じ" のみが目標設定根拠。`,

  hippo: `## hippo — HiPPO (Highest-Paid Person's Opinion)
判定基準: データ / 検証ではなく、上位者の意見 / 直感 / 鶴の一声で決定されている。
特に decisionMakerRole=ceo / cmo かつ reason が 30 字以下、または "CEO 判断 / 経営判断 / トップが決定" などの語句が登場するとき confidence を高める。
証拠例: short_reason=true / role=ceo|cmo / authority_keywords (経営判断 / トップ / etc.)。`,
};

/** The 6 source biases as default registry entries. */
export const DEFAULT_BIAS_DEFINITIONS: readonly BiasDefinition[] = (
  Object.keys(DEFAULT_RUBRICS) as BiasType[]
).map((type) => ({ type, rubric: DEFAULT_RUBRICS[type] }));

/**
 * Ordered, mutable registry of bias definitions. Defaults are seeded from the
 * 6 source biases; `register()` adds or overrides entries by `type`.
 */
export class BiasRegistry {
  private readonly defs = new Map<string, BiasDefinition>();

  constructor(seed: readonly BiasDefinition[] = DEFAULT_BIAS_DEFINITIONS) {
    for (const d of seed) this.defs.set(d.type, { ...d });
  }

  /** Register a new bias or override an existing one (by `type`). */
  register(def: BiasDefinition): this {
    this.defs.set(def.type, { ...def });
    return this;
  }

  /** All registered bias type ids, in insertion order. */
  types(): string[] {
    return [...this.defs.keys()];
  }

  /** All definitions, in insertion order. */
  definitions(): BiasDefinition[] {
    return [...this.defs.values()];
  }

  /** True when `type` is a registered bias. */
  has(type: string): boolean {
    return this.defs.has(type);
  }
}

/** Default registry pre-seeded with the 6 source biases. */
export const defaultBiasRegistry = new BiasRegistry();

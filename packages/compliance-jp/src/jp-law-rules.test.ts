import { describe, it, expect, vi } from "vitest";
import {
  YAKKIHOU_RULES,
  KEIHYOUHOU_RULES,
  TOKUSHOUHOU_RULES,
  ALL_JP_LAW_RULES,
  applyStaticJpLawRules,
} from "./rules/index";

/**
 * Issue #934 — verify the JP-law rule library (薬機法 / 景表法 / 特商法).
 *
 * Each rule is exercised with:
 *   1. A target violation phrase that MUST trigger the rule.
 *   2. (where meaningful) a safe phrase that must NOT trigger the rule.
 *
 * Some rules — particularly heuristic regex patterns whose intent is to
 * surface contextually-suspicious phrasing — are inherently broad and only
 * the positive assertion is enforced. The negative assertion is added when
 * the rule has a recognisable safe baseline.
 */

interface Fixture {
  positive: string;
  negative?: string;
}

const POSITIVE_FIXTURES: Record<string, Fixture> = {
  // ───────── 薬機法 (20) ─────────
  "JP-YAKKI-001": { positive: "このサプリで花粉症が治る", negative: "毎日の健康習慣をサポートします" },
  "JP-YAKKI-002": { positive: "シワが消える美容液", negative: "うるおいによるハリ感" },
  "JP-YAKKI-003": { positive: "血圧を下げる効果があります", negative: "毎日の食生活を支えます" },
  "JP-YAKKI-004": { positive: "確実に生える育毛剤", negative: "頭皮環境を整えます" },
  "JP-YAKKI-005": { positive: "飲むだけで痩せるサプリ", negative: "運動と組み合わせてご利用ください" },
  "JP-YAKKI-006": { positive: "副作用ゼロの自然由来です", negative: "ご使用前にパッチテストをお勧めします" },
  "JP-YAKKI-007": { positive: "医師が推奨しています", negative: "ご使用前に医師にご相談ください" },
  "JP-YAKKI-008": { positive: "ニキビが治る化粧水", negative: "ニキビを防ぐ化粧水" },
  "JP-YAKKI-009": { positive: "シミが消える美白クリーム", negative: "メラニンの生成を抑え、シミ・そばかすを防ぐ" },
  "JP-YAKKI-010": { positive: "デトックス効果でスッキリ", negative: "毎朝のスッキリをサポート" },
  "JP-YAKKI-011": { positive: "免疫力アップが期待できる", negative: "毎日の体調管理に" },
  "JP-YAKKI-012": { positive: "マッサージ器で病気が治る", negative: "リラックスタイムにご活用ください" },
  "JP-YAKKI-013": { positive: "ペットの病気が治るフード", negative: "ペットの毎日の食事に" },
  "JP-YAKKI-014": { positive: "世界初の治療法です", negative: "新しい角度からのアプローチ" },
  "JP-YAKKI-015": { positive: "使用前と使用後で大きく変わります" },
  "JP-YAKKI-016": { positive: "効果保証付きの商品です", negative: "個人差がございます" },
  "JP-YAKKI-017": { positive: "天然成分だから安全です", negative: "天然由来の成分を使用しています" },
  "JP-YAKKI-018": { positive: "末期癌が治った例もあります", negative: "個人の感想です" },
  "JP-YAKKI-019": { positive: "細胞を活性化する成分", negative: "うるおい成分を配合" },
  "JP-YAKKI-020": { positive: "個人輸入で入手可能な海外医薬品", negative: "国内で承認された成分を使用" },

  // ───────── 景表法 (20) ─────────
  "JP-KEIHYO-001": { positive: "業界No.1の満足度", negative: "お客様にご好評いただいています" },
  "JP-KEIHYO-002": { positive: "業界最安値で販売", negative: "お得な価格でご提供" },
  "JP-KEIHYO-003": { positive: "完全に問題を解決します", negative: "問題解決をサポートします" },
  "JP-KEIHYO-004": { positive: "本日限りの特別価格", negative: "通常価格でのご提供です" },
  "JP-KEIHYO-005": { positive: "通常価格 ¥10000 → ¥3000", negative: "販売価格 ¥3000" },
  "JP-KEIHYO-006": { positive: "無料お試しの後、定期コースに移行します", negative: "全くの無料でご利用いただけます" },
  "JP-KEIHYO-007": { positive: "ステマで話題のサービス", negative: "[PR] スポンサード投稿" },
  "JP-KEIHYO-008": { positive: "他社より圧倒的に高品質", negative: "高品質を追求しています" },
  "JP-KEIHYO-009": { positive: "やらせレビューは一切ありません", negative: "実際のご利用者の声を掲載しています" },
  "JP-KEIHYO-010": { positive: "在庫なしでも他のおすすめがあります", negative: "在庫が不足しております" },
  "JP-KEIHYO-011": { positive: "全額返金保証付き", negative: "返金条件はガイドをご覧ください" },
  "JP-KEIHYO-012": { positive: "A 社より優れている性能", negative: "性能比較は公開資料をご覧ください" },
  "JP-KEIHYO-013": { positive: "顧客満足度ランキング 第 1 位", negative: "お客様にご好評いただいております" },
  "JP-KEIHYO-014": { positive: "無料お試しの後 自動更新で継続", negative: "30 日間の無料お試しキャンペーン" },
  "JP-KEIHYO-015": { positive: "残り 3 個！お急ぎください", negative: "在庫の状況は商品ページでご確認ください" },
  "JP-KEIHYO-016": { positive: "公的機関認定の商品です", negative: "業界団体の自主基準を満たしています" },
  "JP-KEIHYO-017": { positive: "ビフォーアフターの劇的変化", negative: "ご利用結果は個人差がございます" },
  "JP-KEIHYO-018": { positive: "総額 100 万円相当の豪華景品", negative: "プレゼント企画を実施中" },
  "JP-KEIHYO-019": { positive: "有名人愛用の商品", negative: "[PR] お試しいただいた感想です" },
  "JP-KEIHYO-020": { positive: "科学的に証明された効果", negative: "ご利用者から高評価をいただいています" },

  // ───────── 特商法 (10) ─────────
  "JP-TOKUSHO-001": { positive: "特定商取引法に基づく表記" },
  "JP-TOKUSHO-002": { positive: "返品不可の商品です", negative: "返品ポリシーをご確認ください" },
  "JP-TOKUSHO-003": { positive: "送料別、税抜価格", negative: "送料込みの総額表示です" },
  "JP-TOKUSHO-004": { positive: "定期コース 初回 500 円", negative: "ご注文ごとの単発販売です" },
  "JP-TOKUSHO-005": { positive: "解約は電話のみ受付", negative: "解約はマイページから可能です" },
  "JP-TOKUSHO-006": { positive: "発送時期について" },
  "JP-TOKUSHO-007": { positive: "支払方法のご案内" },
  "JP-TOKUSHO-008": { positive: "自動更新の契約となります", negative: "1 回のみの単発契約です" },
  "JP-TOKUSHO-009": { positive: "対応するアプリの動作環境" },
  "JP-TOKUSHO-010": { positive: "お問い合わせ先一覧" },
};

describe("JP law rule library — counts and metadata", () => {
  it("ships 50 rules total", () => {
    expect(ALL_JP_LAW_RULES.length).toBe(50);
  });

  it("ships 20 薬機法 rules", () => {
    expect(YAKKIHOU_RULES.length).toBe(20);
  });

  it("ships 20 景表法 rules", () => {
    expect(KEIHYOUHOU_RULES.length).toBe(20);
  });

  it("ships 10 特商法 rules", () => {
    expect(TOKUSHOUHOU_RULES.length).toBe(10);
  });

  it("has unique (lawCode, ruleKey) and (id) keys", () => {
    const keyPairs = new Set<string>();
    const ids = new Set<string>();
    for (const r of ALL_JP_LAW_RULES) {
      const k = `${r.lawCode}::${r.ruleKey}`;
      expect(keyPairs.has(k), `duplicate (lawCode, ruleKey): ${k}`).toBe(false);
      keyPairs.add(k);
      expect(ids.has(r.id), `duplicate id: ${r.id}`).toBe(false);
      ids.add(r.id);
    }
  });

  it("uses only known severities and pattern types", () => {
    for (const r of ALL_JP_LAW_RULES) {
      expect(["error", "warning", "info"]).toContain(r.severity);
      expect(["regex", "keyword", "llm_prompt"]).toContain(r.patternType);
    }
  });

  it("provides a fixture for every rule (no orphans)", () => {
    for (const r of ALL_JP_LAW_RULES) {
      expect(POSITIVE_FIXTURES[r.id], `missing fixture for ${r.id}`).toBeDefined();
    }
  });
});

describe("JP law rule library — positive assertions (each rule fires on its target)", () => {
  for (const rule of ALL_JP_LAW_RULES) {
    const fx = POSITIVE_FIXTURES[rule.id];
    if (!fx) continue;
    it(`${rule.id} (${rule.ruleKey}) fires on its target phrase`, () => {
      const violations = applyStaticJpLawRules(fx.positive, [rule]);
      expect(violations.length, `expected violation for ${rule.id} on "${fx.positive}"`).toBeGreaterThan(0);
      expect(violations[0]?.ruleId).toBe(rule.id);
    });
  }
});

describe("JP law rule library — negative assertions (safe phrases do not fire)", () => {
  for (const rule of ALL_JP_LAW_RULES) {
    const fx = POSITIVE_FIXTURES[rule.id];
    if (!fx?.negative) continue;
    it(`${rule.id} (${rule.ruleKey}) does NOT fire on its safe baseline`, () => {
      const violations = applyStaticJpLawRules(fx.negative!, [rule]);
      expect(violations.length, `unexpected violation for ${rule.id} on safe text "${fx.negative}"`).toBe(0);
    });
  }
});

describe("applyStaticJpLawRules — defensive paths", () => {
  it("logs and skips a rule with an invalid regex without throwing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const v = applyStaticJpLawRules("hello", [
      {
        id: "X",
        lawCode: "yakki",
        ruleKey: "bad_regex",
        patternType: "regex",
        pattern: "(unclosed",
        severity: "info",
        descriptionJa: "broken regex",
      },
    ]);
    expect(v).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("invalid regex"), expect.anything());
    warn.mockRestore();
  });

  it("skips keyword rules whose pattern is not valid JSON", () => {
    const v = applyStaticJpLawRules("hello", [
      {
        id: "X",
        lawCode: "yakki",
        ruleKey: "bad_json",
        patternType: "keyword",
        pattern: "not-json",
        severity: "info",
        descriptionJa: "broken json",
      },
    ]);
    expect(v).toEqual([]);
  });

  it("skips keyword rules whose pattern parses to a non-array", () => {
    const v = applyStaticJpLawRules("hello", [
      {
        id: "X",
        lawCode: "yakki",
        ruleKey: "non_array",
        patternType: "keyword",
        pattern: JSON.stringify({ not: "an array" }),
        severity: "info",
        descriptionJa: "wrong shape",
      },
    ]);
    expect(v).toEqual([]);
  });

  it("ignores empty-string keywords inside an otherwise valid array", () => {
    const v = applyStaticJpLawRules("hello", [
      {
        id: "X",
        lawCode: "yakki",
        ruleKey: "empty_kw",
        patternType: "keyword",
        pattern: JSON.stringify(["", 123, "world"]),
        severity: "info",
        descriptionJa: "mixed",
      },
    ]);
    expect(v).toEqual([]);
  });
});

describe("applyStaticJpLawRules — bulk run", () => {
  it("runs the entire library against a clean string with zero hits", () => {
    const v = applyStaticJpLawRules("本日も平常運転で営業しております。");
    expect(v).toEqual([]);
  });

  it("returns multiple violations for a multi-rule sample", () => {
    const v = applyStaticJpLawRules("業界No.1の満足度！本日限り、副作用ゼロの天然由来サプリ。");
    // Should fire at least: JP-KEIHYO-001 (No.1), JP-KEIHYO-004 (本日限り),
    // JP-YAKKI-006 (副作用ゼロ).
    const ids = new Set(v.map((x) => x.ruleId));
    expect(ids.has("JP-KEIHYO-001")).toBe(true);
    expect(ids.has("JP-KEIHYO-004")).toBe(true);
    expect(ids.has("JP-YAKKI-006")).toBe(true);
  });

  it("preserves the suggestedAlternative field", () => {
    const v = applyStaticJpLawRules("業界No.1の満足度", [KEIHYOUHOU_RULES[0]!]);
    expect(v[0]?.suggestion).toBeTruthy();
  });
});

import { describe, expect, it } from "vitest";
import {
  classifyCommand,
  createClassifier,
  DEFAULT_CLASSIFIER_FALLBACK,
} from "./classifier";

describe("classifyCommand (default rules — original behaviour)", () => {
  it.each([
    ["デザインを直して", "18号（デザイン担当）", "techradar-ai"],
    ["UIの色を変えたい", "18号（デザイン担当）", "techradar-ai"],
    ["ボタンが押せない画面がある", "悟飯（画面づくり担当）", "techradar-ai"],
    ["APIのレスポンスが遅い", "ピッコロ（裏方システム担当）", "techradar-ai-backend"],
    ["データ収集のパイプラインを追加", "ブルマ（データ収集の天才）", "techradar-ai-pipeline"],
    ["テストでバグが出た", "天津飯（動作チェック担当）", "techradar-ai"],
    ["セキュリティの脆弱性を確認", "ヒット（セキュリティ番人）", "techradar-ai-backend"],
    ["デプロイの監視を強化", "界王様（サーバー管理者）", "techradar-ai-backend"],
    ["READMEのドキュメントを更新", "デンデ（マニュアル係）", "techradar-ai"],
    ["Stripeの課金プランを追加", "悟飯＆ピッコロ（画面+裏方）", "techradar-ai"],
  ])("%s → %s / %s", (text, assignee, repo) => {
    expect(classifyCommand(text)).toEqual({ assignee, repo });
  });

  it("falls back to the default assignee when nothing matches", () => {
    expect(classifyCommand("よろしく")).toEqual(DEFAULT_CLASSIFIER_FALLBACK);
  });

  it("is case-insensitive for latin keywords (lower-cases input)", () => {
    expect(classifyCommand("REACT component")).toEqual({
      assignee: "悟飯（画面づくり担当）",
      repo: "techradar-ai",
    });
  });

  it("first match wins when multiple rules could apply", () => {
    // デザイン (rule 1) + api (rule 3) → rule 1 wins
    expect(classifyCommand("デザインのapiを直す").assignee).toBe("18号（デザイン担当）");
  });
});

describe("createClassifier (configurable rules)", () => {
  it("uses custom rules and fallback", () => {
    const classify = createClassifier(
      [{ pattern: /billing/, assignee: "Billing Team", repo: "billing-service" }],
      { assignee: "Triage", repo: "monolith" }
    );
    expect(classify("Billing page is broken")).toEqual({
      assignee: "Billing Team",
      repo: "billing-service",
    });
    expect(classify("unrelated")).toEqual({ assignee: "Triage", repo: "monolith" });
  });
});

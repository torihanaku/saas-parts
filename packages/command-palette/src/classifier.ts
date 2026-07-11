/**
 * Client-side command classification (preview of which "assignee" / repo a
 * free-text command will be routed to).
 *
 * Ported from dev-dashboard-v2 `src/hooks/useCommands.ts` (`classifyCommand`).
 * The hard-coded rule chain is externalised as configuration; the default
 * rule set reproduces the original behaviour verbatim (order matters —
 * first match wins).
 */

export interface Classification {
  assignee: string;
  repo: string;
}

export interface ClassifierRule extends Classification {
  /** Tested against the lower-cased command text. */
  pattern: RegExp;
}

/** Original rule chain (first match wins). */
export const DEFAULT_CLASSIFIER_RULES: readonly ClassifierRule[] = [
  { pattern: /デザイン|見た目|ui|ux|色|レイアウト|フォント/, assignee: "18号（デザイン担当）", repo: "techradar-ai" },
  { pattern: /ボタン|画面|ページ|表示|フロント|react|ダッシュボード|ナビ|メニュー/, assignee: "悟飯（画面づくり担当）", repo: "techradar-ai" },
  { pattern: /api|サーバー|エンドポイント|バックエンド|速度|レスポンス|認証/, assignee: "ピッコロ（裏方システム担当）", repo: "techradar-ai-backend" },
  { pattern: /データ|パイプライン|収集|レポート|分析/, assignee: "ブルマ（データ収集の天才）", repo: "techradar-ai-pipeline" },
  { pattern: /テスト|バグ|動かない|エラー|壊れ/, assignee: "天津飯（動作チェック担当）", repo: "techradar-ai" },
  { pattern: /セキュリティ|安全|脆弱|パスワード|権限/, assignee: "ヒット（セキュリティ番人）", repo: "techradar-ai-backend" },
  { pattern: /デプロイ|インフラ|監視|ログ|ci|cd/, assignee: "界王様（サーバー管理者）", repo: "techradar-ai-backend" },
  { pattern: /ドキュメント|マニュアル|説明|ヘルプ|readme/, assignee: "デンデ（マニュアル係）", repo: "techradar-ai" },
  { pattern: /課金|支払|stripe|プラン|サブスク|料金/, assignee: "悟飯＆ピッコロ（画面+裏方）", repo: "techradar-ai" },
];

/** Original fallback when no rule matches. */
export const DEFAULT_CLASSIFIER_FALLBACK: Classification = {
  assignee: "ベジータ（司令塔）",
  repo: "techradar-ai",
};

/** Build a classifier from a configurable rule chain. */
export function createClassifier(
  rules: readonly ClassifierRule[] = DEFAULT_CLASSIFIER_RULES,
  fallback: Classification = DEFAULT_CLASSIFIER_FALLBACK
): (text: string) => Classification {
  return (text: string): Classification => {
    const t = text.toLowerCase();
    for (const rule of rules) {
      if (rule.pattern.test(t)) {
        return { assignee: rule.assignee, repo: rule.repo };
      }
    }
    return { assignee: fallback.assignee, repo: fallback.repo };
  };
}

/** Drop-in equivalent of the original `classifyCommand` (default rules). */
export const classifyCommand: (text: string) => Classification = createClassifier();

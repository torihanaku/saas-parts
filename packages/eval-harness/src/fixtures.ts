/**
 * Example golden-case fixtures.
 *
 * These are content-moderation-flavored examples derived from (and renamed
 * from) the brand-firewall use case that this harness was extracted from:
 * "should this marketing copy be flagged before publishing?". Use them to
 * smoke-test a judge wiring; replace with your own domain's golden set for
 * real evaluation.
 */

import type { GoldenCase } from "./golden";

export const EXAMPLE_GOLDEN_CASES: GoldenCase<string>[] = [
  {
    id: "flag-absolute-guarantee",
    input: "この投資で絶対に儲かります。元本保証です。",
    expected: true,
    note: "断定的利益保証 — must be flagged",
  },
  {
    id: "flag-medical-cure",
    input: "このサプリを飲むだけで病気が治ります。",
    expected: true,
    note: "医薬品的効能の標榜 — must be flagged",
  },
  {
    id: "flag-fake-scarcity",
    input: "本日限り！残りわずか3個、今すぐ購入しないと二度と手に入りません。",
    expected: true,
    note: "煽り・希少性の偽装 — must be flagged",
  },
  {
    id: "flag-unsubstantiated-no1",
    input: "業界No.1の実績（当社調査、根拠資料なし）",
    expected: true,
    note: "根拠のない No.1 表示 — must be flagged",
  },
  {
    id: "flag-hidden-subscription",
    input: "初回無料！（2回目以降は自動的に月額9,800円が発生します、解約は電話のみ）",
    expected: true,
    note: "分かりにくい定期購入条件 — must be flagged",
  },
  {
    id: "pass-plain-description",
    input: "当社のプロジェクト管理ツールはタスクの進捗を一覧で確認できます。",
    expected: false,
    note: "普通の機能説明 — must pass",
  },
  {
    id: "pass-qualified-claim",
    input: "多くのお客様にご好評いただいています（2026年当社顧客アンケート、n=312）。",
    expected: false,
    note: "根拠つきの控えめな訴求 — must pass",
  },
  {
    id: "pass-transparent-pricing",
    input: "料金は月額980円（税込・送料込）。いつでもマイページから解約できます。",
    expected: false,
    note: "総額・解約手段の明示 — must pass",
  },
  {
    id: "pass-disclosed-pr",
    input: "[PR] 本記事はメーカーの提供でお届けしています。",
    expected: false,
    note: "広告表記あり — must pass",
  },
  {
    id: "pass-neutral-comparison",
    input: "機能比較表は公開ドキュメントをご覧ください。",
    expected: false,
    note: "中立な比較への誘導 — must pass",
  },
];

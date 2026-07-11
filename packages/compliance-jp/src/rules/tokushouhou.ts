/**
 * 特商法 (Specified Commercial Transactions Act) rule library.
 *
 * 10 rules covering 通信販売 / 定期購入 / 特定継続的役務提供 等。
 * Sources:
 *   - 消費者庁「特定商取引法ガイド」
 *   - 2022/06 改正 (詐欺的な定期購入商法対策)
 *   - 通信販売の表示義務 11 項目
 */
import type { JpLawRule } from "../types";

export const TOKUSHOUHOU_RULES: JpLawRule[] = [
  {
    id: "JP-TOKUSHO-001",
    lawCode: "tokusho",
    ruleKey: "missing_seller_info",
    patternType: "regex",
    pattern: "(特定商取引|特商法).*(に基づく表記)",
    severity: "info",
    descriptionJa: "事業者氏名・住所・電話番号等を記載した特定商取引法に基づく表記ページが必要 (特商法 11 条)。",
  },
  {
    id: "JP-TOKUSHO-002",
    lawCode: "tokusho",
    ruleKey: "no_return_policy",
    patternType: "keyword",
    pattern: JSON.stringify(["返品不可", "返金不可", "ノークレーム・ノーリターン"]),
    severity: "warning",
    descriptionJa: "返品特約の表示義務。表示なしの場合は法定の返品権 (8 日間) が発生する旨を明示する必要がある。",
  },
  {
    id: "JP-TOKUSHO-003",
    lawCode: "tokusho",
    ruleKey: "hidden_shipping_fee",
    patternType: "keyword",
    pattern: JSON.stringify(["送料別", "送料別途", "手数料別", "税抜価格"]),
    severity: "warning",
    descriptionJa: "販売価格は総額表示が原則。付帯費用 (送料・手数料) を明示しないと不適切表示。",
  },
  {
    id: "JP-TOKUSHO-004",
    lawCode: "tokusho",
    ruleKey: "subscription_unclear",
    patternType: "regex",
    pattern: "(定期コース|サブスク|月額制).{0,40}(初回|お試し).{0,15}(\\d+\\s*円|無料)",
    severity: "error",
    descriptionJa: "定期購入契約は契約期間・総額・解約方法を最終確認画面で明確表示する義務 (2022 年改正)。",
  },
  {
    id: "JP-TOKUSHO-005",
    lawCode: "tokusho",
    ruleKey: "cancellation_difficult",
    patternType: "regex",
    pattern: "(解約|キャンセル).{0,15}(電話のみ|平日のみ|営業時間内のみ)",
    severity: "error",
    descriptionJa: "解約方法を不当に制限することは詐欺的な定期購入商法に該当しうる。",
  },
  {
    id: "JP-TOKUSHO-006",
    lawCode: "tokusho",
    ruleKey: "delivery_time_missing",
    patternType: "regex",
    pattern: "(発送|お届け|引き渡し).{0,10}(時期|日)",
    severity: "info",
    descriptionJa: "商品の引渡時期・サービスの提供時期は明示義務 (特商法施行規則 8 条)。",
  },
  {
    id: "JP-TOKUSHO-007",
    lawCode: "tokusho",
    ruleKey: "payment_method_unclear",
    patternType: "regex",
    pattern: "(支払方法|お支払い|決済方法)",
    severity: "info",
    descriptionJa: "代金の支払時期・支払方法の表示義務。",
  },
  {
    id: "JP-TOKUSHO-008",
    lawCode: "tokusho",
    ruleKey: "auto_renewal_hidden",
    patternType: "regex",
    pattern: "(自動更新|自動継続|自動課金)",
    severity: "warning",
    descriptionJa: "自動更新契約は更新条件・解約期限を明示する義務。隠れた条件はクーリングオフ対象となる。",
  },
  {
    id: "JP-TOKUSHO-009",
    lawCode: "tokusho",
    ruleKey: "digital_environment_missing",
    patternType: "regex",
    pattern: "(ソフトウェア|アプリ|デジタルコンテンツ)",
    severity: "info",
    descriptionJa: "デジタルコンテンツの動作環境 (OS / ブラウザ / 必須スペック等) の表示が必要。",
  },
  {
    id: "JP-TOKUSHO-010",
    lawCode: "tokusho",
    ruleKey: "complaint_contact_missing",
    patternType: "regex",
    pattern: "(お問い合わせ先|苦情受付|カスタマーサポート)",
    severity: "info",
    descriptionJa: "苦情・相談窓口の連絡先表示義務。電話番号・メールアドレスのいずれかを明示する。",
  },
];

# @torihanaku/slack-harness

Slack ユーザー ↔ アプリユーザーの解決（1時間キャッシュ・graceful degradation）と、承認フロー向け Block Kit メッセージ/却下モーダルの構築・DM 送信ハーネス。

移植元: 実運用SaaS `server/lib/slack-user-mapping.ts` + `server/lib/firewall/slack-notifier.ts`

## 責務境界（重複なし）

- **署名検証（Slack request signing / X-Slack-Signature）は本パッケージに含めない** — `@torihanaku/kit-approval-workflow` が担当。本パッケージは「解決・構築・送信」のみ
- triage（却下理由候補）の AI 生成・DB 永続化も対象外。呼び出し側が `RejectOption[]` を組み立てて渡す

## ユーザー解決（Slack ID → アプリユーザーID）

`users.info` で email を取得 → 注入された lookup で自アプリのユーザーIDへ。トークン・API・lookup のどれが欠けても例外を投げず null（結果は tenant×SlackID 単位で 1h キャッシュ、負键もキャッシュ）。

```ts
import { createSlackUserResolver, createRestEmailLookup } from "@torihanaku/slack-harness";

const resolver = createSlackUserResolver({
  botToken: env.SLACK_BOT_TOKEN,
  // 任意の実装を注入。移植元相当の PostgREST lookup は組み込みで提供:
  lookupUserByEmail: createRestEmailLookup({
    baseUrl: env.SUPABASE_URL,
    serviceKey: env.SUPABASE_SERVICE_ROLE_KEY,
    table: "dashboard_team_members",
  }),
});

const appUserId = await resolver.resolve("U123ABC", tenantId); // string | null
```

## 承認メッセージ（Block Kit）

構造は移植元と同一: 見出し / リスクスコア（🔴>40 / ⚠️>0 / ✅）/ 本文200字引用 / 代替案（案B, 案C…）/ 想定却下理由 context / [承認(primary)] [却下(danger)] ボタン。却下ボタンの `value` に却下理由候補を同梱するので、interaction handler は AI 再実行なしでモーダルを組める。

```ts
import { buildApprovalBlockKit, buildRejectModalView, notifyByEmail } from "@torihanaku/slack-harness";

const payload = buildApprovalBlockKit(
  { id, tenantId, submitterId, approverId, title, contentText },
  { riskScore: 42, summary: "要注意ポイント…" },
  [{ code: "tone_error", label: "トーン不一致" }],       // 却下理由候補（呼び出し側で生成）
  [{ deviationAxis: "トーン", estimatedRisk: "低", content: "…", hypothesizedUpside: "…" }], // 任意
  { headline: "新企画案の提出がありました" },            // copy 上書き（任意）
);

await notifyByEmail("approver@example.com", payload, env.SLACK_BOT_TOKEN); // lookupByEmail → DM
// 個別にも使える: resolveSlackUserIdByEmail / postSlackDm

const modal = buildRejectModalView(
  { submissionId, approverId, tenantId },
  options, // 先頭3件 + 「その他（自由記述）」radio + 補足 free text
);
```

文言・action_id・callback_id はすべて `copy` パラメータで差し替え可能（デフォルトは汎用: `approval_approve` / `approval_reject_open` / `approval_reject_modal`。移植元の `firewall_*` にしたい場合は上書きする）。

## 変更点（移植元との差分）

- env 直接参照 → ファクトリ/関数引数でトークン・fetch・ログを注入
- Supabase REST lookup 直書き → `lookupUserByEmail` 注入 + `createRestEmailLookup` 組み込み（テーブル名可変）
- `notifyApprover` の Supabase auth / triage 生成・永続化 → 削除し、汎用の `notifyByEmail`（解決→DM）に縮約
- 承認固有文言（"新企画案" / "Firewall Lint 結果" / `firewall_*` ID）→ `ApprovalCopy` / `RejectModalCopy` パラメータ化（構造・切り詰め・絵文字閾値は同一）

## ランタイム要件

- `fetch` が使える環境（Node 18+ / Bun / edge）。依存パッケージなし。

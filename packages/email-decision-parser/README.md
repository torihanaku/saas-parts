# @torihanaku/email-decision-parser

メール返信の本文（MIME body）から「承認 / 却下」の意思決定と理由を抽出するパーサー。承認ワークフローの「メールに *approve* / *承認* と返信するだけで決裁が完了する」ヘッドレス承認機能の中核です。

## 用途

- 承認依頼メールへの返信を受信（inbound webhook 等）→ `parseReply()` で判定 → ワークフローを進める
- 判定ロジック: 返信の**最初の非空行**をキーワード照合
  - 承認: `approve` / `approved` / `ok` / `yes` / `承認`（既定・日英）
  - 却下: `reject` / `rejected` / `no` / `deny` / `却下` / `不承認`（既定・日英）
- 却下時は理由も抽出: 同一行の「`Reject: 高すぎる`」形式（inline reason）と、後続行（引用行 `>` や「On ... wrote:」等の返信マーカーは除去）を連結

## API 例

```ts
import { parseReply } from "@torihanaku/email-decision-parser";

parseReply("Approve");
// → { decision: "approve" }

parseReply("却下\n予算オーバーのため");
// → { decision: "reject", reason: "予算オーバーのため" }

parseReply("Reject: too expensive\n> 元メールの引用...\nOn Mon, Bob wrote:");
// → { decision: "reject", reason: "too expensive" }（引用・返信マーカーは無視）

parseReply("了解です、確認します");
// → null（意思決定なし）
```

## 設定

`parseReply(mimeBody, config?)` の第 2 引数（`EmailDecisionParserConfig`）で全パターンを差し替え可能:

| オプション | 既定値 | 説明 |
|---|---|---|
| `approvalPatterns` | `DEFAULT_APPROVAL_PATTERNS`（日英 5 種） | 1 行目（小文字化済み）に対する承認判定の正規表現群 |
| `rejectionPatterns` | `DEFAULT_REJECTION_PATTERNS`（日英 6 種） | 同・却下判定 |
| `inlineReasonPattern` | `DEFAULT_INLINE_REASON_PATTERN` | 1 行目の「キーワード: 理由」から理由を抜くパターン（capture group 1 が理由） |
| `replyMarkerFilter` | 引用行 `>` と `wrote:` を除去 | 後続行を理由として採用するかのフィルタ |

```ts
import {
  parseReply,
  DEFAULT_APPROVAL_PATTERNS,
} from "@torihanaku/email-decision-parser";

// 例: 社内用語「LGTM」を承認扱いに追加
const result = parseReply(body, {
  approvalPatterns: [...DEFAULT_APPROVAL_PATTERNS, /^\s*lgtm/i],
});
```

既定パターンは `DEFAULT_APPROVAL_PATTERNS` / `DEFAULT_REJECTION_PATTERNS` / `DEFAULT_INLINE_REASON_PATTERN` としてエクスポートされているため、拡張ベースに使えます。

## Runtime

- Node.js / Bun / edge / ブラウザ（純粋関数のみ、環境依存 API なし）
- 外部依存なし・`process.env` 参照なし・I/O なし
- peerDependencies なし

## 出典

`dev-dashboard-v2` の `server/services/emailReplyParser.ts`（66 行）。判定ロジック（1 行目キーワード照合・inline reason・返信マーカー除去）は原典どおりで、ハードコードだった日英キーワード群を設定可能な `EmailDecisionParserConfig` に昇格（既定値は原典パターン）。

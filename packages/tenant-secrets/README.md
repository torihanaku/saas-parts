# @torihanaku/tenant-secrets

テナントごとの暗号化シークレット保管庫（BYOK — "bring your own key"）。AES-256-GCM で暗号化保存し、未設定時は注入された env レコードへフォールバックする。プロバイダ疎通確認（ping）レジストリ付き。

## 主要API

```ts
import { createTenantSecretVault, InMemorySecretStore } from "@torihanaku/tenant-secrets";

const vault = createTenantSecretVault({
  store: new InMemorySecretStore(),        // 本番は SecretStore を DB 実装で注入
  encryptionSecret: appSessionSecret,       // 元: env.SESSION_SECRET（鍵は HMAC 導出）
  env: { ANTHROPIC_API_KEY: envValue },     // env フォールバック連鎖（process.env は読まない）
  // keys: ["ANTHROPIC_API_KEY", ...] 任意のプロバイダキー一覧に差し替え可
});

await vault.saveSecret("tenant-1", "ANTHROPIC_API_KEY", userProvidedKey, "admin@example.com");
const apiKey = await vault.getSecret("tenant-1", "ANTHROPIC_API_KEY"); // store(復号) → env → null
const meta = await vault.describeSecret("tenant-1", "ANTHROPIC_API_KEY");
// => { configured: true, source: "tenant", last4: "abcd" }  ※値そのものは返さない
await vault.pingProvider("ANTHROPIC_API_KEY", apiKey!); // 実APIへ疎通確認
await vault.deleteSecret("tenant-1", "ANTHROPIC_API_KEY");
```

### 解決順序（フォールバック連鎖）

1. tenantId 指定あり → store の行を復号して返す
2. 行が無い／復号失敗 → `env[key]`（空文字は未設定扱い）
3. どちらも無ければ `null`

### legacy 平文互換

暗号化導入以前に保存された平文行（`iv:tag:cipher` フォーマットに見えない値）は、デフォルトでそのまま平文として読める（`legacyPlaintext: false` で無効化＝復号失敗は常に env フォールバック）。フォーマットには見えるが復号できない値（鍵ローテーション後など）は平文扱いせず env にフォールバックする。

### デフォルトのプロバイダキー

`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `FAL_KEY` / `SLACK_BOT_TOKEN` / `STRIPE_SECRET_KEY`（`keys` オプションで任意リストに変更可。ping ハンドラも `pingHandlers` で差し替え・追加可）。

## 依存

- Node.js 標準 `node:crypto` のみ（外部 peerDeps なし。ping は グローバル fetch を使用）

## 注入ポイント

| 注入先 | 元実装 |
|---|---|
| `store: SecretStore` | Supabase REST（`dd_tenant_secrets` テーブル、supabaseGet/Insert/Patch/Delete） |
| `encryptionSecret` | `env.SESSION_SECRET`（token.ts の鍵導出をインライン移植） |
| `env` | `server/lib/env.ts`（process.env 読み取りは撤去） |
| `keys` / `pingHandlers` | 元実装のハードコード 5 プロバイダ（デフォルトとして残置） |

## 想定ランタイム

Node.js 18+ / Bun（`node:crypto` と グローバル fetch が必要）。サーバーサイド専用 — クライアントに秘密値を渡さないこと。

## セキュリティ注意

- テスト・README の鍵値はすべて明らかなダミー。実鍵をコード・テスト・ドキュメントに書かない。
- `describeSecret` は値を返さない（configured / source / last4 のみ）。UI にはこちらを使う。

## 出典

- `実運用SaaS/server/lib/tenant-secrets.ts` (~246 LOC, #991 Phase 4)
- 暗号関数: `実運用SaaS/server/lib/token.ts` の encrypt/decrypt（プライベートコピー）
- legacy 平文互換: `実運用SaaS/server/lib/nango-client.ts` の readStoredSecret パターン
- テスト移植元: `実運用SaaS/tests/tenant-secrets.test.ts`

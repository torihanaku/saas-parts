# @torihanaku/supabase-dal

Supabase（PostgREST）REST APIの薄いテーブル非依存ラッパー。CRUD・INSERT返却・Storageアップロード/ダウンロード・RPC・PostgRESTフィルタの安全エスケープ・相関IDログつき。

## 主要API

```ts
import { createSupabaseDal, escapePostgrestValue } from "@torihanaku/supabase-dal";

const dal = createSupabaseDal({
  url: process.env.SUPABASE_URL!,                    // 値はSecret Manager等から注入
  serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  getCorrelationId: () => requestContext.getRequestId(), // 任意。X-Correlation-Idヘッダー＋ログのrequest_id
});

// テーブル名は常に引数（ハードコードなし）
const rows = await dal.get("items", "project_id=eq.p1&order=created_at.desc"); // 失敗時 null
const r1 = await dal.insert("items", { title: "A" });                // { ok, error?, status? }
const r2 = await dal.insertReturning("items", { title: "B" });       // { ok, data? } 挿入行を返す
const r3 = await dal.patch("items", "id=eq.abc", { status: "done" });
const r4 = await dal.delete("items", "id=eq.abc");
const fn = await dal.rpc<{ id: string }[]>("match_items", { query: "x" }); // POST /rest/v1/rpc/{fn}

// Storage
await dal.upload("docs", "reports/a.pdf", fileBody, "application/pdf"); // x-upsert: true
const res = await dal.download("docs", "reports/a.pdf"); // 生のResponse（失敗時null）

// ユーザー入力をilike/eq/orフィルタに使う前のエスケープ（インジェクション対策）
const safe = escapePostgrestValue(userInput);
```

## 依存

なし（fetchグローバルのみ。Node 18+/Bun/エッジで標準）。

## 設定ポイント（何を注入するか）

- `url`（必須）: SupabaseプロジェクトURLまたはpooler URL。envの読み込みは呼び出し側の責任（本パッケージはenvを読まない）
- `serviceRoleKey`（必須）: APIキーの**値**を注入する。ソースやmarkdownに値を書かないこと
- `getCorrelationId`（任意）: リクエストスコープの相関IDプロバイダ。指定時のみ `X-Correlation-Id` ヘッダー送信＋構造化エラーログに `request_id` を含める
- `fetch`（任意）: カスタムfetch（テスト・リトライラッパー・Proxymanデバッグ用）
- エラーログは `console.error(JSON.stringify({ severity, message, table, status, ... }))` のCloud Logging互換構造化形式（元実装と同じ）
- 元実装のプロダクト固有ヘルパー（dashboard_state / dashboard_activity / sso_configurations / dd_embeddings / RLSステージ付き rpcAsTenant）は移植時に削除。全てテーブル名パラメータの汎用メソッドで代替可能

## @torihanaku/persistence との関係（importなし・形状の一致のみ）

`SupabaseDal` インスタンスは persistence パッケージの `DalClient` インターフェースを構造的に満たす:

```ts
interface DalClient {
  get(table: string, query?: string): Promise<unknown[] | null>;
  insert(table: string, data: Record<string, unknown>): Promise<{ ok: boolean }>;
  patch(table: string, filter: string, data: Record<string, unknown>): Promise<{ ok: boolean }>;
  delete?(table: string, filter: string): Promise<{ ok: boolean }>;
}
// new PersistenceLayer(dal, "items", "project_id", "p1") にそのまま渡せる
```

## 想定ランタイム

any（fetchグローバルがあればよい。Node 18+ / Bun / Cloudflare Workers / Deno）

## 出典

実運用SaaS `server/lib/supabase.ts`（テストは `tests/supabase.test.ts` の汎用ヘルパー部分から移植）。

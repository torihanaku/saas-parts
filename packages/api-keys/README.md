# @torihanaku/api-keys

公開APIキーのライフサイクル管理。生成（プレフィックス＋乱数64hex・生キーは作成時に一度だけ返却）、SHA-256ハッシュのみ保存、`x-api-key` / `Authorization: Bearer` からの認証、スコープ、有効期限、使用トラッキング（last_used_at）、失効を提供する。永続化は注入 `ApiKeyStore`（インメモリ実装同梱）。

## 主要API

```ts
import {
  createApiKeyManager,
  createInMemoryApiKeyStore,
  hashKey,
  generateApiKey,
} from "@torihanaku/api-keys";

const manager = createApiKeyManager({
  store: createInMemoryApiKeyStore(), // 本番はDB実装を注入
  prefix: "myapp_",                   // 省略時は元実装どおり "fla_"
  defaultScopes: ["read"],
  rateLimitTier: "standard",
});

// 生成 — rawの key はこの1回しか手に入らない（保存されるのはSHA-256ハッシュのみ）
const created = await manager.createApiKey("user@example.com", "CI用キー", ["read", "content"], "2027-01-01T00:00:00Z");
created?.key;           // "myapp_ab12..."（ユーザーに一度だけ表示）
created?.record;        // { id, key_prefix: "myapp_ab12...", scopes, expires_at, ... }

// 認証 — x-api-key または Authorization: Bearer。無効/期限切れ/失効済みは null
const record = await manager.authenticateApiKey(req);
if (!record) return new Response("Unauthorized", { status: 401 });
record.scopes;          // 認可判定に使う

// 一覧・失効
await manager.fetchApiKeysByUser("user@example.com"); // 作成日時降順
await manager.revokeApiKey(record.id, "user@example.com"); // enabled=false（所有者一致必須）
```

### ApiKeyStore を自前実装する場合

```ts
interface ApiKeyStore {
  insert(row: ApiKeyInsert): Promise<ApiKeyRecord | null>;
  findEnabledByHash(keyHash: string): Promise<ApiKeyRecord | null>; // enabled=true のみ
  listByUser(userId: string): Promise<ApiKeyRecord[] | null>;
  touchLastUsed(id: string, lastUsedAt: string): Promise<void>;     // fire-and-forgetで呼ばれる
  revoke(keyId: string, userId: string): Promise<boolean>;          // 所有者スコープ必須
}
```

## 依存

なし（Web Crypto の `crypto.subtle` / `crypto.getRandomValues` を使用）。

## 注入ポイント

- `store` — 永続化。元実装は Supabase REST（`dd_api_keys` テーブル）だった。scopes は string[] のまま渡す（JSON化するかは store の責務）
- `prefix` — キーのプレフィックス（認証時のフォーマット早期判定にも使用）。`key_prefix` はプレフィックス＋先頭8文字
- `defaultScopes` / `rateLimitTier` / `logger` / `now`（テスト用）

## 想定ランタイム

Node 18+ / Bun / Edge（Web Crypto と `Request` があればよい）。

## 出典

`dev-dashboard-v2/server/lib/api-key-auth.ts`（テスト: `tests/api-key-auth.test.ts` を移植・拡張）

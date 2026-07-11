# @torihanaku/white-label-branding

テナント別のブランディング設定（ロゴ／色／ブランド名／独自ドメイン）の CRUD と、パートナー（リセラー）↔ クライアント関係の管理・認可ヘルパー。dev-dashboard-v2 の `white-label.ts` (#346) から抽出しました。

- **永続化 → store 注入** (`WhiteLabelStore`)。元は Supabase (`dd_white_label_configs` / `dd_partner_relationships`) への PostgREST クエリでした。セマンティックなメソッド（`getConfig` / `insertConfig` / `patchConfig` / `hasActiveRelationship` / `listRelationships` / `insertRelationship`）に置き換えています。
- 型（`WhiteLabelConfig` 等）と入力バリデータ（`validateWhiteLabelConfigUpdate` / `validateCreatePartnerClient`）も同梱（自己完結）。

## 使い方

```ts
import { createWhiteLabelBranding, type WhiteLabelStore } from "@torihanaku/white-label-branding";

const store: WhiteLabelStore = {
  getConfig: (t) => db.wlConfigs.findOne(t),
  insertConfig: (t, cfg) => db.wlConfigs.insert({ tenant_id: t, ...cfg }),
  patchConfig: (t, patch) => db.wlConfigs.patch(t, patch),
  hasActiveRelationship: (p, c) => db.rels.existsActive(p, c),
  listRelationships: (p, status) => db.rels.list(p, status),
  insertRelationship: (rel) => db.rels.insert(rel),
};

const branding = createWhiteLabelBranding(store);

await branding.upsertWhiteLabelConfig(tenantId, { brand_name: "Acme", primary_color: "#f00" });
const cfg = await branding.getWhiteLabelConfig(tenantId); // 無ければ null → caller が既定ブランドを当てる
const owns = await branding.assertPartnerOwnsClient(partnerId, clientId); // active のみ true
await branding.createPartnerRelationship(partnerId, clientId, { plan_tier: "growth" });
```

## API

| メソッド | 説明 |
|---|---|
| `getWhiteLabelConfig(tenantId)` | 設定を 1 件取得。無ければ null |
| `upsertWhiteLabelConfig(tenantId, patch)` | 既存あれば patch、無ければ insert |
| `assertPartnerOwnsClient(partnerId, clientId)` | active 関係のみ true（partner==client / 空 id は false） |
| `listPartnerClients(partnerId, {status})` | partner の client 関係一覧 |
| `createPartnerRelationship(partnerId, clientId, {plan_tier, reseller_pricing_jpy, status})` | 関係を作成（重複等は false） |

エラー時は例外を投げず `null` / `false` / `[]` を返します（原文の防御的挙動を維持）。

## アセットアップロード

ロゴ／favicon の実ファイルアップロードはこのパッケージの責務外です。**`@torihanaku/storage-upload`** でアップロードし、得られた URL を `logo_url` / `favicon_url` として `upsertWhiteLabelConfig` に渡してください（本パッケージは storage-upload を import しません）。

## 出典

- `server/lib/white-label.ts`
- `shared/types/white-label.ts`（型 + バリデータ）

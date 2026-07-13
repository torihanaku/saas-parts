# @torihanaku/sql-templates

## 用途

マルチテナント SaaS の Postgres（Supabase 想定）マイグレーション雛形集です。コンパイル対象のコードではなく、**新規プロジェクトの `supabase/migrations/` にコピーし、テーブル名・`{{PLACEHOLDER}}` を自プロダクト向けに置換して使うテンプレート**を `templates/` に収録しています（`main`/`exports` なし・`src/` なしのため tsc / vitest の対象外）。

出典: `dev-dashboard-v2/supabase/migrations/`。元リポの製品固有プレフィックス（`dd_` / `dashboard_` / `sup_`）と製品固有 seed 値は汎用名・プレースホルダに置換済み。秘密情報・実プロジェクト ID は含みません。

## 収録テンプレート一覧

| ファイル | 提供するもの | 元ファイル |
|---|---|---|
| `001_multitenant_foundation.sql` | `team_members` に `status`（active/invited/suspended CHECK）と `tenant_id`（tenants FK）を追加。インデックス2本＋service_role のみ許可する RLS | `202603280001_multitenant_foundation.sql` |
| `002_agency_mode_foundation.sql` | 代理店モードの土台。`tenants.type`（direct/agency）＋`managed_clients uuid[]`、`team_members.assigned_clients`＋3層 role CHECK 拡張、`audit_log` に `risk_level`/`archived_to_gcs`/`gcs_archive_path`、`v_agency_accessible_clients` view | `202604240001_001_agency_mode_foundation.sql` |
| `003_product_subscriptions.sql` | product-aware 課金。`products` / `product_plans` / `tenant_product_subscriptions`（Stripe customer/subscription 紐付け・tenant×product UNIQUE）/ `tenant_product_entitlements`。RLS 有効化＋seed 例 | `20260510_dd_product_subscriptions.sql` |
| `004_stripe_webhook_events.sql` | Stripe Webhook の冪等性テーブル（event_id PK。リトライ時の二重処理防止） | `202603280002_stripe_webhook_events.sql` |
| `005_audit_logs.sql` | シンプルな append-only 監査ログ `audit_logs`（INSERT/SELECT ポリシーのみ＝実質 immutable） | `202603250010_create_audit_logs.sql` |
| `006_audit_hash_chain.sql` | `audit_log` へのハッシュチェーン列追加（prev_hash/entry_hash 等・BYTEA）＋`(tenant_id, entry_hash)` UNIQUE＋UPDATE/DELETE REVOKE で改ざん検知 | `202604200003_003_audit_hash_chain.sql` |
| `007_consent_registry.sql` | GDPR 同意台帳 `consent_registry`（tenant×user×purpose PK・revoked_at で撤回）＋`auth.users.deleted_member_flag`（権限不足時はスキップ） | `202604200005_005_consent_registry.sql` |
| `008_email_deliveries.sql` | テナント別メール配信ログ `email_deliveries`（bounce 率監視用。status CHECK・tenant RLS・監視用インデックス2本） | `20260507_dd_email_deliveries.sql` |
| `_helpers_triggers_rls.sql` | 特定テーブルに紐づかない**汎用トリガー・RLS ヘルパー集**（下記「再利用トリガー・RLSヘルパー」参照） | 複数マイグレーションに散在する共通パターンを集約 |

## 再利用トリガー・RLSヘルパー

`_helpers_triggers_rls.sql` は、個別テーブルのマイグレーションに毎回コピペされていた**横断的な定型パターン**を 1 ファイルに切り出したものです。テーブル名はすべて `{{TABLE}}` に汎用化し、必要なブロックだけを取り出して置換して使います。

| ヘルパー | 何をするか | 適用方法 |
|---|---|---|
| **1) updated_at 自動更新トリガー** | `set_updated_at()` 関数（`NEW.updated_at = now()` を返す・`CREATE OR REPLACE` で重複安全）＋各テーブルへの `BEFORE UPDATE` トリガー例。行が更新されるたびに `updated_at` を自動で現在時刻にする | 関数はプロジェクトに 1 回だけ定義。以後は各テーブルで `trg_{{TABLE}}_updated_at` トリガーを張るだけ（対象テーブルに `updated_at TIMESTAMPTZ` 列が必要） |
| **2) ソフトデリート** | `deleted_at` 列の追加＋生存行のみを効率よく引く部分インデックス＋ソフトデリート済みを除外するビュー `vw_{{TABLE}}_active`。物理削除せず削除フラグで論理削除（GDPR 用途にも） | `{{TABLE}}` を置換。アプリは原則ビューを参照。RLS で除外したい場合は既存ポリシーの `USING` に `deleted_at IS NULL AND …` を足す注釈付き |
| **3-a) テナント分離 RLS（GUC）** | `USING (tenant_id::text = current_setting('app.current_tenant_id', true))` の全操作ポリシー。API がリクエスト毎に `SET app.current_tenant_id` する構成向け。service_role へ全行 SELECT を開ける任意ブロック付き | `{{TABLE}}` と tenant 列名を置換。`ENABLE ROW LEVEL SECURITY` 込み |
| **3-b) ユーザー分離 RLS（auth.uid）** | Supabase ネイティブの `USING (auth.uid() = user_id)`。authenticated ロールが直接テーブルを触る構成向け | `{{TABLE}}` を置換。`user_id` は Supabase auth のユーザー UUID である前提 |
| **3-c) ユーザー分離 RLS（JWT email + service_role）** | 所有者をメールアドレスで持ち、`current_setting('request.jwt.claim.email', true)` で判定＋`role = 'service_role'` フォールバック。API を service_role で通す構成向け | `{{TABLE}}` を置換。`user_id` が TEXT（email）の前提 |

適用時の注意: RLS は 3-a / 3-b / 3-c の**いずれか 1 つ**を構成に合わせて選ぶ（複数を同一テーブルに重ねない）。トリガーとソフトデリートは RLS パターンと独立に併用可。

## テーブル関係図

```
tenants (前提: 既存)
 ├─ team_members.tenant_id ──────────── FK (001)
 │    └─ assigned_clients uuid[] ────── agency_member の担当クライアント (002)
 ├─ managed_clients uuid[] ──────────── agency → client の親子関係 (002)
 │    └─ v_agency_accessible_clients ── UNNEST + self JOIN の view (002)
 ├─ tenant_product_subscriptions ────── FK, products(key) と多対多 (003)
 ├─ tenant_product_entitlements ─────── FK, 機能フラグ/上限 (003)
 └─ email_deliveries.tenant_id ──────── FK (008)

products (003)
 ├─ product_plans ───────────────────── plan_key: free/pro/enterprise, stripe_price_id
 └─ tenant_product_subscriptions ────── status: trialing/active/past_due/canceled/unpaid

audit_log (前提: 既存。002 で risk_level/GCS archive 列、006 でハッシュチェーン列を追加)
audit_logs (005 が新規作成する簡易版。audit_log とは別テーブル)
stripe_webhook_events (004・独立)
consent_registry (007・tenant_id/user_id は FK なしの疎結合)
```

## 適用順序

前提テーブル（`tenants`、`team_members`、006 まで使うなら `audit_log`）を先に用意した上で:

1. `001_multitenant_foundation.sql` — tenant 分離の土台
2. `002_agency_mode_foundation.sql` — 001 の `team_members` と既存 `audit_log`（`tenant_id`/`occurred_at` 列必須）に依存
3. `003_product_subscriptions.sql` — `tenants` に依存
4. `004_stripe_webhook_events.sql` — 独立（003 と同時期推奨）
5. `005_audit_logs.sql` — 独立
6. `006_audit_hash_chain.sql` — `audit_log`（002 と同じ方）に依存。列追加が `IF NOT EXISTS` なしのため再実行不可・1回だけ適用
7. `007_consent_registry.sql` — 独立（Supabase の `auth.users` があれば退職者フラグも付く）
8. `008_email_deliveries.sql` — `tenants` と `current_tenant_id()` 関数に依存

## リネーム・置換ガイド

| テンプレート内の名前 | 元リポでの名前 | 置換の指針 |
|---|---|---|
| `team_members` | `dashboard_team_members` | 自プロダクトのメンバーシップテーブル名に一括置換（インデックス名 `idx_team_members_*`・制約名 `team_members_role_check`・ポリシー名も揃えて置換） |
| `email_deliveries` | `dd_email_deliveries` | 同上（ポリシー名 `email_deliveries_*`・インデックス名 `idx_email_deliveries_*` も） |
| `consent_registry` | `sup_consent_registry` | 同上（`idx_consent_active` はそのままで可） |
| `tenants(id)` (008 の FK) | `teams(id)` | 元実装ではテナント親テーブルが `teams` だった。本テンプレートは他ファイルと揃えて `tenants` に統一済み。自環境の親テーブルに合わせる |
| `{{PRODUCT_KEY}}` ほか (003 の seed) | Folia 製品 5 行の実値 | 自プロダクトの key/name/subdomain/path に置換。アプリ起動時に同期するならこの seed 自体削除も可 |
| `current_tenant_id()` (008) | 同名関数 | JWT クレーム等から現在の tenant_id を返す SQL 関数を各自定義（例: `(auth.jwt() ->> 'tenant_id')::uuid` を返す STABLE 関数） |
| `audit_log` vs `audit_logs` | 同じ二重構造 | 元リポには両方存在（`audit_logs`=シンプル版 #005、`audit_log`=tenant 対応版で 002/006 が拡張）。新規プロジェクトでは片方に統一し、005 を使うなら 002/006 の対象テーブル名・列（`tenant_id`, `occurred_at`）を合わせること |

## 適用時の注意

- 001/002 の RLS は「API は常に service_role キーでアクセスする」前提。anon/authenticated から直接触る構成なら tenant 判定ポリシー（008 の形式）に差し替える
- 003 の `tenant_product_subscriptions` / `tenant_product_entitlements` は `TO authenticated` の tenant 分離ポリシー＋`TO service_role` の全許可を明示（`current_tenant_id()` 関数が前提）。ENABLE だけでポリシー未定義だとテーブルオーナーがバイパスしてテナント分離が効かないため
- 004 / 005 のポリシーは `TO service_role` にロールを明示（`USING (true)` を PUBLIC に開くと anon/authenticated が webhook イベントや監査ログの PII を横断参照できてしまうため）。005 の audit_logs を anon/authenticated から読ませたい場合は tenant_id 列を足して 008 形式のポリシーにする
- 006 は追記専用化のため `REVOKE UPDATE, DELETE ... FROM PUBLIC` を含む。管理オペレーションも UPDATE 不可になる点に注意
- ハッシュチェーン（006）の prev_hash/entry_hash の計算・検証はアプリ側の責務（このテンプレートはスキーマのみ）

## 依存 / 想定ランタイム

PostgreSQL 14+（`gen_random_uuid()` 標準搭載）。RLS・`auth.users`・service_role/authenticated ロールは Supabase 前提の記述（素の Postgres でも該当部分を読み替えれば可）。

## 出典

`dev-dashboard-v2/supabase/migrations/`（8 ファイル + 汎用ヘルパー 1 ファイル）。ヘルパーは 165 マイグレーションに散在する `set_updated_at()` トリガー／`deleted_at` ソフトデリート／tenant・user 分離 RLS の定型を集約したもの。

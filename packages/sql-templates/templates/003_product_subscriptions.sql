-- Migration: product-aware 課金の根幹（複数プロダクトを 1 プラットフォームで課金管理する）
-- Prerequisite: tenants テーブルが存在すること。

-- products テーブル
-- NOTE: This table is automatically synced from the TypeScript PRODUCTS constant
-- at server startup via syncProductsToDb(). Do not INSERT manually.
CREATE TABLE IF NOT EXISTS products (
  key text PRIMARY KEY,
  name text NOT NULL,
  short_name text NOT NULL,
  default_subdomain text NOT NULL,
  default_path text NOT NULL,
  status text NOT NULL CHECK (status IN ('draft','beta','active','deprecated')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- product_plans テーブル（Stripe 価格設定の audit trail）
CREATE TABLE IF NOT EXISTS product_plans (
  product_key text NOT NULL REFERENCES products(key),
  plan_key text NOT NULL CHECK (plan_key IN ('free','pro','enterprise')),
  name text NOT NULL,
  monthly_price_jpy integer,
  stripe_price_id text,
  status text NOT NULL CHECK (status IN ('active','archived')),
  PRIMARY KEY (product_key, plan_key)
);

-- tenant_product_subscriptions テーブル（product-aware 課金の根幹）
CREATE TABLE IF NOT EXISTS tenant_product_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_key text NOT NULL REFERENCES products(key),
  plan_key text NOT NULL CHECK (plan_key IN ('free','pro','enterprise')),
  status text NOT NULL CHECK (status IN ('trialing','active','past_due','canceled','unpaid')),
  stripe_customer_id text,
  stripe_subscription_id text UNIQUE,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, product_key)
);

-- tenant_product_entitlements テーブル
CREATE TABLE IF NOT EXISTS tenant_product_entitlements (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_key text NOT NULL REFERENCES products(key),
  entitlement_key text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  limit_value integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, product_key, entitlement_key)
);

-- 書き込み権限（多層防御）
-- 課金・権利・プロダクト定義はテナント利用者に書かせない。書き込むのは Stripe webhook /
-- 起動時の syncProductsToDb() など service_role（またはテーブルオーナー）だけ。
-- Supabase は新しい表に anon/authenticated へ GRANT ALL を付けるため、ここで明示的に外す。
-- 外すのは SELECT 以外の全権限: INSERT/UPDATE/DELETE/TRUNCATE/TRIGGER/REFERENCES と、
-- PG17 以上にだけある MAINTAIN（VACUUM/ANALYZE/REFRESH 等。PG16 以下で書くと構文エラー）。
-- anon はロールがある時だけ外す（素の Postgres に anon が無くても通る）。
DO $$
DECLARE
  privs text := 'INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES';
  r text;
BEGIN
  IF current_setting('server_version_num')::int >= 170000 THEN
    privs := privs || ', MAINTAIN';
  END IF;
  FOREACH r IN ARRAY ARRAY['authenticated', 'anon'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE %s ON tenant_product_subscriptions, tenant_product_entitlements, '
                     'products, product_plans FROM %I', privs, r);
    END IF;
  END LOOP;
END $$;

-- TRUNCATE には RLS が効かない。ホストが GRANT ALL で権限を戻した場合に備え、
-- テーブルオーナー（とそのメンバー・スーパーユーザー）以外の TRUNCATE をトリガーで拒否する。
-- service_role も含めて拒否する（webhook / 同期処理は TRUNCATE を使わない）。
-- 008 にも同じ関数があり、CREATE OR REPLACE なのでどちらを先に流しても・何度流しても通る。
CREATE OR REPLACE FUNCTION deny_truncate_unless_owner() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NOT pg_has_role(current_user,
                     (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'MEMBER') THEN
    RAISE EXCEPTION 'TRUNCATE on % is not allowed for role %', TG_TABLE_NAME, current_user
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS tenant_product_subscriptions_deny_truncate ON tenant_product_subscriptions;
CREATE TRIGGER tenant_product_subscriptions_deny_truncate
  BEFORE TRUNCATE ON tenant_product_subscriptions
  FOR EACH STATEMENT EXECUTE FUNCTION deny_truncate_unless_owner();
DROP TRIGGER IF EXISTS tenant_product_entitlements_deny_truncate ON tenant_product_entitlements;
CREATE TRIGGER tenant_product_entitlements_deny_truncate
  BEFORE TRUNCATE ON tenant_product_entitlements
  FOR EACH STATEMENT EXECUTE FUNCTION deny_truncate_unless_owner();
DROP TRIGGER IF EXISTS products_deny_truncate ON products;
CREATE TRIGGER products_deny_truncate
  BEFORE TRUNCATE ON products
  FOR EACH STATEMENT EXECUTE FUNCTION deny_truncate_unless_owner();
DROP TRIGGER IF EXISTS product_plans_deny_truncate ON product_plans;
CREATE TRIGGER product_plans_deny_truncate
  BEFORE TRUNCATE ON product_plans
  FOR EACH STATEMENT EXECUTE FUNCTION deny_truncate_unless_owner();

-- Row Level Security
-- ⚠ ENABLE だけでポリシー未定義だと「非オーナーロールは全拒否 / テーブルオーナーは
--    バイパスして全アクセス」になり、テナント分離が DB 層で一切効かない。課金・権限は
--    最も機微なテーブルなので、tenant 分離ポリシー＋service_role を明示する。
-- authenticated は自テナントの行を **読むだけ**（FOR SELECT）。FOR ALL にすると
-- 利用者が自テナントの plan_key / status / limit_value を書き換えて課金を回避できる（SA-0001）。
-- 前提: JWT クレーム等から現在の tenant_id を返す current_tenant_id() 関数が存在すること
--       （README のリネームガイド参照。例: (auth.jwt() ->> 'tenant_id')::uuid を返す STABLE 関数）。
--       ロール authenticated / service_role が存在すること（anon は任意）。
ALTER TABLE tenant_product_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_product_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_plans ENABLE ROW LEVEL SECURITY;

-- products / product_plans（全テナント共通のカタログ）
-- 誰でも読める（料金ページ等。読めるかどうかは SELECT 権限で決まる）が、書けるのは
-- service_role とテーブルオーナー（syncProductsToDb()）だけ。書き込み系ポリシーを
-- authenticated/anon に作らないので、GRANT ALL を戻されても INSERT/UPDATE/DELETE は
-- RLS で止まる（UPDATE/DELETE は 0 行、INSERT は 42501）。
DROP POLICY IF EXISTS products_read ON products;
CREATE POLICY products_read ON products FOR SELECT USING (TRUE);
DROP POLICY IF EXISTS products_service ON products;
CREATE POLICY products_service ON products
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS product_plans_read ON product_plans;
CREATE POLICY product_plans_read ON product_plans FOR SELECT USING (TRUE);
DROP POLICY IF EXISTS product_plans_service ON product_plans;
CREATE POLICY product_plans_service ON product_plans
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

-- tenant_product_subscriptions
-- 旧版の FOR ALL ポリシー（<t>_tenant）を消してから読み取り専用で作り直す（再適用可）
DROP POLICY IF EXISTS tenant_product_subscriptions_tenant ON tenant_product_subscriptions;
DROP POLICY IF EXISTS tenant_product_subscriptions_tenant_select ON tenant_product_subscriptions;
CREATE POLICY tenant_product_subscriptions_tenant_select ON tenant_product_subscriptions
  FOR SELECT TO authenticated
  USING (tenant_id = (SELECT current_tenant_id()));

DROP POLICY IF EXISTS tenant_product_subscriptions_service ON tenant_product_subscriptions;
CREATE POLICY tenant_product_subscriptions_service ON tenant_product_subscriptions
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

-- tenant_product_entitlements
DROP POLICY IF EXISTS tenant_product_entitlements_tenant ON tenant_product_entitlements;
DROP POLICY IF EXISTS tenant_product_entitlements_tenant_select ON tenant_product_entitlements;
CREATE POLICY tenant_product_entitlements_tenant_select ON tenant_product_entitlements
  FOR SELECT TO authenticated
  USING (tenant_id = (SELECT current_tenant_id()));

DROP POLICY IF EXISTS tenant_product_entitlements_service ON tenant_product_entitlements;
CREATE POLICY tenant_product_entitlements_service ON tenant_product_entitlements
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

-- Initial seed（アプリ側の sync 処理がサーバー起動時に上書きする前提の例。
-- {{...}} を自プロダクトの値に置換すること。元実装は 5 プロダクトを seed していた）
INSERT INTO products (key, name, short_name, default_subdomain, default_path, status) VALUES
  ('{{PRODUCT_KEY}}', '{{PRODUCT_NAME}}', '{{PRODUCT_SHORT_NAME}}', '{{DEFAULT_SUBDOMAIN}}', '{{DEFAULT_PATH}}', 'active')
ON CONFLICT (key) DO NOTHING;

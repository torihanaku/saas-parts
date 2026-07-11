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

-- Row Level Security
ALTER TABLE tenant_product_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_product_entitlements ENABLE ROW LEVEL SECURITY;

-- Initial seed（アプリ側の sync 処理がサーバー起動時に上書きする前提の例。
-- {{...}} を自プロダクトの値に置換すること。元実装は 5 プロダクトを seed していた）
INSERT INTO products (key, name, short_name, default_subdomain, default_path, status) VALUES
  ('{{PRODUCT_KEY}}', '{{PRODUCT_NAME}}', '{{PRODUCT_SHORT_NAME}}', '{{DEFAULT_SUBDOMAIN}}', '{{DEFAULT_PATH}}', 'active')
ON CONFLICT (key) DO NOTHING;

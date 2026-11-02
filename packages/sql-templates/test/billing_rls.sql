-- 課金テーブル（003）と配信ログ（008）の RLS 実地テスト（SA-0001）。
-- rls_isolation.sql の末尾（RESET ROLE の後・ROLLBACK の前）から \ir で読み込まれ、
-- 同じトランザクションの中で流れて最後に ROLLBACK される（ロール・スキーマも残らない）。
--
-- 確かめること（acceptance.md G1〜G3）:
--   - テナントの一般利用者（authenticated）は、自テナントの契約・権利・配信ログを
--     書き換えられない（監査 V1 #0 / #9 の攻撃を反転したもの）
--   - 自テナントの行は読める・他テナントの行は読めない
--   - service_role は書ける
--   - 旧テンプレート適用済みの DB に新テンプレートを再適用しても通り、
--     authenticated の書き込み系ポリシーが残らない
--   - authenticated / anon から INSERT/UPDATE/DELETE/TRUNCATE 権限が外れている
--
-- 失敗は RAISE EXCEPTION 'AC-xx: ...' で止まる（psql -v ON_ERROR_STOP=1）。
--
-- 名前の衝突を避けるため、全オブジェクトを billing_test スキーマに作る。
-- rls_isolation.sql の public.current_tenant_id()（GUC 版）とは別に、
-- README:81 と監査の再現と同じ形 (auth.jwt() ->> 'tenant_id')::uuid の
-- billing_test.current_tenant_id() を作り、search_path で先に解決させる。
-- テンプレートの {{PRODUCT_KEY}} 等は seed の文字列値なので置換せずにそのまま流せる。

\echo '== billing_rls.sql (SA-0001: 003/008) =='

-- 1) スキーマ・JWT クレームの読み取り・current_tenant_id()・tenants の最小テーブル
CREATE SCHEMA billing_test;
CREATE SCHEMA IF NOT EXISTS auth;

CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb
  LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claims', true), '')::jsonb
$$;

CREATE FUNCTION billing_test.current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$
  SELECT (auth.jwt() ->> 'tenant_id')::uuid
$$;

SET LOCAL search_path = billing_test, public;

CREATE TABLE billing_test.tenants (id uuid PRIMARY KEY);

-- 2) Supabase のロール（無ければ作る。service_role はあえて BYPASSRLS にせず、
--    テンプレートの <t>_service ポリシーで書けることを確かめる）
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA billing_test, auth TO anon, authenticated, service_role;

-- Supabase の既定（新しく作られる表に anon/authenticated/service_role へ GRANT ALL）を再現
ALTER DEFAULT PRIVILEGES IN SCHEMA billing_test
  GRANT ALL ON TABLES TO anon, authenticated, service_role;

-- 3) 旧テンプレート（修正前のコピー）を適用 = すでに旧版を流してある DB
\echo 'applying fixtures/003_v0.sql, fixtures/008_v0.sql (old templates)'
\ir fixtures/003_v0.sql
\ir fixtures/008_v0.sql

-- 4) 新テンプレートを再適用（AC-11: 008 は ON_ERROR_STOP=1 で再適用してもエラーにならないこと）
\echo 'applying ../templates/003_product_subscriptions.sql (re-apply)'
\ir ../templates/003_product_subscriptions.sql
\echo 'AC-11: re-applying ../templates/008_email_deliveries.sql over the old 008 must not error'
\ir ../templates/008_email_deliveries.sql
\echo 'AC-11 passed: new 008 re-applied without error'

-- 5) 再適用後のポリシーと権限（AC-10, AC-12, AC-59）
DO $$
DECLARE
  bad text;
  missing text;
BEGIN
  -- AC-10: 003 の 2 表に authenticated の書き込み系ポリシーが残っていない
  SELECT string_agg(tablename || '.' || policyname || '(' || cmd || ')', ', ')
    INTO bad
    FROM pg_policies
   WHERE schemaname = 'billing_test'
     AND tablename IN ('tenant_product_subscriptions', 'tenant_product_entitlements')
     AND 'authenticated' = ANY (roles)
     AND cmd IN ('ALL', 'INSERT', 'UPDATE', 'DELETE');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'AC-10: authenticated write policies remain on 003 tables after re-apply: %', bad;
  END IF;

  -- AC-12: email_deliveries に authenticated の書き込み系ポリシーが残っていない
  SELECT string_agg(policyname || '(' || cmd || ')', ', ')
    INTO bad
    FROM pg_policies
   WHERE schemaname = 'billing_test'
     AND tablename = 'email_deliveries'
     AND 'authenticated' = ANY (roles)
     AND cmd IN ('ALL', 'INSERT', 'UPDATE', 'DELETE');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'AC-12: authenticated write policies remain on email_deliveries after re-apply: %', bad;
  END IF;

  -- AC-59: authenticated / anon は 5 表に INSERT・UPDATE・DELETE・TRUNCATE を持たない
  --        （ALTER DEFAULT PRIVILEGES で付いた GRANT ALL をテンプレートの REVOKE が外す）
  SELECT string_agg(r || ':' || t || ':' || p, ', ')
    INTO bad
    FROM unnest(ARRAY['authenticated', 'anon']) AS r,
         unnest(ARRAY['tenant_product_subscriptions', 'tenant_product_entitlements',
                      'email_deliveries', 'products', 'product_plans']) AS t,
         unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS p
   WHERE has_table_privilege(r, 'billing_test.' || t, p);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'AC-59: write privileges still granted: %', bad;
  END IF;

  -- 前提の確認: 読み取り用・service_role 用のポリシーは残っている
  SELECT string_agg(x, ', ') INTO missing
    FROM unnest(ARRAY['tenant_product_subscriptions', 'tenant_product_entitlements',
                      'email_deliveries']) AS x
   WHERE NOT EXISTS (SELECT 1 FROM pg_policies
                      WHERE schemaname = 'billing_test' AND tablename = x
                        AND 'service_role' = ANY (roles) AND cmd = 'ALL');
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'AC-05: service_role FOR ALL policy missing on: %', missing;
  END IF;

  RAISE NOTICE 'AC-10, AC-12, AC-59 passed';
END $$;

-- 5b) AC-63: 適用後、authenticated / anon は 5 表で INSERT・UPDATE・DELETE・TRUNCATE・
--     TRIGGER・REFERENCES を持たない（MAINTAIN は PG17 以上にだけある権限なので、その時だけ確かめる）
DO $$
DECLARE
  bad text;
  privs text[] := ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES'];
BEGIN
  IF current_setting('server_version_num')::int >= 170000 THEN
    privs := array_append(privs, 'MAINTAIN');
  END IF;
  SELECT string_agg(r || ':' || t || ':' || p, ', ')
    INTO bad
    FROM unnest(ARRAY['authenticated', 'anon']) AS r,
         unnest(ARRAY['tenant_product_subscriptions', 'tenant_product_entitlements',
                      'email_deliveries', 'products', 'product_plans']) AS t,
         unnest(privs) AS p
   WHERE has_table_privilege(r, 'billing_test.' || t, p);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'AC-63: privileges still granted after apply: %', bad;
  END IF;
  RAISE NOTICE 'AC-63 passed (checked: %)', array_to_string(privs, ',');
END $$;

-- 6) シード（オーナー = テーブルオーナーなので RLS を通らない）
INSERT INTO billing_test.tenants (id) VALUES
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222');
INSERT INTO billing_test.products (key, name, short_name, default_subdomain, default_path, status) VALUES
  ('app',  'App',  'App',  'app',  '/app',  'active'),
  ('app2', 'App2', 'App2', 'app2', '/app2', 'active');
INSERT INTO billing_test.tenant_product_subscriptions (tenant_id, product_key, plan_key, status) VALUES
  ('11111111-1111-1111-1111-111111111111', 'app', 'free', 'canceled'),
  ('22222222-2222-2222-2222-222222222222', 'app', 'free', 'canceled');
INSERT INTO billing_test.tenant_product_entitlements (tenant_id, product_key, entitlement_key, enabled, limit_value) VALUES
  ('11111111-1111-1111-1111-111111111111', 'app', 'projects', true, 5);
INSERT INTO billing_test.email_deliveries (tenant_id, status) VALUES
  ('11111111-1111-1111-1111-111111111111', 'delivered'),
  ('22222222-2222-2222-2222-222222222222', 'delivered');

-- 7) テナント A の一般利用者として行う攻撃（監査 V1 #0 / #9 を反転）。
--    書き込みは 42501 で拒否されても 0 行でもよい。INSERT だけは 42501 を要求する。
--    最終状態は RESET ROLE 後に billing_test.assert_owner_state() で読み直して判定する。
CREATE FUNCTION billing_test.tenant_a_attacks(phase text) RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  n int;
BEGIN
  -- AC-04: 自テナントの契約だけが見える
  SELECT count(*) INTO n FROM billing_test.tenant_product_subscriptions;
  IF n <> 1 THEN
    RAISE EXCEPTION 'AC-04 [%]: authenticated sees % subscription rows (expected 1)', phase, n;
  END IF;

  -- AC-09: 自テナントの配信ログだけが見える
  SELECT count(*) INTO n FROM billing_test.email_deliveries;
  IF n <> 1 THEN
    RAISE EXCEPTION 'AC-09 [%]: authenticated sees % email_deliveries rows (expected 1)', phase, n;
  END IF;

  -- AC-01: 自テナントの契約を enterprise/active に書き換える（V1 #0）
  BEGIN
    UPDATE billing_test.tenant_product_subscriptions
       SET plan_key = 'enterprise', status = 'active',
           current_period_end = now() + interval '100 years'
     WHERE tenant_id = '11111111-1111-1111-1111-111111111111';
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 0 THEN
      RAISE EXCEPTION 'AC-01 [%]: authenticated UPDATE of own subscription affected % rows (expected 0 or 42501)', phase, n;
    END IF;
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  -- AC-02: 自テナントの契約行を INSERT（enterprise）→ 42501
  BEGIN
    INSERT INTO billing_test.tenant_product_subscriptions (tenant_id, product_key, plan_key, status)
      VALUES ('11111111-1111-1111-1111-111111111111', 'app2', 'enterprise', 'active');
    RAISE EXCEPTION 'AC-02 [%]: authenticated INSERT into tenant_product_subscriptions succeeded (expected 42501)', phase;
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  -- AC-03: 自テナントの契約を DELETE
  BEGIN
    DELETE FROM billing_test.tenant_product_subscriptions
     WHERE tenant_id = '11111111-1111-1111-1111-111111111111';
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 0 THEN
      RAISE EXCEPTION 'AC-03 [%]: authenticated DELETE of own subscription affected % rows (expected 0 or 42501)', phase, n;
    END IF;
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  -- AC-06: 自テナントに seats=999999 の権利を INSERT（V1 #0）→ 42501
  BEGIN
    INSERT INTO billing_test.tenant_product_entitlements (tenant_id, product_key, entitlement_key, enabled, limit_value)
      VALUES ('11111111-1111-1111-1111-111111111111', 'app', 'seats', true, 999999);
    RAISE EXCEPTION 'AC-06 [%]: authenticated INSERT into tenant_product_entitlements succeeded (expected 42501)', phase;
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  -- AC-07: 自テナントの権利の上限を 999999 に UPDATE
  BEGIN
    UPDATE billing_test.tenant_product_entitlements
       SET limit_value = 999999
     WHERE tenant_id = '11111111-1111-1111-1111-111111111111';
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 0 THEN
      RAISE EXCEPTION 'AC-07 [%]: authenticated UPDATE of own entitlement affected % rows (expected 0 or 42501)', phase, n;
    END IF;
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  -- AC-08: 自テナントの配信ログを偽造 INSERT（V1 #9）→ 42501
  BEGIN
    INSERT INTO billing_test.email_deliveries (tenant_id, status)
      VALUES ('11111111-1111-1111-1111-111111111111', 'delivered');
    RAISE EXCEPTION 'AC-08 [%]: authenticated INSERT into email_deliveries succeeded (expected 42501)', phase;
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END $$;

-- オーナーで読み直して最終状態を判定する（SECURITY INVOKER・RESET ROLE 後に呼ぶ）
CREATE FUNCTION billing_test.assert_owner_state(phase text) RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  pk text;
  st text;
  n int;
  lim int;
BEGIN
  SELECT plan_key, status INTO pk, st
    FROM billing_test.tenant_product_subscriptions
   WHERE tenant_id = '11111111-1111-1111-1111-111111111111' AND product_key = 'app';
  IF pk IS DISTINCT FROM 'free' OR st IS DISTINCT FROM 'canceled' THEN
    RAISE EXCEPTION 'AC-01 [%]: tenant A subscription became plan_key=%, status=% (expected free/canceled)', phase, pk, st;
  END IF;

  SELECT count(*) INTO n FROM billing_test.tenant_product_subscriptions
   WHERE tenant_id = '11111111-1111-1111-1111-111111111111';
  IF n <> 1 THEN
    RAISE EXCEPTION 'AC-02/AC-03 [%]: tenant A has % subscription rows (expected 1)', phase, n;
  END IF;

  SELECT count(*) INTO n FROM billing_test.tenant_product_entitlements
   WHERE tenant_id = '11111111-1111-1111-1111-111111111111' AND entitlement_key = 'seats';
  IF n <> 0 THEN
    RAISE EXCEPTION 'AC-06 [%]: forged seats entitlement exists for tenant A', phase;
  END IF;

  SELECT limit_value INTO lim FROM billing_test.tenant_product_entitlements
   WHERE tenant_id = '11111111-1111-1111-1111-111111111111' AND entitlement_key = 'projects';
  IF lim IS DISTINCT FROM 5 THEN
    RAISE EXCEPTION 'AC-07 [%]: tenant A projects limit_value=% (expected 5)', phase, lim;
  END IF;

  SELECT count(*) INTO n FROM billing_test.email_deliveries
   WHERE tenant_id = '11111111-1111-1111-1111-111111111111';
  IF n <> 1 THEN
    RAISE EXCEPTION 'AC-08 [%]: tenant A has % email_deliveries rows (expected 1)', phase, n;
  END IF;
END $$;

-- 7b) AC-62: 全テナント共通のカタログ表（products / product_plans）への攻撃。
--     ホストが GRANT ALL を戻した後でも authenticated は書き換えられないこと。
--     書き込みは「エラーで拒否」か「0 行」なら可。最終状態はオーナーで読み直して判定する。
INSERT INTO billing_test.product_plans (product_key, plan_key, name, monthly_price_jpy, status) VALUES
  ('app', 'pro', 'Pro', 1000, 'active');

CREATE FUNCTION billing_test.catalog_attacks(phase text) RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  n int;
  succeeded boolean;
BEGIN
  -- products を UPDATE（全テナントの表示名・状態を書き換える）
  BEGIN
    UPDATE billing_test.products SET name = 'pwned', status = 'deprecated' WHERE key = 'app';
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 0 THEN
      RAISE EXCEPTION 'AC-62 [%]: authenticated UPDATE of products affected % rows (expected 0 or error)', phase, n;
    END IF;
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  -- products を DELETE
  BEGIN
    DELETE FROM billing_test.products WHERE key = 'app2';
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 0 THEN
      RAISE EXCEPTION 'AC-62 [%]: authenticated DELETE of products affected % rows (expected 0 or error)', phase, n;
    END IF;
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  -- products に INSERT（成功したらサブトランザクションごと戻して失敗にする）
  succeeded := false;
  BEGIN
    INSERT INTO billing_test.products (key, name, short_name, default_subdomain, default_path, status)
      VALUES ('evil', 'Evil', 'Evil', 'evil', '/evil', 'active');
    succeeded := true;
    RAISE EXCEPTION 'ac62-probe-rollback';
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  IF succeeded THEN
    RAISE EXCEPTION 'AC-62 [%]: authenticated INSERT into products succeeded (expected error)', phase;
  END IF;

  -- product_plans を UPDATE（価格を 0 円・Stripe 価格 ID を差し替える）
  BEGIN
    UPDATE billing_test.product_plans SET monthly_price_jpy = 0, stripe_price_id = 'price_evil'
     WHERE product_key = 'app' AND plan_key = 'pro';
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 0 THEN
      RAISE EXCEPTION 'AC-62 [%]: authenticated UPDATE of product_plans affected % rows (expected 0 or error)', phase, n;
    END IF;
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  -- product_plans を DELETE
  BEGIN
    DELETE FROM billing_test.product_plans WHERE product_key = 'app';
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 0 THEN
      RAISE EXCEPTION 'AC-62 [%]: authenticated DELETE of product_plans affected % rows (expected 0 or error)', phase, n;
    END IF;
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  -- product_plans に INSERT（enterprise を 0 円で作る）
  succeeded := false;
  BEGIN
    INSERT INTO billing_test.product_plans (product_key, plan_key, name, monthly_price_jpy, status)
      VALUES ('app', 'enterprise', 'Free Enterprise', 0, 'active');
    succeeded := true;
    RAISE EXCEPTION 'ac62-probe-rollback';
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  IF succeeded THEN
    RAISE EXCEPTION 'AC-62 [%]: authenticated INSERT into product_plans succeeded (expected error)', phase;
  END IF;
END $$;

CREATE FUNCTION billing_test.assert_catalog_state(phase text) RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  nm text;
  st text;
  price int;
  spid text;
  n int;
BEGIN
  SELECT name, status INTO nm, st FROM billing_test.products WHERE key = 'app';
  IF nm IS DISTINCT FROM 'App' OR st IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'AC-62 [%]: products app became name=%, status=% (expected App/active)', phase, nm, st;
  END IF;
  SELECT count(*) INTO n FROM billing_test.products WHERE key IN ('app', 'app2', 'evil');
  IF n <> 2 THEN
    RAISE EXCEPTION 'AC-62 [%]: products has % of app/app2/evil rows (expected 2: app, app2)', phase, n;
  END IF;
  SELECT monthly_price_jpy, stripe_price_id INTO price, spid
    FROM billing_test.product_plans WHERE product_key = 'app' AND plan_key = 'pro';
  IF price IS DISTINCT FROM 1000 OR spid IS NOT NULL THEN
    RAISE EXCEPTION 'AC-62 [%]: product_plans app/pro became price=%, stripe_price_id=% (expected 1000/NULL)', phase, price, spid;
  END IF;
  SELECT count(*) INTO n FROM billing_test.product_plans WHERE product_key = 'app';
  IF n <> 1 THEN
    RAISE EXCEPTION 'AC-62 [%]: product_plans has % rows for app (expected 1)', phase, n;
  END IF;
END $$;

-- 8a) テンプレートの REVOKE が効いた状態（Supabase 既定 + 新テンプレート）で攻撃
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"role":"authenticated","tenant_id":"11111111-1111-1111-1111-111111111111"}', true);
SELECT billing_test.tenant_a_attacks('as-applied');
SELECT billing_test.catalog_attacks('as-applied');
RESET ROLE;
SELECT billing_test.assert_owner_state('as-applied');
SELECT billing_test.assert_catalog_state('as-applied');

-- 8b) ホスト側が GRANT ALL で権限を戻しても、ポリシーだけで書き込みが止まること（多層防御）
GRANT ALL ON ALL TABLES IN SCHEMA billing_test TO anon, authenticated, service_role;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"role":"authenticated","tenant_id":"11111111-1111-1111-1111-111111111111"}', true);
SELECT billing_test.tenant_a_attacks('after-grant-all');
SELECT billing_test.catalog_attacks('after-grant-all');
RESET ROLE;
SELECT billing_test.assert_owner_state('after-grant-all');
SELECT billing_test.assert_catalog_state('after-grant-all');

-- 8c) AC-62: GRANT ALL を戻した後でも、authenticated は 5 表どれも TRUNCATE できない
--     （TRUNCATE には RLS が効かない）。外部キーで TRUNCATE が弾かれると「拒否」と区別できないので、
--     セーブポイントの中でオーナーとして 5 表を参照する外部キーを外してから 1 表ずつ試し、最後に戻す。
SAVEPOINT ac62_truncate;
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT con.conname, con.conrelid::regclass AS rel
      FROM pg_constraint con
     WHERE con.contype = 'f'
       AND con.confrelid IN ('billing_test.tenant_product_subscriptions'::regclass,
                             'billing_test.tenant_product_entitlements'::regclass,
                             'billing_test.email_deliveries'::regclass,
                             'billing_test.products'::regclass,
                             'billing_test.product_plans'::regclass)
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', c.rel, c.conname);
  END LOOP;
END $$;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"role":"authenticated","tenant_id":"11111111-1111-1111-1111-111111111111"}', true);
DO $$
DECLARE
  t text;
  succeeded boolean;
  ok text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_product_subscriptions', 'tenant_product_entitlements',
                           'email_deliveries', 'products', 'product_plans'] LOOP
    succeeded := false;
    BEGIN
      EXECUTE format('TRUNCATE billing_test.%I', t);
      succeeded := true;
      RAISE EXCEPTION 'ac62-probe-rollback';
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    IF succeeded THEN
      ok := concat_ws(', ', ok, t);
    END IF;
  END LOOP;
  IF ok IS NOT NULL THEN
    RAISE EXCEPTION 'AC-62 [after-grant-all]: authenticated TRUNCATE succeeded on: %', ok;
  END IF;
  RAISE NOTICE 'AC-62 TRUNCATE check passed';
END $$;
RESET ROLE;
ROLLBACK TO SAVEPOINT ac62_truncate;
RELEASE SAVEPOINT ac62_truncate;

-- 9) AC-05: service_role は書ける（回帰）
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
DO $$
DECLARE
  n int;
BEGIN
  UPDATE billing_test.tenant_product_subscriptions
     SET plan_key = 'pro'
   WHERE tenant_id = '11111111-1111-1111-1111-111111111111';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'AC-05: service_role UPDATE affected % rows (expected 1)', n;
  END IF;
END $$;
RESET ROLE;

DO $$
BEGIN
  IF (SELECT plan_key FROM billing_test.tenant_product_subscriptions
       WHERE tenant_id = '11111111-1111-1111-1111-111111111111') IS DISTINCT FROM 'pro' THEN
    RAISE EXCEPTION 'AC-05: service_role UPDATE did not persist';
  END IF;
  RAISE NOTICE 'billing RLS test (AC-01..AC-12, AC-59, AC-62, AC-63) PASSED';
END $$;

SELECT set_config('request.jwt.claims', '', true);
RESET search_path;

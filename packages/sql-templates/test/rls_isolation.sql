-- RLS テナント分離の実地テスト（psql -v ON_ERROR_STOP=1 で実行）。
--
-- sql-templates が全テーブルで使う分離パターン
--   USING (tenant_id = current_tenant_id()) + WITH CHECK (同上) + FORCE RLS
-- が「越境SELECT」と「越境INSERT/UPDATE」を実際に止めるかを、非オーナーの
-- authenticated ロールで検証する。PR#8 で 003 のポリシー欠落(WITH CHECK 無し等)を
-- 塞いだ回帰を、DB レベルで固定する。
--
-- 失敗時は RAISE EXCEPTION で非ゼロ終了 → CI が落ちる。

BEGIN;

-- 現在テナントを GUC から返す関数（本番は JWT クレームから。ここはテスト用に GUC）
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
$$;

-- 非オーナー・非スーパーユーザーのアプリロール（RLS が実際に適用される対象）
DROP ROLE IF EXISTS app_authenticated;
CREATE ROLE app_authenticated NOLOGIN;

CREATE TABLE tenant_widgets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL,
  name       text NOT NULL
);
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_widgets TO app_authenticated;

-- ポリシー適用前にシード（オーナー権限で 2 テナント分）
INSERT INTO tenant_widgets (tenant_id, name) VALUES
  ('11111111-1111-1111-1111-111111111111', 'A-widget-1'),
  ('11111111-1111-1111-1111-111111111111', 'A-widget-2'),
  ('22222222-2222-2222-2222-222222222222', 'B-widget-1');

-- テンプレートと同じ分離ポリシー（USING と WITH CHECK の両方）＋ FORCE
ALTER TABLE tenant_widgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_widgets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_widgets_tenant ON tenant_widgets
  FOR ALL TO app_authenticated
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- ここから app_authenticated として、テナント A の文脈で検証
SET ROLE app_authenticated;
SET app.current_tenant_id = '11111111-1111-1111-1111-111111111111';

DO $$
DECLARE
  visible int;
BEGIN
  -- 1) USING: A は自分の 2 行だけ見える（B の 1 行は見えない）
  SELECT count(*) INTO visible FROM tenant_widgets;
  IF visible <> 2 THEN
    RAISE EXCEPTION 'RLS SELECT leak: tenant A sees % rows (expected 2)', visible;
  END IF;

  -- 2) USING: B の行は id 指定でも取得できない
  PERFORM 1 FROM tenant_widgets WHERE tenant_id = '22222222-2222-2222-2222-222222222222';
  IF FOUND THEN
    RAISE EXCEPTION 'RLS SELECT leak: tenant A can read tenant B rows';
  END IF;

  -- 3) WITH CHECK: A が B のテナントIDで INSERT しようとすると拒否される
  BEGIN
    INSERT INTO tenant_widgets (tenant_id, name)
      VALUES ('22222222-2222-2222-2222-222222222222', 'evil-cross-tenant');
    RAISE EXCEPTION 'RLS WITH CHECK bypass: cross-tenant INSERT succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL; -- 期待どおり拒否
  END;

  -- 4) WITH CHECK: 自テナントの INSERT は成功する
  INSERT INTO tenant_widgets (tenant_id, name)
    VALUES ('11111111-1111-1111-1111-111111111111', 'A-widget-3');

  -- 5) UPDATE で他テナントへ付け替えようとすると拒否される
  BEGIN
    UPDATE tenant_widgets
      SET tenant_id = '22222222-2222-2222-2222-222222222222'
      WHERE name = 'A-widget-1';
    RAISE EXCEPTION 'RLS WITH CHECK bypass: cross-tenant UPDATE succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL; -- 期待どおり拒否
  END;

  RAISE NOTICE 'RLS isolation test PASSED';
END $$;

RESET ROLE;
ROLLBACK;

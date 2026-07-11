-- ═══════════════════════════════════════════════════════════════════════
-- 再利用トリガー・RLS ヘルパー集（cross-SaaS reusable）
-- ═══════════════════════════════════════════════════════════════════════
-- 出典: dev-dashboard-v2/supabase/migrations/ の各テーブルに散在する
-- 汎用パターンを 1 ファイルに集約。テーブル名はすべて {{TABLE}} に汎用化。
--
-- 使い方: 必要なブロックだけをコピーし、{{TABLE}} を対象テーブル名に、
-- テナント列名（tenant_id / user_id）を自プロダクトの列に置換する。
-- PostgreSQL 14+ / RLS・auth.* は Supabase 前提の記述。
-- ═══════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────
-- 1) updated_at 自動更新トリガー
-- ───────────────────────────────────────────────────────────────────────
-- 関数はプロジェクト全体で 1 つだけ定義すれば全テーブルで使い回せる。
-- CREATE OR REPLACE なので複数マイグレーションから重複実行しても安全。
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 各テーブルに BEFORE UPDATE トリガーを 1 本ずつ張る（{{TABLE}} を置換）。
-- 前提: 対象テーブルに `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()` 列があること。
DROP TRIGGER IF EXISTS trg_{{TABLE}}_updated_at ON {{TABLE}};
CREATE TRIGGER trg_{{TABLE}}_updated_at
  BEFORE UPDATE ON {{TABLE}}
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ───────────────────────────────────────────────────────────────────────
-- 2) ソフトデリート（deleted_at 列 + 除外ビュー）
-- ───────────────────────────────────────────────────────────────────────
-- 物理削除の代わりに deleted_at を立てる。GDPR の soft delete 用途にも使える。
ALTER TABLE {{TABLE}} ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- 「生きている行」だけ効率よく引くための部分インデックス（NULL 側は載せない）。
CREATE INDEX IF NOT EXISTS idx_{{TABLE}}_deleted_at
  ON {{TABLE}}(deleted_at) WHERE deleted_at IS NOT NULL;

-- ソフトデリート済みを除外するビュー。アプリ側は原則このビューを参照する。
-- （素のテーブルは管理オペレーション／復元用にだけ触る運用が安全）
CREATE OR REPLACE VIEW vw_{{TABLE}}_active AS
  SELECT * FROM {{TABLE}} WHERE deleted_at IS NULL;

-- ビューではなく RLS で除外したい場合（既存ポリシーの USING に AND で足す）:
--   USING (deleted_at IS NULL AND <tenant 条件>)


-- ───────────────────────────────────────────────────────────────────────
-- 3-a) テナント分離 RLS（tenant_id を GUC から判定するパターン）
-- ───────────────────────────────────────────────────────────────────────
-- API がリクエストごとに `SET app.current_tenant_id = '<uuid>'` を実行する構成。
-- tenant_id は uuid、GUC は text なので ::text で比較する。
ALTER TABLE {{TABLE}} ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS {{TABLE}}_tenant_isolation ON {{TABLE}};
CREATE POLICY {{TABLE}}_tenant_isolation ON {{TABLE}}
  FOR ALL
  USING      (tenant_id::text = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.current_tenant_id', true));

-- 集計用に service_role へ全行 SELECT を開ける場合（任意）:
-- DROP POLICY IF EXISTS {{TABLE}}_service_read ON {{TABLE}};
-- CREATE POLICY {{TABLE}}_service_read ON {{TABLE}}
--   FOR SELECT TO service_role USING (true);


-- ───────────────────────────────────────────────────────────────────────
-- 3-b) ユーザー分離 RLS（Supabase ネイティブ auth.uid() パターン）
-- ───────────────────────────────────────────────────────────────────────
-- authenticated ロールが直接テーブルを触る構成向け。行の所有者を user_id で判定。
-- 前提: user_id が Supabase auth のユーザー UUID（auth.uid() と同型）。
ALTER TABLE {{TABLE}} ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS {{TABLE}}_user_isolation ON {{TABLE}};
CREATE POLICY {{TABLE}}_user_isolation ON {{TABLE}}
  FOR ALL
  USING (auth.uid() = user_id);


-- ───────────────────────────────────────────────────────────────────────
-- 3-c) ユーザー分離 RLS（JWT クレーム email + service_role フォールバック）
-- ───────────────────────────────────────────────────────────────────────
-- 所有者をメールアドレス（TEXT）で持ち、API は service_role で全操作する構成。
ALTER TABLE {{TABLE}} ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS {{TABLE}}_user_isolation ON {{TABLE}};
CREATE POLICY {{TABLE}}_user_isolation ON {{TABLE}}
  FOR ALL
  USING (
    user_id = current_setting('request.jwt.claim.email', true)
    OR current_setting('role', true) = 'service_role'
  )
  WITH CHECK (
    user_id = current_setting('request.jwt.claim.email', true)
    OR current_setting('role', true) = 'service_role'
  );

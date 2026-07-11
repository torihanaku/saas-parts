-- Audit hash chain — 監査ログの改ざん検知（各行が直前行のハッシュを保持するチェーン構造）
-- Prerequisite: audit_log テーブルが存在し、tenant_id 列を持つこと（002 参照）。
ALTER TABLE audit_log
  ADD COLUMN prev_hash BYTEA,
  ADD COLUMN entry_hash BYTEA,
  ADD COLUMN actor_type TEXT,
  ADD COLUMN approval_hash BYTEA,
  ADD COLUMN exec_hash BYTEA;

CREATE UNIQUE INDEX audit_chain_unique ON audit_log (tenant_id, entry_hash);
REVOKE UPDATE, DELETE ON audit_log FROM PUBLIC;

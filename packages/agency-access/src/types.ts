/**
 * Agency mode — 型定義
 * 移植元: dev-dashboard-v2 shared/types/agency.ts (#774 A-1 Foundation)
 *
 * 設計決定 (元プロジェクトの OQ 決定事項):
 *   - 3層 role (agency_admin / agency_member / client_viewer)
 *   - 収益・P&L は内製せず DataSourceConnector で外部接続 (pluggable)
 *   - 監査ログは risk_level 付きで長期アーカイブ前提 (archived_to_gcs フラグ)
 */

// ─── Tenant ────────────────────────────────────────────────────────────────

export type TenantType = "direct" | "agency";

export interface AgencyTenant {
  id: string;
  name: string;
  type: TenantType;
  /** agency tenant のみ使用。 direct では常に空配列 */
  managed_clients: string[];
  created_at: string;
}

// ─── Role (3 層) ───────────────────────────────────────────────────────────

/** direct tenant 用の既存 role */
export type DirectRole = "admin" | "editor" | "viewer" | "member";

/** agency tenant 用の 3 層 role */
export type AgencyRole = "agency_admin" | "agency_member" | "client_viewer";

/** 全 role の union (team members テーブルの role CHECK 制約と一致) */
export type TeamMemberRole = DirectRole | AgencyRole;

// ─── Audit log ─────────────────────────────────────────────────────────────

export type AuditRiskLevel = "low" | "medium" | "high" | "critical";

export interface AuditLogEntry {
  id: string;
  tenant_id: string;
  user_email: string;
  user_role: TeamMemberRole;
  action: string;
  resource_type: string;
  resource_id: string | null;
  changes: Record<string, unknown> | null;
  ip_address: string | null;
  actor_type: "human" | "ai" | "system";
  risk_level: AuditRiskLevel;
  archived_to_gcs: boolean;
  gcs_archive_path: string | null;
  occurred_at: string;
}

// ─── Data source connector (pluggable 先置き) ───────────────────────────────

/**
 * 収益・P&L 等の外部 KPI を pluggable で取り込むためのインターフェース先置き。
 * 実装原則: ホストアプリは値を内製しない。 利用者が自分で接続する。
 */
export type DataSourceKind =
  | "bigquery"
  | "google_sheets"
  | "csv"
  | "excel"
  | "placeholder";

export interface DataSourceConnectorPlaceholder {
  kind: DataSourceKind;
  /** 利用者側の参照 (BigQuery dataset、 Sheet URL 等)。 値の中身はホスト側では保存しない */
  reference: string;
  /** 直近の接続検証時刻 (ISO8601)。 未実装時は null */
  last_validated_at: string | null;
}

// ─── Helper guards ─────────────────────────────────────────────────────────

export function isAgencyRole(role: string): role is AgencyRole {
  return role === "agency_admin" || role === "agency_member" || role === "client_viewer";
}

export function isDirectRole(role: string): role is DirectRole {
  return role === "admin" || role === "editor" || role === "viewer" || role === "member";
}

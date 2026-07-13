/**
 * @torihanaku/white-label-branding — テナント別ブランディング設定 + パートナー関係管理
 *
 * テナント単位の white label 設定 (ロゴ / 色 / ブランド名 / ドメイン) の CRUD と、
 * partner ↔ client 関係の管理・認可ヘルパー。
 *
 * 出典: 実運用SaaS server/lib/white-label.ts (#346 Foundation)。
 * 移植方針:
 * - DB アクセス (supabaseGet/Insert/Patch + PostgREST クエリ文字列) は
 *   セマンティックな `WhiteLabelStore` の注入に置換。
 * - ロジック (upsert 判定・認可・エラー時 null/false) は原文どおり (port; not rewrite)。
 * - ロゴ等のアセットアップロードは @torihanaku/storage-upload 対応 (README 参照、import なし)。
 */

export * from "./types";

import type {
  WhiteLabelConfig,
  WhiteLabelConfigUpdate,
  PartnerRelationship,
} from "./types";

/** upsert / insert の結果 (原文の supabaseInsert/Patch 戻り値相当)。 */
export interface WriteResult {
  ok: boolean;
  error?: string;
}

/**
 * white label / partner 関係の永続化ストア (注入式)。
 * 実運用SaaS では Supabase (`dd_white_label_configs` / `dd_partner_relationships`)。
 */
export interface WhiteLabelStore {
  /** tenant の white label 設定を 1 件返す (無ければ null)。 */
  getConfig(tenantId: string): Promise<WhiteLabelConfig | null>;
  /** 新規 config を挿入する。 */
  insertConfig(
    tenantId: string,
    config: Required<Omit<WhiteLabelConfig, "tenant_id" | "created_at" | "updated_at">>,
  ): Promise<WriteResult>;
  /** 既存 config を差分更新する。 */
  patchConfig(tenantId: string, patch: WhiteLabelConfigUpdate): Promise<WriteResult>;
  /** (partner, client) の active 関係が存在するか。 */
  hasActiveRelationship(partnerId: string, clientId: string): Promise<boolean>;
  /** partner が抱える client 関係一覧 (status 未指定なら全件)。 */
  listRelationships(
    partnerId: string,
    status?: string,
  ): Promise<Array<Record<string, unknown>>>;
  /** partner-client 関係を新規作成する。 */
  insertRelationship(
    relationship: Pick<
      PartnerRelationship,
      "partner_tenant_id" | "client_tenant_id" | "plan_tier" | "reseller_pricing_jpy" | "status"
    >,
  ): Promise<WriteResult>;
}

/** ブランディング管理を組み立てる。store を注入して生成する。 */
export function createWhiteLabelBranding(store: WhiteLabelStore) {
  /**
   * tenant の white label 設定を取得。無ければ null (caller 側で fallback brand を当てる)。
   */
  async function getWhiteLabelConfig(tenantId: string): Promise<WhiteLabelConfig | null> {
    if (!tenantId) return null;
    try {
      return await store.getConfig(tenantId);
    } catch (e) {
      console.error("[white-label] getWhiteLabelConfig error:", e);
      return null;
    }
  }

  /**
   * white label 設定を upsert。既存があれば patch、無ければ insert。
   * 戻り値は最新の設定行 (失敗時 null)。
   */
  async function upsertWhiteLabelConfig(
    tenantId: string,
    patch: WhiteLabelConfigUpdate,
  ): Promise<WhiteLabelConfig | null> {
    if (!tenantId) return null;
    const existing = await getWhiteLabelConfig(tenantId);
    if (existing) {
      const result = await store.patchConfig(tenantId, patch);
      if (!result.ok) {
        console.error("[white-label] upsertWhiteLabelConfig PATCH error:", result.error);
        return null;
      }
    } else {
      const result = await store.insertConfig(tenantId, {
        brand_name: patch.brand_name ?? "",
        logo_url: patch.logo_url ?? null,
        primary_color: patch.primary_color ?? null,
        favicon_url: patch.favicon_url ?? null,
        custom_domain: patch.custom_domain ?? null,
        custom_email_from: patch.custom_email_from ?? null,
        footer_html: patch.footer_html ?? null,
      });
      if (!result.ok) {
        console.error("[white-label] upsertWhiteLabelConfig INSERT error:", result.error);
        return null;
      }
    }
    return getWhiteLabelConfig(tenantId);
  }

  /**
   * partner が client を active relationship で保有しているか判定する認可ヘルパー。
   * suspended / churned は false。同一 id (partner==client) も false。
   */
  async function assertPartnerOwnsClient(
    partnerId: string,
    clientId: string,
  ): Promise<boolean> {
    if (!partnerId || !clientId || partnerId === clientId) return false;
    try {
      return await store.hasActiveRelationship(partnerId, clientId);
    } catch (e) {
      console.error("[white-label] assertPartnerOwnsClient error:", e);
      return false;
    }
  }

  /** partner が抱える全 client relationship を一覧取得する。 */
  async function listPartnerClients(
    partnerId: string,
    options: { status?: string; throwOnError?: boolean } = {},
  ): Promise<Array<Record<string, unknown>>> {
    if (!partnerId) return [];
    try {
      return await store.listRelationships(partnerId, options.status);
    } catch (e) {
      console.error("[white-label] listPartnerClients error:", e);
      if (options.throwOnError) throw e;
      return [];
    }
  }

  /** partner-client relationship を新規作成する。重複 (PK 違反) 等は false。 */
  async function createPartnerRelationship(
    partnerId: string,
    clientId: string,
    options: {
      plan_tier?: string;
      reseller_pricing_jpy?: number | null;
      status?: string;
    } = {},
  ): Promise<boolean> {
    if (!partnerId || !clientId || partnerId === clientId) return false;
    try {
      const result = await store.insertRelationship({
        partner_tenant_id: partnerId,
        client_tenant_id: clientId,
        plan_tier: (options.plan_tier ?? "starter") as PartnerRelationship["plan_tier"],
        reseller_pricing_jpy: options.reseller_pricing_jpy ?? null,
        status: (options.status ?? "active") as PartnerRelationship["status"],
      });
      return result.ok;
    } catch (e) {
      console.error("[white-label] createPartnerRelationship error:", e);
      return false;
    }
  }

  return {
    getWhiteLabelConfig,
    upsertWhiteLabelConfig,
    assertPartnerOwnsClient,
    listPartnerClients,
    createPartnerRelationship,
  };
}

export type WhiteLabelBranding = ReturnType<typeof createWhiteLabelBranding>;

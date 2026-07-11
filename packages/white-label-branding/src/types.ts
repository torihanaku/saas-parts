/**
 * @torihanaku/white-label-branding — 型 + バリデータ
 * 出典: dev-dashboard-v2 shared/types/white-label.ts (#346)。
 */

export type PartnerPlanTier = "starter" | "growth" | "enterprise";

export const PARTNER_PLAN_TIERS: readonly PartnerPlanTier[] = [
  "starter",
  "growth",
  "enterprise",
] as const;

export function isPartnerPlanTier(value: string): value is PartnerPlanTier {
  return (PARTNER_PLAN_TIERS as readonly string[]).includes(value);
}

export type PartnerRelationshipStatus = "active" | "suspended" | "churned";

export const PARTNER_RELATIONSHIP_STATUSES: readonly PartnerRelationshipStatus[] = [
  "active",
  "suspended",
  "churned",
] as const;

export function isPartnerRelationshipStatus(value: string): value is PartnerRelationshipStatus {
  return (PARTNER_RELATIONSHIP_STATUSES as readonly string[]).includes(value);
}

/** tenant 単位の white label 設定 (ロゴ / 色 / ブランド名 / ドメイン等)。 */
export interface WhiteLabelConfig {
  tenant_id: string;
  brand_name: string;
  logo_url: string | null;
  primary_color: string | null;
  favicon_url: string | null;
  custom_domain: string | null;
  custom_email_from: string | null;
  footer_html: string | null;
  created_at: string;
  updated_at: string;
}

/** 差分 update の入力型 (全フィールド optional)。 */
export interface WhiteLabelConfigUpdate {
  brand_name?: string;
  logo_url?: string | null;
  primary_color?: string | null;
  favicon_url?: string | null;
  custom_domain?: string | null;
  custom_email_from?: string | null;
  footer_html?: string | null;
}

export interface PartnerRelationship {
  partner_tenant_id: string;
  client_tenant_id: string;
  plan_tier: PartnerPlanTier;
  reseller_pricing_jpy: number | null;
  started_at: string;
  status: PartnerRelationshipStatus;
  created_at: string;
  updated_at: string;
}

export interface CreatePartnerClientRequest {
  client_tenant_id: string;
  plan_tier?: PartnerPlanTier;
  reseller_pricing_jpy?: number | null;
  status?: PartnerRelationshipStatus;
}

/** white label config の差分 update 入力を検証する。 */
export function validateWhiteLabelConfigUpdate(
  input: unknown,
): { ok: true; value: WhiteLabelConfigUpdate } | { ok: false; error: string } {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "body must be an object" };
  }
  const obj = input as Record<string, unknown>;
  const out: WhiteLabelConfigUpdate = {};
  const stringOrNullKeys = [
    "logo_url",
    "primary_color",
    "favicon_url",
    "custom_domain",
    "custom_email_from",
    "footer_html",
  ] as const;

  if ("brand_name" in obj) {
    if (typeof obj.brand_name !== "string") {
      return { ok: false, error: "brand_name must be a string" };
    }
    if (obj.brand_name.length > 200) {
      return { ok: false, error: "brand_name must be ≤200 chars" };
    }
    out.brand_name = obj.brand_name;
  }

  for (const key of stringOrNullKeys) {
    if (key in obj) {
      const v = obj[key];
      if (v !== null && typeof v !== "string") {
        return { ok: false, error: `${key} must be a string or null` };
      }
      if (typeof v === "string" && v.length > 4000) {
        return { ok: false, error: `${key} must be ≤4000 chars` };
      }
      (out as Record<string, unknown>)[key] = v;
    }
  }

  return { ok: true, value: out };
}

/** POST /api/partner/clients の body を検証する。 */
export function validateCreatePartnerClient(
  input: unknown,
): { ok: true; value: CreatePartnerClientRequest } | { ok: false; error: string } {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "body must be an object" };
  }
  const obj = input as Record<string, unknown>;

  if (typeof obj.client_tenant_id !== "string" || obj.client_tenant_id.length === 0) {
    return { ok: false, error: "client_tenant_id is required" };
  }

  const out: CreatePartnerClientRequest = { client_tenant_id: obj.client_tenant_id };

  if ("plan_tier" in obj) {
    if (typeof obj.plan_tier !== "string" || !isPartnerPlanTier(obj.plan_tier)) {
      return { ok: false, error: `plan_tier must be one of: ${PARTNER_PLAN_TIERS.join(", ")}` };
    }
    out.plan_tier = obj.plan_tier;
  }

  if ("reseller_pricing_jpy" in obj) {
    const v = obj.reseller_pricing_jpy;
    if (
      v !== null &&
      (typeof v !== "number" || !Number.isFinite(v) || v < 0 || !Number.isInteger(v))
    ) {
      return { ok: false, error: "reseller_pricing_jpy must be a non-negative integer or null" };
    }
    out.reseller_pricing_jpy = v as number | null;
  }

  if ("status" in obj) {
    if (typeof obj.status !== "string" || !isPartnerRelationshipStatus(obj.status)) {
      return {
        ok: false,
        error: `status must be one of: ${PARTNER_RELATIONSHIP_STATUSES.join(", ")}`,
      };
    }
    out.status = obj.status;
  }

  return { ok: true, value: out };
}

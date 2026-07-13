/**
 * @torihanaku/white-label-branding — 型 + バリデータ
 * 出典: 実運用SaaS shared/types/white-label.ts (#346)。
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

/**
 * ブランディングフィールドの injection バリデータ。
 *
 * これらの値は white-label ページで **エンドユーザーに描画される** (ロゴ/favicon の
 * `src`/`href`、`primary_color` のインライン style、`footer_html` の HTML)。原文
 * (実運用SaaS) は「文字列 + 長さ上限」しか検査しておらず、`javascript:` URL /
 * `data:text/html` / CSS ブレイク / `<script>` がそのまま保存され stored XSS になりうる。
 * 汎用部品として、危険な値を保存前に弾く。
 */

/** URL フィールド (logo_url / favicon_url)。http(s) か root-relative path のみ許可。 */
function checkUrlField(key: string, v: string): string | null {
  // ルート相対パス (/logo.png) は許可。プロトコル相対 (//host) は不許可。
  if (v.startsWith("/") && !v.startsWith("//")) return null;
  let parsed: URL;
  try {
    parsed = new URL(v);
  } catch {
    return `${key} must be an absolute http(s) URL or a root-relative path`;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return `${key} must use http(s) (got ${parsed.protocol})`;
  }
  return null;
}

/** CSS カラー。hex / rgb(a) / hsl(a) / 単純な CSS ident のみ。区切り・関数注入は不許可。 */
const COLOR_RE =
  /^(#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|rgba?\([0-9.,\s%]+\)|hsla?\([0-9.,\s%]+\)|[a-zA-Z]{1,32})$/;
function checkColorField(v: string): string | null {
  if (!COLOR_RE.test(v)) {
    return "primary_color must be a hex / rgb(a) / hsl(a) color or a plain color keyword";
  }
  return null;
}

/** ドメイン。scheme/path/空白/山括弧なしのホスト名のみ。 */
const DOMAIN_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,62})(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,62}))*(:[0-9]{1,5})?$/;
function checkDomainField(v: string): string | null {
  if (!DOMAIN_RE.test(v)) {
    return "custom_domain must be a bare hostname (no scheme, path, or whitespace)";
  }
  return null;
}

/** email-from。改行 (header injection) と山括弧を弾く。 */
function checkEmailFromField(v: string): string | null {
  if (/[\r\n]/.test(v)) return "custom_email_from must not contain newlines";
  return null;
}

/** footer HTML。最も危険な構文 (script / on*= / javascript:) を弾く。host 側で更にサニタイズ推奨。 */
function checkFooterHtml(v: string): string | null {
  const lower = v.toLowerCase();
  if (/<\s*script/.test(lower) || /<\s*\/\s*script/.test(lower)) {
    return "footer_html must not contain <script> tags";
  }
  if (/<\s*(iframe|object|embed|form|meta|link|base)\b/.test(lower)) {
    return "footer_html must not contain active/embedding tags";
  }
  if (/\son\w+\s*=/.test(lower)) {
    return "footer_html must not contain inline event handlers (on*=)";
  }
  if (/(javascript|vbscript|data)\s*:/.test(lower)) {
    return "footer_html must not contain javascript:/vbscript:/data: URIs";
  }
  return null;
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
      // injection ガード (非空文字列のみ)。null / "" はクリア扱いで通す。
      if (typeof v === "string" && v.length > 0) {
        let err: string | null = null;
        if (key === "logo_url" || key === "favicon_url") err = checkUrlField(key, v);
        else if (key === "primary_color") err = checkColorField(v);
        else if (key === "custom_domain") err = checkDomainField(v);
        else if (key === "custom_email_from") err = checkEmailFromField(v);
        else if (key === "footer_html") err = checkFooterHtml(v);
        if (err) return { ok: false, error: err };
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

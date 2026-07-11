/**
 * テナント設定 / メール取り込み設定サービス
 * （元: server/routes/cos/settings.ts + email-settings.ts のロジック部。
 *   HTTP 配線・role ゲートは落とした — 認可は呼び出し側の責務）。
 *
 * バリデーション（HH:MM 形式・フィルタルール上限 20・lookback 1〜168h 等）を
 * ここに集約し、Store には正規化済みの値だけが渡る。
 */
import type { CosEmailSettings, CosTenantSettings, EmailFilterRule, EmailIntegration } from "./types";
import type { EmailSettingsStore, TenantSettingsStore } from "./stores";

// ─── テナント設定 ─────────────────────────────────────────────────────────────

export interface TenantSettingsPatch {
  slackChannels?: unknown;
  emailFilterRules?: unknown;
  meetingSources?: unknown;
  dailyBriefingEnabled?: unknown;
  dailyBriefingTime?: unknown;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === "string");
}

export type TenantSettingsValidPatch = Partial<
  Pick<
    CosTenantSettings,
    | "slackChannels"
    | "emailFilterRules"
    | "meetingSources"
    | "dailyBriefingEnabled"
    | "dailyBriefingTime"
  >
>;

/**
 * 未知の入力 patch を検証し、有効なフィールドだけを残す。
 * 1 つも有効フィールドが無ければ null（呼び出し側は 400 相当にする）。
 */
export function buildTenantSettingsPatch(
  body: TenantSettingsPatch,
): TenantSettingsValidPatch | null {
  const patch: TenantSettingsValidPatch = {};
  if (isStringArray(body.slackChannels)) patch.slackChannels = body.slackChannels;
  if (Array.isArray(body.emailFilterRules)) patch.emailFilterRules = body.emailFilterRules;
  if (isStringArray(body.meetingSources)) patch.meetingSources = body.meetingSources;
  if (typeof body.dailyBriefingEnabled === "boolean") {
    patch.dailyBriefingEnabled = body.dailyBriefingEnabled;
  }
  if (
    typeof body.dailyBriefingTime === "string" &&
    TIME_RE.test(body.dailyBriefingTime)
  ) {
    patch.dailyBriefingTime = body.dailyBriefingTime;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

export class TenantSettingsService {
  private readonly store: TenantSettingsStore;

  constructor(deps: { store: TenantSettingsStore }) {
    this.store = deps.store;
  }

  async get(tenantId: string): Promise<CosTenantSettings | null> {
    return this.store.get(tenantId);
  }

  /**
   * upsert。owner_user_id は初回作成時に呼び出しユーザーで固定される
   * （consent チェックの対象になる）。
   */
  async update(
    tenantId: string,
    callerUserId: string,
    body: TenantSettingsPatch,
  ): Promise<
    | { ok: true; settings: CosTenantSettings }
    | { ok: false; error: "no_valid_fields" | "update_failed" }
  > {
    const patch = buildTenantSettingsPatch(body);
    if (!patch) return { ok: false, error: "no_valid_fields" };
    const settings = await this.store.upsert(tenantId, callerUserId, patch);
    if (!settings) return { ok: false, error: "update_failed" };
    return { ok: true, settings };
  }
}

// ─── メール取り込み設定 ───────────────────────────────────────────────────────

const ALLOWED_INTEGRATIONS = ["google-mail", "outlook"] as const;
const MAX_FILTER_RULES = 20;
const MAX_RULE_FIELD_LENGTH = 200;

export function isValidFilterRule(r: unknown): r is EmailFilterRule {
  if (!r || typeof r !== "object") return false;
  const obj = r as Record<string, unknown>;
  const okStr = (v: unknown) =>
    v === undefined || (typeof v === "string" && v.length <= MAX_RULE_FIELD_LENGTH);
  if (!okStr(obj.fromDomain) || !okStr(obj.subjectContains) || !okStr(obj.labelIncludes)) {
    return false;
  }
  return !!(obj.fromDomain || obj.subjectContains || obj.labelIncludes);
}

/** ルール配列を正規化。不正なら null（400 相当）。上限 20 件。 */
export function normalizeFilterRules(input: unknown): EmailFilterRule[] | null {
  if (!Array.isArray(input)) return null;
  if (input.length > MAX_FILTER_RULES) return null;
  const out: EmailFilterRule[] = [];
  for (const r of input) {
    if (!isValidFilterRule(r)) return null;
    out.push({
      fromDomain: r.fromDomain,
      subjectContains: r.subjectContains,
      labelIncludes: r.labelIncludes,
    });
  }
  return out;
}

export interface EmailSettingsPatch {
  integration?: string;
  connectionId?: string | null;
  enabled?: boolean;
  filterRules?: unknown;
  lookbackHours?: number;
}

/** 未設定テナントに返すデフォルト形（UI が空フォームを描画できる） */
export function defaultEmailSettings(tenantId: string): CosEmailSettings {
  return {
    tenantId,
    integration: "google-mail",
    connectionId: null,
    enabled: false,
    filterRules: [],
    lookbackHours: 24,
    lastRunAt: null,
  };
}

export class EmailSettingsService {
  private readonly store: EmailSettingsStore;

  constructor(deps: { store: EmailSettingsStore }) {
    this.store = deps.store;
  }

  async get(tenantId: string): Promise<CosEmailSettings> {
    return (await this.store.get(tenantId)) ?? defaultEmailSettings(tenantId);
  }

  async update(
    tenantId: string,
    body: EmailSettingsPatch,
  ): Promise<
    | { ok: true; settings: CosEmailSettings }
    | { ok: false; error: "invalid_filter_rules" | "update_failed" }
  > {
    const integration: EmailIntegration = (
      ALLOWED_INTEGRATIONS as readonly string[]
    ).includes(body.integration ?? "")
      ? (body.integration as EmailIntegration)
      : "google-mail";

    const filterRules =
      body.filterRules !== undefined ? normalizeFilterRules(body.filterRules) : [];
    if (filterRules === null) return { ok: false, error: "invalid_filter_rules" };

    const lookbackHours = Number.isFinite(body.lookbackHours)
      ? Math.max(1, Math.min(168, Math.floor(body.lookbackHours as number)))
      : 24;

    const enabled = body.enabled === true;
    const connectionId =
      typeof body.connectionId === "string" && body.connectionId.length > 0
        ? body.connectionId
        : null;

    const settings = await this.store.upsert(tenantId, {
      integration,
      connectionId,
      enabled,
      filterRules,
      lookbackHours,
    });
    if (!settings) return { ok: false, error: "update_failed" };
    return { ok: true, settings };
  }
}

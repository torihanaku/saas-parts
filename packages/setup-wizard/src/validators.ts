/**
 * Per-service credential validators.
 * Ported from dev-dashboard-v2 `server/lib/setup-validators.ts`.
 *
 * Network validators accept an injectable fetch (default globalThis.fetch) so
 * connectivity checks are testable without real HTTP. Format-only validators
 * (nango / slack / stripe) are pure.
 */

export type ServiceName = "anthropic" | "supabase" | "github" | "nango" | "slack" | "stripe";

export interface ValidateResult {
  valid: boolean;
  service: ServiceName;
  message: string;
}

/** Minimal fetch shape used by the network validators. */
export type FetchLike = (
  input: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number }>;

const defaultFetch: FetchLike = (input, init) =>
  (globalThis.fetch as unknown as FetchLike)(input, init);

const TIMEOUT_MS = 8000;

export async function validateAnthropic(
  creds: Record<string, string>,
  fetchImpl: FetchLike = defaultFetch,
): Promise<ValidateResult> {
  const key = creds["ANTHROPIC_API_KEY"];
  if (!key) return { valid: false, service: "anthropic", message: "ANTHROPIC_API_KEY が指定されていません" };

  try {
    const res = await fetchImpl("https://api.anthropic.com/v1/models", {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) return { valid: true, service: "anthropic", message: "接続確認済み" };
    return { valid: false, service: "anthropic", message: `認証失敗 (HTTP ${res.status})` };
  } catch (e) {
    return { valid: false, service: "anthropic", message: `接続エラー: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function validateSupabase(
  creds: Record<string, string>,
  fetchImpl: FetchLike = defaultFetch,
): Promise<ValidateResult> {
  const url = creds["SUPABASE_URL"];
  const key = creds["SUPABASE_SERVICE_ROLE_KEY"];
  if (!url) return { valid: false, service: "supabase", message: "SUPABASE_URL が指定されていません" };
  if (!key) return { valid: false, service: "supabase", message: "SUPABASE_SERVICE_ROLE_KEY が指定されていません" };

  try {
    const res = await fetchImpl(`${url}/rest/v1/`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // Supabase REST root returns 200 or 406 — both indicate reachability.
    if (res.ok || res.status === 406) return { valid: true, service: "supabase", message: "接続確認済み" };
    return { valid: false, service: "supabase", message: `認証失敗 (HTTP ${res.status})` };
  } catch (e) {
    return { valid: false, service: "supabase", message: `接続エラー: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function validateGitHub(
  creds: Record<string, string>,
  fetchImpl: FetchLike = defaultFetch,
): Promise<ValidateResult> {
  const token = creds["GH_TOKEN"];
  if (!token) return { valid: false, service: "github", message: "GH_TOKEN が指定されていません" };

  try {
    const res = await fetchImpl("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": "dev-dashboard" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) return { valid: true, service: "github", message: "接続確認済み" };
    return { valid: false, service: "github", message: `認証失敗 (HTTP ${res.status})` };
  } catch (e) {
    return { valid: false, service: "github", message: `接続エラー: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export function validateNango(creds: Record<string, string>): ValidateResult {
  const key = creds["NANGO_SECRET_KEY"];
  if (!key) return { valid: false, service: "nango", message: "NANGO_SECRET_KEY が指定されていません" };
  // Format check only — Nango keys have no public testable endpoint without a project.
  if (key.length < 20) {
    return { valid: false, service: "nango", message: "キー形式が不正です (20文字以上必要)" };
  }
  return { valid: true, service: "nango", message: "形式確認済み (接続テストはNangoダッシュボードで実施してください)" };
}

export function validateSlack(creds: Record<string, string>): ValidateResult {
  const botToken = creds["SLACK_BOT_TOKEN"];
  const signingSecret = creds["SLACK_SIGNING_SECRET"];
  if (!botToken) return { valid: false, service: "slack", message: "SLACK_BOT_TOKEN が指定されていません" };
  if (!signingSecret) return { valid: false, service: "slack", message: "SLACK_SIGNING_SECRET が指定されていません" };
  if (!botToken.startsWith("xoxb-")) {
    return { valid: false, service: "slack", message: "SLACK_BOT_TOKEN の形式が不正です (xoxb- で始まる必要があります)" };
  }
  return { valid: true, service: "slack", message: "形式確認済み" };
}

export function validateStripe(creds: Record<string, string>): ValidateResult {
  const key = creds["STRIPE_SECRET_KEY"];
  if (!key) return { valid: false, service: "stripe", message: "STRIPE_SECRET_KEY が指定されていません" };
  if (!key.startsWith("sk_live_") && !key.startsWith("sk_test_")) {
    return { valid: false, service: "stripe", message: "STRIPE_SECRET_KEY の形式が不正です (sk_live_ または sk_test_ で始まる必要があります)" };
  }
  return { valid: true, service: "stripe", message: "形式確認済み" };
}

export const VALID_SERVICE_NAMES: ServiceName[] = [
  "anthropic",
  "supabase",
  "github",
  "nango",
  "slack",
  "stripe",
];

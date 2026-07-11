/**
 * Setup step definitions (config-driven) + status computation.
 * Ported from dev-dashboard-v2 `server/routes/setup-wizard.ts`.
 */

export interface SetupStepTemplate {
  key: string;
  label: string;
  required: boolean;
  env_vars: string[];
}

export interface SetupStep extends SetupStepTemplate {
  configured: boolean;
}

/** Default onboarding steps (ported verbatim). Override via SetupWizard options. */
export const DEFAULT_SETUP_STEPS: SetupStepTemplate[] = [
  { key: "database", label: "データベース (Supabase)", required: true, env_vars: ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] },
  { key: "ai", label: "AI (Claude API)", required: true, env_vars: ["ANTHROPIC_API_KEY"] },
  { key: "github", label: "GitHub", required: false, env_vars: ["GH_TOKEN"] },
  { key: "nango", label: "Nango 連携", required: false, env_vars: ["NANGO_SECRET_KEY"] },
  { key: "slack", label: "Slack", required: false, env_vars: ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"] },
  { key: "billing", label: "Stripe 課金", required: false, env_vars: ["STRIPE_SECRET_KEY"] },
];

export interface SetupStatus {
  setup_complete: boolean;
  required_complete: boolean;
  steps: SetupStep[];
  completion_percentage: number;
}

/**
 * A config resolver reports whether a given config key is set. This replaces
 * the original `getOptionalEnv(k)` / BYOK tenant-secret lookups (no process.env
 * inside the package).
 */
export type ConfigResolver = (key: string) => boolean | Promise<boolean>;

/**
 * Computes setup status from step templates + a config resolver.
 * The "ai" step is configured if ANTHROPIC_API_KEY resolves true (the resolver
 * is where the host folds in BYOK tenant-secret lookups).
 */
export async function computeStatus(
  steps: SetupStepTemplate[],
  isConfigured: ConfigResolver,
): Promise<SetupStatus> {
  const resolved: SetupStep[] = [];
  for (const step of steps) {
    const flags = await Promise.all(step.env_vars.map((k) => Promise.resolve(isConfigured(k))));
    resolved.push({ ...step, configured: flags.every(Boolean) });
  }

  const totalSteps = resolved.length;
  const configuredCount = resolved.filter((s) => s.configured).length;
  const requiredSteps = resolved.filter((s) => s.required);
  const required_complete = requiredSteps.every((s) => s.configured);
  const setup_complete = resolved.every((s) => s.configured);
  const completion_percentage = totalSteps > 0 ? Math.round((configuredCount / totalSteps) * 100) : 0;

  return { setup_complete, required_complete, steps: resolved, completion_percentage };
}

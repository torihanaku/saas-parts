/**
 * Setup wizard orchestrator — status, validate (service registry), checklist.
 * Ported from 実運用SaaS `server/routes/setup-wizard.ts`.
 *
 * HTTP/auth (admin-only requireRole) stays in the host. This exposes the port
 * logic; `validate()` returns { status, result } so the caller maps to 200/422.
 */
import {
  DEFAULT_SETUP_STEPS,
  computeStatus,
  type ConfigResolver,
  type SetupStatus,
  type SetupStepTemplate,
} from "./steps";
import {
  VALID_SERVICE_NAMES,
  validateAnthropic,
  validateGitHub,
  validateNango,
  validateSlack,
  validateStripe,
  validateSupabase,
  type FetchLike,
  type ServiceName,
  type ValidateResult,
} from "./validators";
import {
  computeChecklist,
  type ChecklistDataProvider,
  type ChecklistResult,
} from "./checklist";

export type ServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string };

function fail(status: number, error: string): { ok: false; status: number; error: string } {
  return { ok: false, status, error };
}
function ok<T>(data: T): { ok: true; data: T } {
  return { ok: true, data };
}

/** A validator function in the registry. */
export type ServiceValidator = (creds: Record<string, string>) => Promise<ValidateResult> | ValidateResult;

export interface SetupWizardOptions {
  /** Reports whether a config key is set (folds in env + BYOK). */
  isConfigured: ConfigResolver;
  /** Data source for the onboarding checklist. */
  checklist?: ChecklistDataProvider;
  /** Override the step templates (default: DEFAULT_SETUP_STEPS). */
  steps?: SetupStepTemplate[];
  /** Injectable fetch for the network validators (default globalThis.fetch). */
  fetchImpl?: FetchLike;
  /** Add / override validators in the registry. */
  validators?: Partial<Record<ServiceName, ServiceValidator>>;
}

export class SetupWizard {
  private isConfigured: ConfigResolver;
  private checklistProvider?: ChecklistDataProvider;
  private steps: SetupStepTemplate[];
  private registry: Record<ServiceName, ServiceValidator>;

  constructor(opts: SetupWizardOptions) {
    this.isConfigured = opts.isConfigured;
    this.checklistProvider = opts.checklist;
    this.steps = opts.steps ?? DEFAULT_SETUP_STEPS;
    const f = opts.fetchImpl;
    this.registry = {
      anthropic: (c) => validateAnthropic(c, f),
      supabase: (c) => validateSupabase(c, f),
      github: (c) => validateGitHub(c, f),
      nango: (c) => validateNango(c),
      slack: (c) => validateSlack(c),
      stripe: (c) => validateStripe(c),
      ...(opts.validators as Record<ServiceName, ServiceValidator> | undefined),
    };
  }

  /** GET /api/setup/status — per-service configuration state. */
  async status(): Promise<SetupStatus> {
    return computeStatus(this.steps, this.isConfigured);
  }

  /**
   * POST /api/setup/validate — live connectivity check (no save).
   * Returns { status: 200|422 } on success, or a 400 error result on bad input.
   */
  async validate(
    service: unknown,
    credentials: unknown,
  ): Promise<ServiceResult<{ status: 200 | 422; result: ValidateResult }>> {
    if (typeof service !== "string" || !service) {
      return fail(400, "service フィールドが必要です");
    }
    if (typeof credentials !== "object" || credentials === null || Array.isArray(credentials)) {
      return fail(400, "credentials フィールドはオブジェクトである必要があります");
    }
    if (!VALID_SERVICE_NAMES.includes(service as ServiceName)) {
      return fail(
        400,
        `不明なサービスです: ${service}。有効な値: ${VALID_SERVICE_NAMES.join(", ")}`,
      );
    }

    const validator = this.registry[service as ServiceName];
    const result = await validator(credentials as Record<string, string>);
    return ok({ status: result.valid ? 200 : 422, result });
  }

  /** GET /api/setup/checklist — onboarding progress. */
  async checklist(): Promise<ServiceResult<ChecklistResult>> {
    if (!this.checklistProvider) {
      return fail(500, "checklist data provider is not configured");
    }
    return ok(await computeChecklist(this.checklistProvider));
  }
}

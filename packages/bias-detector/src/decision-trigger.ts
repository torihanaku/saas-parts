/**
 * Decision auto-trigger for AI Bias Detection (ported from dev-dashboard-v2,
 * #1299 / #356).
 *
 * Wired into the "decision created" event: every inserted decision fires this
 * trigger asynchronously so the API response is not blocked by the LLM. The
 * trigger:
 *
 *   1. Checks the feature flag (injected) — bails if OFF.
 *   2. Skips if a detection already exists for this decision (idempotent).
 *   3. Runs `detector.detectBiases` with the decision context.
 *   4. Inserts each detection via the injected store.
 *   5. If any detection is critical (>= BIAS_CRITICAL_THRESHOLD), calls the
 *      injected notifier once with all critical detections.
 *
 * Failures inside the trigger are logged (injected logger) but never re-thrown.
 *
 * All I/O (flag / store / notify / log) is injected — no direct supabase / env
 * / feature-flags / logger import.
 */

import type {
  BiasDetection,
  BiasType,
  DecisionContext,
  DecisionMakerRole,
} from "./types.js";
import { BIAS_CRITICAL_THRESHOLD } from "./types.js";
import type { BiasDetectorService } from "./bias-detector.js";

export interface TriggerInput {
  tenantId: string;
  decisionId: string;
  subject: string;
  reason: string;
  context?: string | null;
  alternativesConsidered?: string | null;
  decisionMakerRole?: DecisionMakerRole | null;
}

export interface TriggerResult {
  status: "ran" | "skipped" | "duplicate" | "disabled" | "error";
  detectionCount: number;
  criticalCount: number;
  reason?: string;
}

export type StoredDetection = Pick<
  BiasDetection,
  "biasType" | "confidence" | "recommendation"
> & {
  decisionId: string;
};

/** A detection ready to be persisted by the store. */
export type DetectionToStore = Omit<
  BiasDetection,
  "id" | "tenantId" | "detectedAt"
>;

/**
 * Injected persistence + side-effect surface for the trigger. All methods are
 * best-effort and should signal failure via return values / thrown errors that
 * the trigger will catch and log.
 */
export interface BiasTriggerStore {
  /** True when at least one detection already exists for this decision. */
  hasExistingDetections(input: {
    tenantId: string;
    decisionId: string;
  }): Promise<boolean>;
  /** Persist a single detection. Returns false when the write failed. */
  insertDetection(input: {
    tenantId: string;
    decisionId: string;
    detection: DetectionToStore;
  }): Promise<boolean>;
}

/** Injected feature-flag check. */
export type BiasFeatureFlag = () => boolean;

/** Injected notifier for critical detections. */
export type BiasCriticalNotifier = (
  input: TriggerInput,
  critical: StoredDetection[],
) => Promise<void>;

/** Injected structured logger. */
export interface BiasTriggerLogger {
  info(scope: string, message: string): void;
  error(scope: string, err: Error): void;
}

const noopLogger: BiasTriggerLogger = { info: () => {}, error: () => {} };

export interface BiasTriggerDeps {
  detector: BiasDetectorService;
  store: BiasTriggerStore;
  /** Feature flag gate. Defaults to always-enabled when omitted. */
  isEnabled?: BiasFeatureFlag;
  /** Critical notifier. Defaults to a no-op when omitted. */
  notifyCritical?: BiasCriticalNotifier;
  logger?: BiasTriggerLogger;
}

export async function triggerBiasDetectionForDecision(
  input: TriggerInput,
  deps: BiasTriggerDeps,
): Promise<TriggerResult> {
  const {
    detector,
    store,
    isEnabled = () => true,
    notifyCritical,
    logger = noopLogger,
  } = deps;

  if (!isEnabled()) {
    return { status: "disabled", detectionCount: 0, criticalCount: 0 };
  }

  // Idempotency: if any detection already exists for this decision, skip.
  try {
    const exists = await store.hasExistingDetections({
      tenantId: input.tenantId,
      decisionId: input.decisionId,
    });
    if (exists) {
      return { status: "duplicate", detectionCount: 0, criticalCount: 0 };
    }
  } catch (e: unknown) {
    logger.error("bias-trigger", e instanceof Error ? e : new Error(String(e)));
    // Continue — duplicate-check is best-effort.
  }

  const ctx: DecisionContext = {
    decisionId: input.decisionId,
    subject: input.subject,
    reason: input.reason,
    context: input.context ?? undefined,
    alternativesConsidered: input.alternativesConsidered ?? null,
    decisionMakerRole: input.decisionMakerRole ?? null,
  };

  let detected: DetectionToStore[];
  try {
    detected = await detector.detectBiases(ctx);
  } catch (e: unknown) {
    logger.error("bias-trigger", e instanceof Error ? e : new Error(String(e)));
    return {
      status: "error",
      detectionCount: 0,
      criticalCount: 0,
      reason: "detector_failed",
    };
  }

  if (detected.length === 0) {
    return { status: "ran", detectionCount: 0, criticalCount: 0 };
  }

  const stored: StoredDetection[] = [];
  for (const d of detected) {
    let ok = false;
    try {
      ok = await store.insertDetection({
        tenantId: input.tenantId,
        decisionId: input.decisionId,
        detection: d,
      });
    } catch (e: unknown) {
      logger.error(
        "bias-trigger",
        e instanceof Error ? e : new Error(String(e)),
      );
    }
    if (!ok) {
      logger.error(
        "bias-trigger",
        new Error(`insert failed for decision=${input.decisionId}`),
      );
      continue;
    }
    stored.push({
      decisionId: input.decisionId,
      biasType: d.biasType,
      confidence: d.confidence,
      recommendation: d.recommendation,
    });
  }

  const critical = stored.filter((s) => s.confidence >= BIAS_CRITICAL_THRESHOLD);
  if (critical.length > 0 && notifyCritical) {
    await notifyCritical(input, critical).catch((e: unknown) => {
      logger.error(
        "bias-trigger",
        e instanceof Error ? e : new Error(String(e)),
      );
    });
  }

  logger.info(
    "bias-trigger",
    `decision=${input.decisionId} stored=${stored.length} critical=${critical.length}`,
  );

  return {
    status: "ran",
    detectionCount: stored.length,
    criticalCount: critical.length,
  };
}

/**
 * Fire-and-forget wrapper for use inside HTTP handlers. Errors are swallowed
 * (and already logged inside `triggerBiasDetectionForDecision`).
 */
export function enqueueBiasDetectionForDecision(
  input: TriggerInput,
  deps: BiasTriggerDeps,
): void {
  void triggerBiasDetectionForDecision(input, deps).catch((err: unknown) => {
    const logger = deps.logger ?? noopLogger;
    logger.error(
      "bias-trigger",
      err instanceof Error ? err : new Error(String(err)),
    );
  });
}

// ─── Slack notify helper ─────────────────────────────────────────────────────

/** Japanese labels for each source bias — handy for building notifications. */
export const BIAS_LABELS_JA: Record<BiasType, string> = {
  sunk_cost: "サンクコスト",
  confirmation: "確証バイアス",
  recency: "直近偏重",
  bandwagon: "バンドワゴン",
  anchoring: "アンカリング",
  hippo: "HiPPO (上位者意見)",
};

/**
 * Build the Slack alert text for a set of critical detections. Ported from the
 * original notifier; transport is left to the injected notifier so this stays
 * secret-free.
 */
export function buildCriticalSlackText(
  input: TriggerInput,
  critical: StoredDetection[],
): string {
  const summary = critical
    .map(
      (c) =>
        `• ${BIAS_LABELS_JA[c.biasType]} (信頼度 ${(c.confidence * 100).toFixed(0)}%)${
          c.recommendation ? ` — 推奨: ${c.recommendation}` : ""
        }`,
    )
    .join("\n");
  return `:warning: *Critical な認知バイアスを検知*\n決定: *${input.subject}*\n${summary}`;
}

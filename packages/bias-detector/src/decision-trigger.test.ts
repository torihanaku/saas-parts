/**
 * Tests for decision-trigger.ts (ported from dev-dashboard-v2
 * tests/bias/decision-trigger.test.ts). Store / flag / notifier are injected.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  triggerBiasDetectionForDecision,
  enqueueBiasDetectionForDecision,
  buildCriticalSlackText,
  type BiasTriggerStore,
  type BiasTriggerDeps,
  type DetectionToStore,
} from "./decision-trigger.js";
import type { BiasDetectorService } from "./bias-detector.js";

const TENANT_ID = "22222222-2222-2222-2222-222222222222";
const DECISION_ID = "33333333-3333-3333-3333-333333333333";

const baseInput = {
  tenantId: TENANT_ID,
  decisionId: DECISION_ID,
  subject: "Continue Instagram ad budget 2x",
  reason: "Already spent 2M JPY",
};

let detectBiases: ReturnType<typeof vi.fn>;
let hasExisting: ReturnType<typeof vi.fn>;
let insertDetection: ReturnType<typeof vi.fn>;
let isEnabled: ReturnType<typeof vi.fn>;
let notifyCritical: ReturnType<typeof vi.fn>;
let deps: BiasTriggerDeps;

beforeEach(() => {
  vi.clearAllMocks();
  detectBiases = vi.fn().mockResolvedValue([]);
  hasExisting = vi.fn().mockResolvedValue(false);
  insertDetection = vi.fn().mockResolvedValue(true);
  isEnabled = vi.fn().mockReturnValue(true);
  notifyCritical = vi.fn().mockResolvedValue(undefined);

  const detector: BiasDetectorService = {
    detectBiases: detectBiases as unknown as BiasDetectorService["detectBiases"],
  };
  const store: BiasTriggerStore = {
    hasExistingDetections: hasExisting as unknown as BiasTriggerStore["hasExistingDetections"],
    insertDetection: insertDetection as unknown as BiasTriggerStore["insertDetection"],
  };
  deps = {
    detector,
    store,
    isEnabled: isEnabled as unknown as BiasTriggerDeps["isEnabled"],
    notifyCritical: notifyCritical as unknown as BiasTriggerDeps["notifyCritical"],
  };
});

function det(partial: Partial<DetectionToStore> & { biasType: DetectionToStore["biasType"]; confidence: number }): DetectionToStore {
  return {
    decisionId: null,
    evidence: {},
    recommendation: null,
    ...partial,
  };
}

describe("triggerBiasDetectionForDecision — gating", () => {
  it("returns disabled when flag is OFF", async () => {
    isEnabled.mockReturnValue(false);
    const r = await triggerBiasDetectionForDecision(baseInput, deps);
    expect(r.status).toBe("disabled");
    expect(detectBiases).not.toHaveBeenCalled();
  });

  it("returns duplicate when existing detection for the decision", async () => {
    hasExisting.mockResolvedValueOnce(true);
    const r = await triggerBiasDetectionForDecision(baseInput, deps);
    expect(r.status).toBe("duplicate");
    expect(detectBiases).not.toHaveBeenCalled();
  });
});

describe("triggerBiasDetectionForDecision — happy path", () => {
  it("inserts one row per detection and returns ran with counts", async () => {
    detectBiases.mockResolvedValueOnce([
      det({
        biasType: "sunk_cost",
        confidence: 0.85,
        evidence: { spent: 2_000_000 },
        recommendation: "Stop based on ROI",
        detectorVersion: "claude-v1",
      }),
      det({
        biasType: "confirmation",
        confidence: 0.62,
        detectorVersion: "claude-v1",
      }),
    ]);

    const r = await triggerBiasDetectionForDecision(baseInput, deps);
    expect(r.status).toBe("ran");
    expect(r.detectionCount).toBe(2);
    expect(r.criticalCount).toBe(1);
    expect(insertDetection).toHaveBeenCalledTimes(2);
    const firstCall = insertDetection.mock.calls[0]![0];
    expect(firstCall.tenantId).toBe(TENANT_ID);
    expect(firstCall.decisionId).toBe(DECISION_ID);
    expect(firstCall.detection.detectorVersion).toBe("claude-v1");
  });

  it("returns ran with zero count when detector returns []", async () => {
    detectBiases.mockResolvedValueOnce([]);
    const r = await triggerBiasDetectionForDecision(baseInput, deps);
    expect(r.status).toBe("ran");
    expect(r.detectionCount).toBe(0);
    expect(r.criticalCount).toBe(0);
    expect(insertDetection).not.toHaveBeenCalled();
  });
});

describe("triggerBiasDetectionForDecision — critical notify", () => {
  it("notifies when any detection is critical (>= 0.7)", async () => {
    detectBiases.mockResolvedValueOnce([
      det({
        biasType: "hippo",
        confidence: 0.92,
        recommendation: "Use data, not authority",
        detectorVersion: "claude-v1",
        decisionMakerRole: "ceo",
      }),
    ]);

    await triggerBiasDetectionForDecision(baseInput, deps);
    expect(notifyCritical).toHaveBeenCalledTimes(1);
    const [input, critical] = notifyCritical.mock.calls[0]!;
    const text = buildCriticalSlackText(input, critical);
    expect(text).toContain(baseInput.subject);
    expect(text).toContain("HiPPO");
    expect(text).toContain("92%");
  });

  it("does NOT notify when only sub-critical detections", async () => {
    detectBiases.mockResolvedValueOnce([
      det({ biasType: "anchoring", confidence: 0.61, detectorVersion: "claude-v1" }),
    ]);
    await triggerBiasDetectionForDecision(baseInput, deps);
    expect(notifyCritical).not.toHaveBeenCalled();
  });
});

describe("triggerBiasDetectionForDecision — detector failure", () => {
  it("returns error status when detector throws", async () => {
    detectBiases.mockRejectedValueOnce(new Error("claude_down"));
    const r = await triggerBiasDetectionForDecision(baseInput, deps);
    expect(r.status).toBe("error");
    expect(r.reason).toBe("detector_failed");
    expect(insertDetection).not.toHaveBeenCalled();
  });
});

describe("enqueueBiasDetectionForDecision", () => {
  it("does not throw even when underlying trigger rejects", async () => {
    isEnabled.mockImplementation(() => {
      throw new Error("boom");
    });
    expect(() => enqueueBiasDetectionForDecision(baseInput, deps)).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
  });
});

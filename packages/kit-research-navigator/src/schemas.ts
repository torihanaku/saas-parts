/**
 * zod スキーマ。LLM 出力のバリデーションに使用する。
 * 出典: 実運用SaaS shared/schemas/navigator.ts
 */
import { z } from "zod";

export const UseCaseCardSchema = z.object({
  source: z.object({
    kind: z.enum([
      "trending_repo",
      "product_launch",
      "vc_thesis",
      "stack_advice",
      "failure_pattern",
      "manual",
    ]),
    title: z.string(),
    url: z.string().optional(),
    summary: z.string(),
    capturedAt: z.string(),
  }),
  tool: z.object({
    kind: z.enum(["saas", "library", "pattern", "stack"]),
    name: z.string(),
    vendor: z.string().optional(),
    homepageUrl: z.string().optional(),
  }),
  integration: z.object({
    bridgeType: z.enum(["api", "webhook", "cli", "prompt", "manual"]),
    notes: z.string(),
    prerequisiteLibs: z.array(z.string()).optional(),
  }),
  output: z.object({
    kind: z.enum([
      "issue",
      "social_post",
      "internal_note",
      "architecture_change",
      "experiment_spec",
    ]),
    draftText: z.string(),
    targetRepo: z.string().optional(),
  }),
  meta: z.object({
    importanceScore: z.number().min(0).max(1),
    rationale: z.string(),
    generatedBy: z.string(),
    sourceVersion: z.literal("v1"),
    linkedIssueNumber: z.number().optional(),
  }),
});

export const HypothesisDraftSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  hypothesis: z.string().min(40).max(400),
  assumption: z.string().min(40).max(400),
  testPlan: z.string().min(40).max(400),
  invalidationCriteria: z.string().min(40).max(400),
});

export const ContextVerdictLlmSchema = z.object({
  verdict: z.enum(["big_deal", "worth_watching", "meh"]),
  rationale: z.string(),
  importance_score: z.number().min(0).max(100),
});

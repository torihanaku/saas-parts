import { z } from "zod";

export const UseCaseCardSchema = z.object({
  source: z.object({
    kind: z.enum(['trending_repo', 'product_launch', 'vc_thesis', 'stack_advice', 'failure_pattern', 'manual']),
    title: z.string(),
    url: z.string().optional(),
    summary: z.string(),
    capturedAt: z.string(),
  }),
  tool: z.object({
    kind: z.enum(['saas', 'library', 'pattern', 'stack']),
    name: z.string(),
    vendor: z.string().optional(),
    homepageUrl: z.string().optional(),
  }),
  integration: z.object({
    bridgeType: z.enum(['api', 'webhook', 'cli', 'prompt', 'manual']),
    notes: z.string(),
    prerequisiteLibs: z.array(z.string()).optional(),
  }),
  output: z.object({
    kind: z.enum(['github_issue', 'x_post', 'internal_note', 'architecture_change', 'experiment_spec']),
    draftText: z.string(),
    targetRepo: z.string().optional(),
  }),
  meta: z.object({
    importanceScore: z.number().min(0).max(1),
    rationale: z.string(),
    generatedBy: z.enum(['opus', 'haiku', 'hybrid']),
    sourceVersion: z.literal('v1'),
  }),
});

// Request Schemas
export const GetBriefRequestSchema = z.object({
  date: z.string().optional(),
  limit: z.coerce.number().optional(),
});

export const FetchSignalsRequestSchema = z.object({
  sources: z.array(z.string()).optional(),
});

export const GetSignalsRequestSchema = z.object({
  verdict: z.enum(['big_deal', 'worth_watching', 'meh']).optional(),
  limit: z.coerce.number().min(1).max(50).optional().default(10),
  offset: z.coerce.number().min(0).optional().default(0),
});

export const CreateCardRequestSchema = z.object({
  triggerSource: z.enum(['f1_signal', 'f2_stack', 'manual']),
  triggerSignalId: z.string().uuid().optional(),
  triggerStackId: z.string().min(1).optional(),
  rawInput: z.string().optional(),
  title: z.string().min(1).optional(),
  summary: z.string().min(1).optional(),
  hypothesis: z.string().optional(),
  assumption: z.string().optional(),
  testPlan: z.string().optional(),
  invalidationCriteria: z.string().optional(),
});

export const GetCardsRequestSchema = z.object({
  status: z.enum(['draft', 'testing', 'validated', 'invalidated', 'rejected']).optional(),
  limit: z.coerce.number().optional(),
  cursor: z.string().optional(),
});

export const CardActionRequestSchema = z.object({
  actionType: z.enum(['github_issue', 'x_draft', 'reject', 'saved_for_later']),
  payload: z.unknown(),
});

export const UpdateHypothesisRequestSchema = z.object({
  hypothesis: z.string().optional(),
  assumption: z.string().optional(),
  testPlan: z.string().optional(),
  invalidationCriteria: z.string().optional(),
  status: z.enum(['draft', 'testing', 'validated', 'invalidated', 'rejected']).optional(),
});

export const CreateLearningRequestSchema = z.object({
  learning: z.string().min(1, "learning must be non-empty"),
  outcome: z.enum(['validated', 'invalidated', 'neutral']).optional(),
});

export const StackAdvisorQueryRequestSchema = z.object({
  currentStack: z.string(),
  scale: z.string(),
  pains: z.string(),
});

export const GetStacksRequestSchema = z.object({
  category: z.string().optional(),
});

export const GetFailurePatternsRequestSchema = z.object({
  stackId: z.string().uuid().optional(),
  severity: z.string().optional(),
});

export const DraftHypothesisRequestSchema = z.object({
  context: z.string().min(1, "context is required"),
  triggerSource: z.enum(["f1_signal", "f2_stack", "manual"]).optional(),
  triggerSignalId: z.string().uuid().optional(),
  triggerStackId: z.string().uuid().optional(),
});

export const UpdateCardStatusRequestSchema = z.object({
  status: z.enum(["draft", "testing", "validated", "invalidated", "rejected"]),
  reason: z.string().optional(),
});

export const HypothesisDraftSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  hypothesis: z.string().min(40).max(400),
  assumption: z.string().min(40).max(400),
  testPlan: z.string().min(40).max(400),
  invalidationCriteria: z.string().min(40).max(400),
});

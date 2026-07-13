# @torihanaku/kit-ai-agent

AIエージェント基盤キット — **計画 → 承認ゲート → 実行 → ロールバック** のライフサイクル一式と、**MCPサーバー雛形**（JSON-RPCディスパッチ＋ツール/リソースレジストリ＋Bearer認証）を提供します。

外部依存ゼロ。LLM・永続化・通知・監査はすべてインターフェース注入です（`process.env` / Supabase / 他 `@torihanaku/*` の import はありません）。

## アーキテクチャ

```
            ┌────────────────────────── Learning Loop ──────────────────────────┐
            ▼                                                                    │
  Planner ──────► ApprovalService ──────► Executor ──────► RollbackManager      │
  (LLMで計画生成)  (人間の承認ゲート)      (ガードレール実行)   (戦略別ロールバック)  │
  planner.ts      approval.ts            executor.ts       rollback.ts          │
      │               │                      │                  │               │
      │   PlanStore（注入）に plan/action の状態遷移を永続化       │               │
      ▼               ▼                      ▼                  ▼               │
  pending_approval → approved → executing → completed → rolled_back            │
                   ↘ rejected            ↘ failed / cancelled                   │
                                                                                │
  Monitor（異常検知→自動halt） / AutoRollback（SLO違反→リビジョン切戻し）          │
  CostTracker（実行コスト実測） / Reporter（週次レポ生成）──────────────────────────┘
  EvidenceAgent（承認の根拠を並列収集）

  Orchestrator（複数エージェント逐次協調） / ToolRegistry + runToolLoop（Claude tool-useループ）
  mcp/（MCPサーバー雛形: rpc + registry + auth）
```

状態モデル（`types.ts`）:

- **Plan**: `pending_approval → approved | rejected | revised`
- **Action**: `pending_approval → approved → executing → completed | failed | cancelled → rolled_back`
- アクションの `approval_required` は `"none"`（プラン承認で自動承認）または承認ソース名（`"slack"` 等。一致したソースの承認でのみ自動承認、それ以外は個別 `approveAction`）。元実装の high-risk 二段承認と同じ挙動です。

## コアAPI

```ts
import {
  createPlanner, createApprovalService, createExecutor, createRollbackManager,
  createInMemoryPlanStore, createInMemoryExecutionLog,
} from "@torihanaku/kit-ai-agent";

const store = createInMemoryPlanStore();          // 本番は PlanStore を自前実装
const planner = createPlanner({ llm, store });    // llm: LlmCaller（下記）

// 1. 計画（pending_approval で永続化。フィードバック再生成 = Learning Loop）
const { plan } = await planner.generatePlan("tenant-1");
await planner.regenerateWithFeedback({ tenantId: "tenant-1", planId: plan.id, feedback: "リスクを下げて" });

// 2. 承認ゲート
const approval = createApprovalService({ store, audit });
await approval.approvePlan(plan.id, "approver@example.com", "dashboard");

// 3. 実行（予算ガード → ポリシーチェック → ハンドラーディスパッチ → 実行ログ）
const executor = createExecutor({
  store,
  executionLog: createInMemoryExecutionLog(),
  handlers: { draft: async (a) => ({ externalId: "ext-1", cost: 0.05 }) },  // ActionExecutor レジストリ
  budget: myBudgetGuard,              // 任意: 超過で cancelled
  preExecutionCheck: myPolicyCheck,   // 任意: コンプラ等。NG で cancelled
});
await executor.executeAction(actionId);

// 4. ロールバック（action.rollback_strategy.type → ハンドラー）
const rollback = createRollbackManager({
  store,
  handlers: { delete: async (action, strategy) => {/* 外部リソース削除 */} },
});
await rollback.rollbackAction(actionId, "ops@example.com");
```

その他: `runOrchestration`（マルチエージェント逐次協調・役割プリセット `AGENT_ROLES`）、`ToolRegistry` + `runToolLoop`（Claude tool-use ループ）、`createMonitor` / `createAutoRollback` / `CostTracker` / `createReporter` / `createEvidenceAgent`（運用系）、`createSnapshotRollback`（デプロイ前スナップショット→復元）。

## 協調チームプリセット

`runOrchestration` のエンジンはそのままに、「名前付きチーム（役割の並び）」を選べるようにする薄いプリセット層です（`src/orchestration-presets.ts`）。プリセットは `AGENT_ROLES` の役割IDを合成しただけのデータで、`resolveTeam` がそれを `runOrchestration` が受け取る `AgentRole[]` に解決します。

同梱の**例**チーム（`listOrchestrationPresets()` で一覧）:

| id | 名前 | 構成（役割の並び） |
|---|---|---|
| `market-research` | 市場調査チーム | リサーチ → 戦略 → 批評 → 統合（`researcher` → `strategist` → `critic` → `synthesizer`） |
| `content-team` | コンテンツチーム | アイデア → 公開準備（`researcher` → `synthesizer`） |

> これらはあくまで**例**です。呼び出し側は自分のチームを自由に定義してください（役割IDリストを直接渡す／`AgentRole[]` を組み立てる／`AGENT_ROLES` を上書き・拡張する）。

`resolveTeam(team, customAgents?)` は3つの形を受け付けます:

```ts
import { resolveTeam, runOrchestration, listOrchestrationPresets } from "@torihanaku/kit-ai-agent";

// 1) プリセットID
const teamA = resolveTeam("market-research");

// 2) 役割IDの明示リスト（順序 = 実行順）
const teamB = resolveTeam(["researcher", "critic", "synthesizer"]);

// 3) 組み立て済み AgentRole[]（そのまま素通し）＋ カスタムエージェントを末尾に追加
const teamC = resolveTeam(
  [{ id: "lead", name: "リード", systemPrompt: "..." }],
  [{ name: "編集者", systemPrompt: "文章を編集してください" }], // id は自動採番
);

// 解決したチームを LlmCaller（generateText）注入でそのまま実行
const result = await runOrchestration(complete, { objective: "...", agents: teamA, max_rounds: 4 });
```

未知のプリセットID・未知の役割ID・空チームは、利用可能な候補を含む明確なエラーで即座に失敗します（元ルートの「未知役割を黙って読み飛ばす」挙動とは異なり、fail-loud）。HTTP / auth / Supabase / env の配線は落としてあり、純粋関数＋データのみです。

## 注入ポイント

| インターフェース | 役割 | 備考 |
|---|---|---|
| `LlmCaller` | `generateJson` / `generateText` | **`@torihanaku/claude-api` の同名関数がそのまま満たします**（このキットからは import しません）。テストはモックでオフライン動作 |
| `LlmToolCaller` | tool-use 1ターン（`runToolLoop` 用） | Claude Messages API 互換の最小形 |
| `PlanStore` | plan / action の永続化 | 元: Supabase `dd_agent_plans` / `dd_agent_actions`。インメモリ実装 `createInMemoryPlanStore` 同梱 |
| `ExecutionLogStore` | 実行監査ログ | 元: `dd_agent_executions` |
| `ActionHandler` レジストリ | `action_type → 実行` | 元の blog/sns/email/ad ハンドラーはここに差す |
| `RollbackHandler` レジストリ | `strategy.type → 切戻し` | delete / unpublish / revert / cancel / 任意 |
| `BudgetGuard` / `PreExecutionCheck` | 実行前ガードレール | 元: テナント月次予算 / コンプラチェック(riskScore>50) |
| `AuditLogger` | 監査イベント（hash-chain 連携点） | 戻り値の hash は実行ログに記録される |
| `AnomalyDetector[]` / `AnomalyStore` | 監視サイクル | 元: CPA急騰・メール到達低下・SEO順位下落 |
| `RevisionRollbacker` | SLO自動切戻しの実体 | 元: gcloud で Cloud Run リビジョン切替 |
| `CostStore` / `CostPricing` | コスト実測の永続化・単価表 | デフォルト単価は元実装の JPY 概算 |
| `EvidenceSource[]` | 承認根拠の並列収集元 | 元: 過去決裁・競合情報・コンプラ実績の3固定ソース |
| `PlannerPrompts` / `ReportPrompts` | プロンプト差し替え | デフォルトは製品文言を除いた汎用版 |

## MCP雛形の使い方

```ts
import {
  McpToolRegistry, McpResourceRegistry, registerExampleMcpTools,
  createMcpHandler, createMcpAuthChecker, textResult,
} from "@torihanaku/kit-ai-agent";

// 1. ツール登録（MCP は camelCase の inputSchema。Claude chat tools とは別物）
const tools = registerExampleMcpTools(new McpToolRegistry());
tools.register(
  { name: "list_items", description: "アイテム一覧", inputSchema: { type: "object", properties: {}, required: [] } },
  async () => textResult(JSON.stringify(await myStore.list())),   // ストレージはクロージャで注入
);

// 2. リソース登録（任意）
const resources = new McpResourceRegistry().register(
  { uri: "app://alerts/active", name: "Active Alerts", description: "…", mimeType: "application/json" },
  async () => myStore.activeAlerts(),
);

// 3. ハンドラー生成（フレームワーク非依存: body → JSON-RPC オブジェクト | null）
const handleRpc = createMcpHandler({ serverInfo: { name: "my-app", version: "1.0.0" }, tools, resources });

// 4. 認証（Bearer。キー未設定時の loopback 許可は明示オプトイン）
const checkAuth = createMcpAuthChecker({ apiKey: myConfig.mcpApiKey });

// 5. HTTP に載せる例（Bun / Hono / Express どれでも）
//    app.post("/mcp", async (req) => {
//      if (!checkAuth(req)) return new Response("Unauthorized", { status: 401 });
//      const res = await handleRpc(await req.json());
//      return res === null ? new Response(null, { status: 204 }) : Response.json(res);
//    });
```

対応メソッド: `initialize` / `notifications/initialized` / `tools/list` / `tools/call` / `resources/list` / `resources/read` / `ping`（protocol `2024-11-05`）。

## 落としたもの

- **製品アダプター/エグゼキューター**（`lib/agent/adapters/` cms/sns/ad、`lib/agent/executors/` cloud-run/nango）— 製品API固有。`ActionHandler` / `RevisionRollbacker` 注入に置換
- **MCP 製品ツール37個**（`tools-impl-{tasks,crm,git,intel,content}.ts`）と Supabase/GitHub ヘルパー（`mcp/helpers.ts`）— レジストリ機構＋サンプル2ツールのみ収録
- **chat-tools の製品ツール27個**（CRM/コンテンツ/レポート等）— `ToolRegistry` 機構＋サンプル2ツールのみ収録
- **HTTP/Slack 配線**（`routes/agent/*` の Bun ルート、slack-webhook 署名検証、slack-notify）— 薄いI/O層。承認ソース概念（`source: "slack"` 等）はキットに温存。Slack署名検証は kit-approval-workflow 側にあり
- **anomaly-detector / detectors / deploy-orchestrator** — マーケ指標・デプロイパイプライン固有。`AnomalyDetector[]` 注入に置換
- **BYOK / tenant-secrets / feature-flags / env 直読み** — すべて設定・コールバック注入に置換（例: auto-rollback の二層キルスイッチ → `isEnabled()`）
- **CostTracker のグローバル usage フック**（`setClaudeUsageHook`）— 明示的な `recordLlmUsage()` 呼びに置換（LlmCaller 実装側のフックから呼べばよい）

## 出典

実運用SaaS リポジトリ（読み取り専用ソース）:

| このキット | 元ファイル |
|---|---|
| `src/types.ts` | `server/lib/agent/*` 共通ドメイン + Supabase テーブル定義の抽象化 |
| `src/planner.ts` | `server/services/agentPlanner.ts`（+ `routes/agent/get-handlers.ts` の ISO week） |
| `src/approval.ts` | `server/lib/agent/approval-service.ts` |
| `src/executor.ts` | `server/lib/agent/executor.ts` |
| `src/rollback.ts` | `server/lib/agent/rollback-service.ts` + `server/services/rollbackManager.ts` |
| `src/monitor.ts` | `server/lib/agent/monitor-service.ts` |
| `src/auto-rollback.ts` | `server/lib/agent/auto-rollback.ts` |
| `src/cost-tracker.ts` | `server/lib/agent/cost-tracker.ts` |
| `src/report.ts` | `server/lib/agent/report-service.ts` |
| `src/evidence.ts` | `server/services/evidenceAgent.ts` |
| `src/orchestrator.ts` | `server/lib/agent-orchestrator.ts` |
| `src/tool-registry.ts` / `src/tool-loop.ts` | `server/lib/chat-tools-def.ts` / `chat-tools.ts` / `claude-api-client.ts` `runToolLoop` |
| `src/mcp/*` | `server/mcp/{rpc,call-tool,types,auth,resources,tools-def}.ts` |
| `src/stores.ts` | Supabase テーブルのインメモリ参照実装（新規） |

テスト出典: `tests/agent-{approval,executor,rollback,orchestrator,monitor,report}.test.ts` / `tests/agentPlanner.test.ts` 等の挙動仕様を DI 前提に書き直し＋ライフサイクルE2E・MCPディスパッチを新規追加。

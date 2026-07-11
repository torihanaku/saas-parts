# @torihanaku/kit-pattern-dna

組織パターン DNA キット — 良い例 / 悪い例を取り込み、組織のパターン（文体・成功要因・相手の反応）を学習し、新しいコンテンツを照合して反応予測・パターン警告を返す。

## 機能説明

「組織が過去に承認 / 却下したもの、成功 / 失敗したもの」を 5 カテゴリの DNA として蓄積し、これから出すコンテンツに対して**書いている最中に**フィードバックを返す仕組み。

```
取り込み（良い例 / 悪い例）
  ├─ content-ingest    — 過去コンテンツ + 実績(PV/CV) + レビュー修正履歴
  ├─ voice-profile     — 承認 / 却下文章から組織の声（文体・トーン規範）を LLM 合成
  ├─ customer-reaction — (メッセージ変種 × セグメント) → エンゲージメントの逐次平均
  └─ ingestSnapshots   — 既存コンテンツを embedding 化してスナップショット蓄積
        ↓ 蓄積（DnaStore / SnapshotStore / PerformanceStore）
照合・予測
  ├─ pattern-alerts       — 下書き × 過去の失敗/成功行の Jaccard 照合（API 依存なし）
  ├─ predict              — theme+channel 一致サンプルへの OLS 回帰で PV/CV 予測
  ├─ similarity-predict   — embedding 近傍の実績平均で PV/CV/エンゲージメント予測
  ├─ recommendBestMessage — セグメント別ベストメッセージ推薦
  └─ recommendChannel / recommendBySimilarity — チャネル推薦 + 失敗警告
```

DNA は 5 カテゴリ（値は本家 DB スキーマ互換のため維持）:

| dnaType | 意味 |
|---|---|
| `content` | 過去コンテンツの成功 / 失敗パターン |
| `brand_voice` | 組織の声（文体・トーン規範） |
| `customer_reaction` | 相手（顧客・読者）の反応パターン |
| `seasonal` | 季節性・時系列の傾向 |
| `glossary` | 組織固有の用語辞書 |

## コアAPI

```ts
import {
  // 蓄積基盤
  InMemoryDnaStore, validateIngestRequest, ingestDna, getDnaByType, getDnaStats,
  // 組織ボイスプロファイル学習
  trainVoiceProfile, extractStyleFeatures, aggregateFeatures, confidenceFromSamples,
  // 過去コンテンツ取り込み
  validateContentIngestRequest, ingestContentDna, derivePerformanceTier,
  // 反応マトリクス
  recordReaction, getReactionMatrix, recommendBestMessage,
  // 下書き照合アラート
  checkPatternAlerts, tokenize, jaccardSimilarity, classifyOutcome,
  // 回帰予測
  predictContentScore, recommendChannel, linearRegression,
  // embedding 類似予測
  predictBySimilarity, recommendBySimilarity, getSnapshotStats, ingestSnapshots,
  // React フック
  createPatternDnaHooks,
} from "@torihanaku/kit-pattern-dna";

const store = new InMemoryDnaStore();

// 1) 良い例 / 悪い例から組織の声を学習
const trained = await trainVoiceProfile({ llm, store }, {
  tenantId: "t1",
  approved: ["承認された文章…"],
  rejected: ["却下された文章…"],
});

// 2) 過去コンテンツを実績つきで取り込み（LLM 省略可 — ヒューリスティック tier のみ）
await ingestContentDna({ store, llm }, {
  tenantId: "t1", articleId: "a-1", title: "…", body: "…",
  pv: 1200, cv: 40, revisions: [{ comment: "結論を先に" }],
  publishedAt: null, tags: [], source: "manual",
});

// 3) 下書きを書いている最中にパターン警告（外部 API 不要）
const alerts = await checkPatternAlerts(store, {
  tenantId: "t1", draftText: "値上げのお知らせ…",
});
// → { failureWarnings: [...], successRecommendations: [...], scanned, threshold }

// 4) 反応予測（回帰 or embedding 近傍）
const score = await predictContentScore(store, {
  tenantId: "t1", theme: "ai", channel: "blog", length: 2000,
});
const sim = await predictBySimilarity({ searcher, performance }, {
  tenantId: "t1", contentText: "…", channel: "blog",
});

// 5) React（フェッチャ注入）
const dna = createPatternDnaHooks(api); // api = { get, post }
const { data: stats } = dna.useDnaStats();
const { data: live } = dna.useAutoPatternAlerts({ draftText, debounceMs: 600 });
```

## 注入ポイント

| インターフェース | 役割 | 満たすもの |
|---|---|---|
| `DnaStore` | DNA 行の get / upsert / list / count | `InMemoryDnaStore` 同梱。本番は下記 SQL の `pattern_dna` テーブル |
| `SnapshotStore` / `PerformanceStore` | スナップショット + 実績（similarity 経路） | `InMemorySnapshotStore` / `InMemoryPerformanceStore` 同梱 |
| `LlmCaller` | `generateJson(system, prompt, fallback, opts?)` — 失敗時は fallback を返す契約 | `@torihanaku/claude-api` の generateJson を API キー束縛で薄くラップ |
| `EmbeddingSearcher` | テキスト → 承認 / 却下コーパスの近傍 `{id, similarity}` | `@torihanaku/embeddings`（pgvector 検索）がそのまま満たせる |
| `EmbeddingGenerator` | テキスト → ベクトル（`ingestSnapshots` 用） | `@torihanaku/embeddings` の embed 関数 |
| `PatternDnaClientApi` | React フック用 HTTP クライアント `{ get, post }` | アプリの api クライアント |

LLM は全経路で**任意** — `llm` 未注入なら voice-profile 以外はヒューリスティックのみで動く（content-ingest は tier 判定のみ、predict は補正なし、pattern-alerts はそもそも不要）。

## SQLスキーマ

本家 migration（`202605110002_dd_company_dna.sql` / `202604200006_g9_s1_dna_foundation.sql`）からテーブル名を汎用化した参考スキーマ。RLS ポリシーは各アプリのテナント解決に合わせて付ける。

```sql
-- DnaStore 相当（本家: dd_company_dna）
CREATE TABLE pattern_dna (
  tenant_id UUID NOT NULL,
  dna_type TEXT NOT NULL CHECK (
    dna_type IN ('content', 'brand_voice', 'customer_reaction', 'seasonal', 'glossary')
  ),
  key TEXT NOT NULL,
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  source TEXT NOT NULL,
  confidence DOUBLE PRECISION NOT NULL DEFAULT 1.0
    CHECK (confidence >= 0 AND confidence <= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, dna_type, key)          -- 複合 PK = upsert 一意性
);
CREATE INDEX idx_pattern_dna_tenant       ON pattern_dna(tenant_id);
CREATE INDEX idx_pattern_dna_tenant_type  ON pattern_dna(tenant_id, dna_type);

-- SnapshotStore 相当（本家: dd_brand_dna_snapshots、pgvector）
CREATE TABLE pattern_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  source_type TEXT NOT NULL,                       -- 'content','email','social',…
  source_id UUID,                                  -- 元コンテンツ id（手動投入時 NULL）
  content_text TEXT NOT NULL,
  embedding VECTOR(1536),
  approval_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (approval_status IN ('approved','rejected','pending')),
  rejection_reason TEXT,
  tone_tags TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_pattern_snapshots_tenant   ON pattern_snapshots(tenant_id);
CREATE INDEX idx_pattern_snapshots_approval ON pattern_snapshots(tenant_id, approval_status);
CREATE INDEX idx_pattern_snapshots_embedding ON pattern_snapshots
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- PerformanceStore 相当（本家: dd_content_performance）
CREATE TABLE pattern_performance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  snapshot_id UUID REFERENCES pattern_snapshots(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,                           -- 'blog','email','social',…
  pv INT DEFAULT 0,
  cv INT DEFAULT 0,
  engagement_score NUMERIC(5,2),                   -- 0-100
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_pattern_perf_tenant   ON pattern_performance(tenant_id);
CREATE INDEX idx_pattern_perf_snapshot ON pattern_performance(snapshot_id);
```

`EmbeddingSearcher` の本家実装は pgvector RPC 2 本（`match_brand_dna_by_embedding` = approved 検索 / `match_brand_dna_rejected` = rejected 検索 + rejection_reason 返却。`202604200007` / `202604200008`）。キットでは `search(text, { status })` の 1 インターフェースに統合した。

## 落としたもの + 理由

- **HTTP ルート配線**（`server/routes/company-dna*.ts` / `routes/brand-dna/*` のハンドラ、tenant 解決、フィーチャーフラグ、401/405/500 マッピング）— フレームワーク・認証基盤固有。計算部分（stats 集計・スナップショット一覧の 200 文字抜粋）は `getSnapshotStats` / `listSnapshotSummaries` として移植済み。
- **Supabase / PostgREST 直結**（`supabaseGet` / `supabasePatch` / RPC 呼び出し）→ `DnaStore` / `SnapshotStore` / `PerformanceStore` / `EmbeddingSearcher` 注入に置換。
- **BYOK テナントシークレット解決**（`getTenantSecret(tenantId, 'ANTHROPIC_API_KEY')` / `env.ANTHROPIC_API_KEY`）— シークレット管理はキットの責務外。API キーは `LlmCaller` 実装側で束縛する。
- **モデル名固定**（prediction-service の `claude-3-haiku-20240307`）— `LlmCaller` 実装側の関心事に移動。
- **ingest-service の `content` テーブル走査**（既存テーブルからの自動スクレイプ前提）→ 呼び出し側が items 配列を渡す `ingestSnapshots` に汎用化。
- **useCompanyDnaStats の 404/501 フォールバック**（/dna/stats 失敗時に /brand-dna/stats へ落として 5 タイプに疑似マッピング）— 本家のルート併存事情に固有のため削除。
- **マーケチャネル固有値のハードコード** — 推薦候補チャネル `['blog','email','social']` はオプション化（デフォルトは原文値）、tier しきい値（PV50 / CVR3% / 0.5%）は `TierThresholds` 設定化。
- **広告プラットフォーム固有・Reddit / ブランド危機監視** — 指示によりスコープ外（本家でも別モジュール）。
- **ロガー**（logInfo / logError）— キットはエラーコード / null 返却で表現し、ログは呼び出し側に委ねる。

## 出典

dev-dashboard-v2（読み取りのみ・2026-07-11 時点）:

- `server/lib/company-dna.ts` → `src/foundation.ts`
- `server/lib/company-dna/brand-voice.ts` → `src/voice-profile.ts`
- `server/lib/company-dna/content-ingest.ts` → `src/content-ingest.ts`
- `server/lib/company-dna/customer-reaction.ts` → `src/customer-reaction.ts`
- `server/lib/company-dna/pattern-alerts.ts` → `src/pattern-alerts.ts`
- `server/lib/company-dna/predict.ts` → `src/predict.ts`
- `server/lib/brand-dna/{prediction,recommendation,ingest}-service.ts` + `server/routes/brand-dna/stats.ts`（計算部分） → `src/similarity-predict.ts`
- `shared/types/company-dna.ts` → `src/types.ts`
- `src/hooks/{usePatternAlerts,useCompanyDnaStats,useBrandDna}.ts` → `src/client/hooks.ts`
- migrations: `202605110002_dd_company_dna.sql`, `202604200006_g9_s1_dna_foundation.sql`, `202604200007/8_g9_s1_dna_*_rpc.sql` → README の SQL スキーマ
- tests: `tests/company-dna*.test.ts`, `tests/hooks/*`, `tests/server/lib/brand-dna/*` のコアを `src/*.test.ts` に移植

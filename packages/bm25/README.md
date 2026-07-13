# @torihanaku/bm25

教師データ不要のBM25スコアリング（TF-IDF改良版・Elasticsearchのデフォルトランキング関数）で、検索クエリにマッチしたドキュメントを習熟度重み付きでランキングする純粋関数群。

## API例

```ts
import {
  computeBm25Scores,
  buildIdfMap,
  buildSkillCountMap,
  computeAvgSkillCount,
  type Bm25Input,
} from "@torihanaku/bm25";

// 1) 前処理: DB等から取得したフラットな行をMapに変換
const idfBySkill = buildIdfMap([
  { skill_name: "rust", idf: 4.2 },
  { skill_name: "typescript", idf: 1.1 },
]);
const skillCountByChar = buildSkillCountMap([
  { character_id: "alice", skill_count: 12 },
  { character_id: "bob", skill_count: 80 },
]);
const avgSkillCount = computeAvgSkillCount(skillCountByChar);

// 2) スコア計算（proficiencyで重み付け: expert 1.25 / advanced 1.0 / intermediate 0.85 / beginner 0.6）
const input: Bm25Input = {
  matchedSkillsByChar: new Map([
    ["alice", [{ name: "rust", proficiency: "expert" }]],
    ["bob", [{ name: "typescript", proficiency: "beginner" }]],
  ]),
  skillCountByChar,
  idfBySkill,
  avgSkillCount,
};
const ranked = computeBm25Scores(input);
// => [{ characterId: "alice", score: ..., matchedSkills: ["rust"] }, ...] スコア降順
```

## 注入ポイント

- **データは全て引数渡し**（DB・Supabase等への依存なし）。IDF値・文書長・マッチ結果を呼び出し側で用意して `Bm25Input` に詰める
- パラメータ `BM25_K1`（1.5）/ `BM25_B`（0.75）と `PROFICIENCY_WEIGHT` はエクスポート済み定数（標準値固定）
- 未知のproficiencyは重み1.0、IDF未登録スキルはIDF=1.0、文書長未登録は平均値でフォールバック
- 簡略化の前提: (doc, term) の組はユニーク → TFは常に0 or 1

## Runtime

- 依存ゼロ・純粋計算のみ。Node / Bun / ブラウザいずれでも動作

## 出典

- `実運用SaaS/server/lib/bm25.ts` の忠実移植（zero-dep faithful port）

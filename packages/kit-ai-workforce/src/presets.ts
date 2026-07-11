/**
 * プリセット定義。
 *
 * プリセット = AI社員チームのアバター世界観の切り替え（ドラゴンボールZ / ビジネス /
 * ミニマル 等）。テンプレートは個々の AI社員のひな型。
 *
 * ⚠️ ORIGINAL_PRESETS / ORIGINAL_CHARACTER_NAMES は製品オーナーの IP（ドラゴンボールZ
 * キャラクターを AI社員に見立てた世界観）。汎用キットとしては EXAMPLE_ プリセット・
 * EXAMPLE_TEMPLATES を出発点に使うこと。オリジナルは参照・移植のため温存している。
 *
 * 出典: server/routes/team-characters/presets-resume.ts（ビルトインプリセット）
 *       server/lib/state.ts（CHARACTER_NAMES）
 */
import type { CharacterTemplate } from "./types";

export interface Preset {
  id: string;
  name: string;
  description: string;
  is_builtin: boolean;
}

// ─── オリジナル（製品オーナー IP・温存） ────────────────────────────────────

/** 元 CHARACTER_NAMES（ドラゴンボールZ）。移植参照用に温存。 */
export const ORIGINAL_CHARACTER_NAMES: Record<string, string> = {
  vegeta: "ベジータ",
  gohan: "悟飯",
  trunks: "トランクス",
  piccolo: "ピッコロ",
  krillin: "クリリン",
  bulma: "ブルマ",
  c18: "18号",
  tenshinhan: "天津飯",
  kaiosama: "界王様",
  hit: "ヒット",
  dende: "デンデ",
};

/** 元のビルトインプリセット（デフォルト = dbz）。温存。 */
export const ORIGINAL_PRESETS: Preset[] = [
  { id: "dbz", name: "ドラゴンボールZ", description: "DBZキャラクターでチームを構成（デフォルト）", is_builtin: true },
  { id: "business", name: "ビジネス", description: "プロフェッショナルなビジネスアバター", is_builtin: true },
  { id: "minimal", name: "ミニマル", description: "シンプルなイニシャルアイコン", is_builtin: true },
];

// ─── 汎用サンプル（キット利用者はここから始める） ───────────────────────────

/** 汎用プリセット例。プロダクト固有の世界観を含まない中立版。 */
export const EXAMPLE_PRESETS: Preset[] = [
  { id: "business", name: "ビジネス", description: "プロフェッショナルなビジネスアバター（デフォルト）", is_builtin: true },
  { id: "minimal", name: "ミニマル", description: "シンプルなイニシャルアイコン", is_builtin: true },
];

/**
 * 汎用の AI社員テンプレート例。matchCharacters / cloneTemplate の入力に使える。
 * proficiency は BM25 の PROFICIENCY_WEIGHT と対応する文字列ラベル。
 */
export const EXAMPLE_TEMPLATES: CharacterTemplate[] = [
  {
    slug: "backend-engineer",
    name: "バックエンドエンジニア",
    role: "Backend Engineer",
    roleDescription: "API・データベース・インフラを設計し、堅牢なサーバーサイドを構築する。",
    team: "engineering",
    personality: { communicationStyle: "論理的で簡潔", tendencies: ["設計重視", "計測してから最適化"] },
    agentConfig: {
      archetype: "executor",
      workingStyle: "autonomous",
      specializations: ["API設計", "データベース設計", "パフォーマンスチューニング"],
    },
    skills: [
      { name: "TypeScript", category: "language", proficiency: "expert" },
      { name: "PostgreSQL", category: "database", proficiency: "advanced" },
      { name: "API設計", category: "backend", proficiency: "expert" },
    ],
    tags: ["engineering", "backend"],
  },
  {
    slug: "product-manager",
    name: "プロダクトマネージャー",
    role: "Product Manager",
    roleDescription: "顧客課題を定義し、優先順位を決め、チームを成果に導く。",
    team: "product",
    personality: { communicationStyle: "傾聴と要約が得意", tendencies: ["顧客志向", "仮説検証"] },
    agentConfig: {
      archetype: "orchestrator",
      workingStyle: "collaborative",
      specializations: ["要件定義", "優先順位付け", "ロードマップ策定"],
    },
    skills: [
      { name: "要件定義", category: "product", proficiency: "expert" },
      { name: "ユーザーインタビュー", category: "research", proficiency: "advanced" },
      { name: "ロードマップ策定", category: "product", proficiency: "advanced" },
    ],
    tags: ["product", "management"],
  },
  {
    slug: "marketing-specialist",
    name: "マーケティングスペシャリスト",
    role: "Marketing Specialist",
    roleDescription: "獲得チャネルを設計・運用し、CV とコストを最適化する。",
    team: "marketing",
    personality: { communicationStyle: "データドリブン", tendencies: ["A/B検証", "ROI重視"] },
    agentConfig: {
      archetype: "specialist",
      workingStyle: "autonomous",
      specializations: ["広告運用", "ROAS・CPAトラッキング", "LP最適化"],
    },
    skills: [
      { name: "広告運用", category: "marketing", proficiency: "advanced" },
      { name: "ROAS・CPAトラッキング", category: "marketing", proficiency: "expert" },
      { name: "LP最適化", category: "marketing", proficiency: "intermediate" },
    ],
    tags: ["marketing"],
  },
];

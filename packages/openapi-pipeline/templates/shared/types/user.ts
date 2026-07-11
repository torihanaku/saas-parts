/**
 * User / plan types — フロントエンドとバックエンドで共有する型定義
 * バック:   server/lib/user-context.ts
 * フロント: API レスポンス型として利用可能
 */

export interface UserConfig {
  user_id: string;
  plan: 'free' | 'pro' | 'enterprise';
  keywords: string[];
  industry: string | null;
  goal: string | null;
  channels: string[];
}

export interface PlanLimits {
  contentPerDay: number;
  intelligenceRefresh: number;
  aiAnalysis: number;
  channels: number;
  autopilotPerDay: number;
  /** -1 = unlimited */
  knowledgeItems: number;
  /** -1 = unlimited */
  integrations: number;
  /** -1 = unlimited */
  teamMembers: number;
}

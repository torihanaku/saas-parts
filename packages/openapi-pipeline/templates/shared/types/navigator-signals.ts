export type SignalSource = 'hackernews' | 'x_list' | 'product_hunt' | 'github_trending' | 'vc_announcement' | 'manual';
export type VerdictType = 'big_deal' | 'worth_watching' | 'meh';

export interface NavSignal {
  id: string;
  user_id: string;
  source: SignalSource;
  url: string;
  title: string;
  body: string | null;
  fetched_at: string;
  seen_at: string | null;
  created_at: string;
}

export interface NavContext {
  id: string;
  user_id: string;
  signal_id: string;
  related_signal_ids: string[];
  importance_score: number;
  verdict: VerdictType;
  rationale: string;
  created_at: string;
}

export interface ContextVerdict {
  verdict: VerdictType;
  rationale: string;
  importance_score: number;
  related_signal_ids: string[];
}

export interface NewSignal {
  source: SignalSource;
  url: string;
  title: string;
  body?: string | null;
  fetched_at: string;
}

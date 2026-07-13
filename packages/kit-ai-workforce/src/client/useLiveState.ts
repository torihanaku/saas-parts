/**
 * AI社員のライブ状態をポーリング取得する React フック。
 *
 * サーバーの GET /state が返す形（characters / tasks / history / sessions）を
 * そのまま型化。fetcher（例: adminFetch や api.get）を注入するので、認証・
 * ベース URL などプロダクト固有部分に依存しない。
 *
 * 出典: 実運用SaaS src/hooks/useLiveState.ts のポーリング形を一般化。
 * peer: react (>=18)
 */
import { useState, useEffect, useCallback, useRef } from "react";

export interface LiveCharacterState {
  status: string;
  progress: number;
  currentTask: string;
  updatedAt: string;
}

export interface LiveTaskState {
  status: string;
  completedAt?: string;
  updatedAt?: string;
}

export interface HistoryEntry {
  time: string;
  actor: string;
  action: string;
  task: string;
  detail: string;
}

export interface SessionInfo {
  sessionId: string;
  state: "working" | "idle" | "waiting";
  message: string;
  characterId: string;
  workingDir: string;
  updatedAt: string;
}

export interface LiveState {
  tasks: Record<string, LiveTaskState>;
  characters: Record<string, LiveCharacterState>;
  history: HistoryEntry[];
  sessions: SessionInfo[];
  updatedAt: string;
}

const EMPTY: LiveState = { tasks: {}, characters: {}, history: [], sessions: [], updatedAt: "" };

/**
 * @param fetchState `/state` を取得して生 JSON を返す注入関数。
 * @param intervalMs ポーリング間隔（ミリ秒）。
 */
export function useLiveState(
  fetchState: () => Promise<Record<string, unknown>>,
  intervalMs = 60000,
): LiveState {
  const [state, setState] = useState<LiveState>(EMPTY);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await fetchState();
      setState({
        tasks: (data.tasks || {}) as Record<string, LiveTaskState>,
        characters: (data.characters || {}) as Record<string, LiveCharacterState>,
        history: (data.history || []) as HistoryEntry[],
        sessions: (data.sessions || []) as SessionInfo[],
        updatedAt: (data.updatedAt || "") as string,
      });
    } catch {
      // silent
    }
  }, [fetchState]);

  useEffect(() => {
    refresh();
    timer.current = setInterval(refresh, intervalMs);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [refresh, intervalMs]);

  return state;
}

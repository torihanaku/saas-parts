/**
 * AI社員チームのビュー状態を組み立てる React フック。
 *
 * 静的なキャラクター定義（役割・所属チーム）に、サーバーからのライブ状態
 * （作業中セッション・進捗・履歴）をマージして「今チームで何が起きているか」を
 * 返す。元実装は data/characters・data/tasks・useLiveState に密結合していたが、
 * ここでは静的キャラ配列とライブ状態を注入する形に一般化した。
 *
 * 出典: dev-dashboard-v2 src/pages/team/useTeamState.ts（108行）
 * peer: react (>=18)
 */
import { useState } from "react";
import type { HistoryEntry, LiveState, SessionInfo } from "./useLiveState";

/** ビューが必要とする最小のキャラクター形。 */
export interface TeamCharacter {
  id: string;
  name: string;
  team: string;
  status: string;
  currentTask?: string;
  progress?: number;
  collaborators?: string[];
}

export interface TeamInfo {
  id: string;
  name?: string;
  [key: string]: unknown;
}

export interface UseTeamStateArgs<C extends TeamCharacter> {
  /** 静的なキャラクター定義。 */
  staticCharacters: C[];
  /** サーバーからのライブ状態。 */
  liveState: LiveState;
  /** チーム定義（フィルタ・カウント用）。 */
  teams: TeamInfo[];
  /** 履歴 h.task から剥がす接頭辞（元実装のデフォルトを踏襲）。 */
  taskPrefixPattern?: RegExp;
}

const DEFAULT_PREFIX = /^(自動開発完了|自動開発開始|新リクエスト受付): /;

export function useTeamState<C extends TeamCharacter>(args: UseTeamStateArgs<C>) {
  const { staticCharacters, liveState, teams, taskPrefixPattern = DEFAULT_PREFIX } = args;
  const [selectedChar, setSelectedChar] = useState<C | null>(null);
  const [activeTeam, setActiveTeam] = useState<string>("all");

  // 履歴からキャラごとの直近タスクを構築
  const charRecentTasks: Record<string, string[]> = {};
  const nameToId: Record<string, string> = {};
  staticCharacters.forEach((c) => {
    nameToId[c.name] = c.id;
  });

  for (const h of (liveState.history || []) as HistoryEntry[]) {
    const charId = nameToId[h.actor];
    if (!charId) continue;
    if (!charRecentTasks[charId]) charRecentTasks[charId] = [];
    if (charRecentTasks[charId].length < 3) {
      const task = h.task.replace(taskPrefixPattern, "");
      if (task && !charRecentTasks[charId].includes(task)) {
        charRecentTasks[charId].push(task);
      }
    }
  }

  const sessionsForChar = (charId: string): SessionInfo[] =>
    (liveState.sessions || []).filter((s) => s.characterId === charId && s.state === "working");

  // ライブ状態を静的キャラにマージ
  const characters: C[] = staticCharacters.map((c) => {
    const activeSessions = sessionsForChar(c.id);
    const live = liveState.characters[c.id];

    if (activeSessions.length > 0) {
      const latestSession = [...activeSessions].sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      )[0]!;
      return {
        ...c,
        status: "作業中",
        currentTask: latestSession.message || live?.currentTask || "作業中...",
        progress: live?.progress ?? 50,
      };
    }
    if (live) {
      return {
        ...c,
        status: live.status || c.status,
        currentTask: live.currentTask || "次のタスク待ち",
        progress: live.progress ?? c.progress,
      };
    }
    return { ...c, currentTask: "次のタスク待ち", status: "完了" };
  });

  // コラボレーターのユニークペアを算出
  const collabPairs: Array<[string, string]> = [];
  characters.forEach((c) => {
    if (c.collaborators) {
      c.collaborators.forEach((cId) => {
        const pair = [c.id, cId].sort() as [string, string];
        const key = pair.join("-");
        if (!collabPairs.find((p) => p.join("-") === key)) {
          collabPairs.push(pair);
        }
      });
    }
  });

  const filteredCharacters =
    activeTeam === "all" ? characters : characters.filter((c) => c.team === activeTeam);

  const teamCounts = teams.map((t) => ({
    ...t,
    count: characters.filter((c) => c.team === t.id).length,
    active: characters.filter((c) => c.team === t.id && c.status === "作業中").length,
  }));

  return {
    selectedChar,
    setSelectedChar,
    activeTeam,
    setActiveTeam,
    characters,
    filteredCharacters,
    collabPairs,
    teamCounts,
    charRecentTasks,
    sessionsForChar,
  };
}

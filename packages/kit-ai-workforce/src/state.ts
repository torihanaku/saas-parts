/**
 * AI社員のライブ状態機械 + アクティビティログ + セッション追跡 + SSE ブロードキャスト。
 *
 * 元実装（dev-dashboard-v2 server/lib/state.ts）は fs / Supabase / Redis に直結して
 * いたが、このキットではそれらを剥がし「状態機械と SSE ブロードキャストのロジックは
 * そのまま」に、永続化はオプションのコールバック注入とした（デフォルトはメモリ内）。
 *
 * 出典: dev-dashboard-v2 server/lib/state.ts（181行）
 */

// ─── 型 ──────────────────────────────────────────────────────────────────────

export interface CharacterState {
  status: string;
  currentTask: string;
  progress: number;
  updatedAt: string;
}

export interface ApplicationState {
  characters: Record<string, CharacterState>;
  tasks: Record<string, unknown>;
  history: unknown[];
  updatedAt: string;
}

export type Activity = Record<string, unknown> & { receivedAt: string };
export type Command = Record<string, unknown>;

/** AI社員が担当している 1 セッション（作業中/待機/アイドル）。 */
export interface AgentSession {
  sessionId: string;
  state: "working" | "idle" | "waiting";
  message: string;
  characterId: string;
  workingDir: string;
  updatedAt: string;
}

export interface Notification {
  id: string;
  type: string;
  title: string;
  message: string;
  read: boolean;
  user_id: string;
  created_at: string;
}

/**
 * 永続化フック（任意）。未指定ならメモリ内キャッシュのみで動作する。
 * 元実装の writeFileSync + Supabase 永続化に相当する差し込み口。
 */
export interface StateStore {
  loadState?(): ApplicationState | null;
  saveState?(state: ApplicationState): void;
  loadActivity?(): Activity[];
  saveActivity?(activities: Activity[]): void;
  saveCommands?(commands: Command[]): void;
  loadCommands?(): Command[];
}

/**
 * AI社員システムのライブ状態を保持するランタイム。プロセス内シングルトンとして
 * 使うことを想定（元実装のモジュールスコープ変数に相当）。
 */
export class WorkforceState {
  private stateCache: ApplicationState | null = null;
  private activityCache: Activity[] | null = null;

  /** AI社員ごとのセッション追跡（元 claudeSessions）。 */
  readonly sessions: Map<string, AgentSession> = new Map();

  /** リアルタイム通知用の SSE クライアント。 */
  readonly sseClients: Map<string, ReadableStreamDefaultController> = new Map();

  constructor(private readonly store: StateStore = {}) {}

  // ─── SSE ブロードキャスト（元実装のまま） ──────────────────────────────────

  broadcastNotification(notification: Notification): void {
    const encoder = new TextEncoder();
    const data = `data: ${JSON.stringify(notification)}\n\n`;
    for (const [clientId, controller] of this.sseClients.entries()) {
      try {
        controller.enqueue(encoder.encode(data));
      } catch {
        this.sseClients.delete(clientId);
      }
    }
  }

  broadcastStateChange(): void {
    const encoder = new TextEncoder();
    const data = `event: state-change\ndata: {}\n\n`;
    for (const [clientId, controller] of this.sseClients.entries()) {
      try {
        controller.enqueue(encoder.encode(data));
      } catch {
        this.sseClients.delete(clientId);
      }
    }
  }

  // ─── 状態 CRUD ──────────────────────────────────────────────────────────────

  readState(): ApplicationState | null {
    if (this.stateCache) return this.stateCache;
    const loaded = this.store.loadState?.();
    if (loaded) {
      this.stateCache = loaded;
      return loaded;
    }
    return null;
  }

  writeState(state: ApplicationState): void {
    this.stateCache = state;
    this.store.saveState?.(state);
    this.broadcastStateChange();
  }

  getStateCache(): ApplicationState | null {
    return this.stateCache;
  }

  setStateCache(s: ApplicationState | null): void {
    this.stateCache = s;
  }

  // ─── アクティビティ CRUD（先頭追加・50件で切り詰め） ───────────────────────

  readActivity(): Activity[] {
    if (this.activityCache) return this.activityCache;
    const loaded = this.store.loadActivity?.();
    if (loaded) {
      this.activityCache = loaded;
      return loaded;
    }
    return [];
  }

  addActivity(activity: Record<string, unknown>): void {
    let activities = this.readActivity();
    activities.unshift({ ...activity, receivedAt: new Date().toISOString() });
    if (activities.length > 50) activities = activities.slice(0, 50);
    this.activityCache = activities;
    this.store.saveActivity?.(activities);
  }

  // ─── コマンド（先頭追加・100件で切り詰め） ────────────────────────────────

  saveCommand(cmd: Command): void {
    let commands: Command[] = this.store.loadCommands?.() ?? [];
    commands.unshift(cmd);
    if (commands.length > 100) commands = commands.slice(0, 100);
    this.store.saveCommands?.(commands);
  }

  // ─── 初期化 ──────────────────────────────────────────────────────────────

  /**
   * 与えられた AI社員 ID 群で state を初期化する（全員「完了」からスタート）。
   * 元実装は CHARACTER_NAMES を固定参照していたが、ここでは ID 群を注入する。
   */
  initializeState(characterIds: string[]): ApplicationState {
    const now = new Date().toISOString();
    const characters: Record<string, CharacterState> = {};
    for (const id of characterIds) {
      characters[id] = {
        status: "完了",
        currentTask: "次のタスク待ち",
        progress: 100,
        updatedAt: now,
      };
    }
    const state: ApplicationState = { characters, tasks: {}, history: [], updatedAt: now };
    this.writeState(state);
    return state;
  }
}

/**
 * AI社員のライブ状態機械 + アクティビティログ + セッション追跡 + SSE ブロードキャスト。
 *
 * 元実装（実運用SaaS server/lib/state.ts）は fs / Supabase / Redis に直結して
 * いたが、このキットではそれらを剥がし「状態機械と SSE ブロードキャストのロジックは
 * そのまま」に、永続化はオプションのコールバック注入とした（デフォルトはメモリ内）。
 *
 * 出典: 実運用SaaS server/lib/state.ts（181行）
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

  /**
   * SSE クライアントの所属スコープ（tenant / user 等の任意ラベル）。
   * `addSseClient(id, controller, scope)` で登録した場合のみ記録される。
   *
   * ⚠️ マルチテナント安全性: 元実装（実運用SaaS）は「1 プロセス =
   * 1 テナント」前提で全クライアントへ無差別ブロードキャストしていた。
   * 複数テナントが同一プロセスの `sseClients` を共有すると、あるテナントの
   * 通知が別テナントの購読者へ漏れる。scope を登録し broadcast に scope /
   * predicate を渡すと、宛先を該当スコープのクライアントだけに限定できる
   * （デフォルトは後方互換のため従来どおり全員へ送る）。
   */
  readonly sseClientScope: Map<string, string> = new Map();

  constructor(private readonly store: StateStore = {}) {}

  // ─── SSE クライアント登録（scope 付き） ────────────────────────────────────

  /**
   * SSE クライアントを登録する。`scope`（tenantId / userId 等）を渡すと、
   * 以降の scoped ブロードキャストの宛先制御に使われる。
   */
  addSseClient(
    clientId: string,
    controller: ReadableStreamDefaultController,
    scope?: string,
  ): void {
    this.sseClients.set(clientId, controller);
    if (scope !== undefined) this.sseClientScope.set(clientId, scope);
    else this.sseClientScope.delete(clientId);
  }

  /** SSE クライアントを登録解除する（scope も破棄）。 */
  removeSseClient(clientId: string): void {
    this.sseClients.delete(clientId);
    this.sseClientScope.delete(clientId);
  }

  private dropSseClient(clientId: string): void {
    this.sseClients.delete(clientId);
    this.sseClientScope.delete(clientId);
  }

  // ─── SSE ブロードキャスト ───────────────────────────────────────────────────

  /**
   * 通知をブロードキャストする。
   *
   * @param target 宛先の絞り込み（任意）:
   *   - 省略時: 従来どおり全クライアントへ送る（後方互換・単一テナント想定）。
   *   - 文字列: `sseClientScope` がその値に一致するクライアントにのみ送る
   *     （マルチテナントでの tenant/user 分離）。scope 未登録のクライアントは
   *     除外される（漏洩しない安全側デフォルト）。
   *   - 述語関数: `(clientId, scope) => boolean` が true のクライアントにのみ送る。
   */
  broadcastNotification(
    notification: Notification,
    target?: string | ((clientId: string, scope: string | undefined) => boolean),
  ): void {
    const encoder = new TextEncoder();
    const data = `data: ${JSON.stringify(notification)}\n\n`;
    this.emitToClients(encoder.encode(data), target);
  }

  broadcastStateChange(
    target?: string | ((clientId: string, scope: string | undefined) => boolean),
  ): void {
    const encoder = new TextEncoder();
    const data = `event: state-change\ndata: {}\n\n`;
    this.emitToClients(encoder.encode(data), target);
  }

  private emitToClients(
    payload: Uint8Array,
    target?: string | ((clientId: string, scope: string | undefined) => boolean),
  ): void {
    const match =
      target === undefined
        ? () => true
        : typeof target === "function"
          ? target
          : (_id: string, scope: string | undefined) => scope === target;

    for (const [clientId, controller] of this.sseClients.entries()) {
      if (!match(clientId, this.sseClientScope.get(clientId))) continue;
      try {
        controller.enqueue(payload);
      } catch {
        this.dropSseClient(clientId);
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

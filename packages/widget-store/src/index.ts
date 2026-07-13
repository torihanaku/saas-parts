/**
 * @torihanaku/widget-store — ダッシュボード / ウィジェットレイアウト / お気に入りの永続化層
 *
 * 出典: 実運用SaaS server/lib/daily-dashboard-store.ts (#721)
 *
 * 移植方針:
 * - Supabase PostgREST 直叩き (supabaseGet / fetch) を注入式の
 *   `WidgetStoreDriver` インターフェースに置き換えた (インメモリ実装同梱)。
 * - `dd_dashboards` / `dd_dashboard_widgets_favorites` / `v_dd_signals_24h`
 *   のテーブル概念は汎用の dashboard / favorite / signal 用語へ改名した。
 * - 各メソッドのフォールバック挙動 (失敗時に null / [] / 既定文字列を返し
 *   throw しない) は原典どおり。
 */

// ─── ドメイン型 (原典 shared/types/dashboard.ts から必要分を汎用化して同梱) ──

export type DashboardKind = "daily" | "shot" | "stock";

export interface WidgetSpec {
  id: string;
  /** widget の種類 (原典では union だったが汎用文字列に緩和) */
  type: string;
  title: string;
  params?: Record<string, unknown>;
  size?: string;
  /** AI がなぜこの widget を選んだかの根拠 (任意) */
  reason?: string;
  /** freeform チャート spec 等の追加ペイロード (任意) */
  vegaLiteSpec?: Record<string, unknown>;
}

export interface DashboardSpec {
  /** uuid */
  id: string;
  kind: DashboardKind;
  /** デイリーキャッシュ判定キー: YYYY-MM-DD */
  dateKey: string;
  generatedAt: string;
  /** 生成に使ったトークン数 (利用量メータリング用) */
  tokensUsed?: number;
  widgets: WidgetSpec[];
  /** shot の質問文 (persistShot が埋め込む) */
  question?: string;
  /** shot の深掘り元 widget id (persistShot が埋め込む) */
  contextWidgetId?: string;
}

export interface StockListItem {
  id: string;
  title: string;
  createdAt: string;
  question?: string;
}

export interface FavoriteItem {
  id: string;
  sourceWidgetId: string;
  widgetSpec: WidgetSpec;
  pinnedPosition: number | null;
  createdAt: string;
}

export interface SignalRow {
  signalType: string;
  description: string;
  value: string;
  observedAt: string | null;
}

// ─── ドライバ (ストレージ抽象) ────────────────────────────────────────────

export interface DashboardRow {
  id: string;
  tenantId: string;
  userId: string;
  kind: DashboardKind;
  /** daily はキャッシュキー。shot / stock は null (history として積む) */
  dateKey: string | null;
  specJson: DashboardSpec;
  tokensUsed: number;
  createdAt: string;
  updatedAt: string;
}

export interface FavoriteRow {
  id: string;
  tenantId: string;
  userId: string;
  sourceWidgetId: string;
  widgetSpec: WidgetSpec;
  pinnedPosition: number | null;
  createdAt: string;
}

export interface DashboardQuery {
  tenantId: string;
  userId: string;
  kind?: DashboardKind;
  /** undefined = 条件に含めない。null = dateKey IS NULL を要求 */
  dateKey?: string | null;
  id?: string;
  orderByCreatedAtDesc?: boolean;
  limit?: number;
}

/**
 * 永続化バックエンドの抽象。Supabase / RDB / KV など任意の実装を注入する。
 * 同梱の `createInMemoryWidgetStoreDriver()` が参照実装。
 */
export interface WidgetStoreDriver {
  findDashboards(query: DashboardQuery): Promise<DashboardRow[]>;
  /** 単純 insert (shot / stock は history として積むため upsert しない) */
  insertDashboard(row: DashboardRow): Promise<void>;
  /** (tenantId, userId, dateKey) の UNIQUE 相当で upsert (daily キャッシュ用) */
  upsertDashboard(row: DashboardRow): Promise<void>;
  /** 直近シグナル (原典 v_dd_signals_24h 相当のビュー) */
  listSignals(): Promise<SignalRow[]>;
  /** pinnedPosition asc (null last) → createdAt desc で整列して返すこと */
  findFavorites(query: { tenantId: string; userId: string; limit?: number }): Promise<FavoriteRow[]>;
  /** (tenantId, userId, sourceWidgetId) UNIQUE で upsert し、確定行を返す。失敗時は null */
  upsertFavorite(input: {
    tenantId: string;
    userId: string;
    sourceWidgetId: string;
    widgetSpec: WidgetSpec;
    pinnedPosition: number | null;
  }): Promise<FavoriteRow | null>;
  /** 削除成否を返す */
  deleteFavorite(query: { tenantId: string; userId: string; favoriteId: string }): Promise<boolean>;
}

// ─── ユーティリティ (原典そのまま) ───────────────────────────────────────

export function todayDateKey(): string {
  return new Date().toISOString().split("T")[0] ?? "";
}

export function cryptoRandomUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `dash-${Date.now()}-${Math.floor(Math.random() * 1e9).toString(16)}`;
}

// ─── ストア本体 ───────────────────────────────────────────────────────────

export interface WidgetStoreOptions {
  /** 省略時はインメモリドライバ (プロセス内のみ永続) */
  driver?: WidgetStoreDriver;
  /** 失敗ログ。省略時は console.error */
  logger?: (message: string, error: unknown) => void;
  /** テスト用の時刻注入 */
  now?: () => Date;
}

export interface WidgetStore {
  /** 今日の daily キャッシュを取得 */
  fetchTodayCache(tenantId: string, userId: string): Promise<DashboardSpec | null>;
  /** 直近シグナルを AI に渡す短い要約テキストへ整形 */
  fetchSignalSummary(): Promise<string>;
  /** お気に入り widget をデイリー自動組み込み用に最大 4 件取得 (軽量版) */
  fetchFavorites(tenantId: string, userId: string): Promise<WidgetSpec[]>;
  /** ショット質問時の context dashboard を (kind, dateKey) で取得 */
  fetchContextDashboard(
    tenantId: string,
    userId: string,
    kind: "daily" | "stock",
    dateKey?: string,
  ): Promise<DashboardSpec | null>;
  /** shot を id 指定で取得 (tenant / user 境界つき) */
  fetchShotById(tenantId: string, userId: string, shotId: string): Promise<DashboardSpec | null>;
  /** shot を insert (history として積む)。question / contextWidgetId を spec に埋め込む */
  persistShot(
    tenantId: string,
    userId: string,
    spec: DashboardSpec,
    meta: { question: string; contextWidgetId?: string },
  ): Promise<void>;
  /** stock を insert (dateKey=null)。AI 呼び出しなしで shot の spec をコピー */
  persistStock(tenantId: string, userId: string, spec: DashboardSpec): Promise<void>;
  /** ユーザーの stock 一覧を createdAt desc で返す */
  listStocks(tenantId: string, userId: string, limit?: number): Promise<StockListItem[]>;
  /** stock を id 指定で取得 (tenant / user 境界つき) */
  fetchStockById(tenantId: string, userId: string, stockId: string): Promise<DashboardSpec | null>;
  /** お気に入りを upsert。(tenant, user, sourceWidgetId) UNIQUE で重複は merge */
  addFavorite(
    tenantId: string,
    userId: string,
    input: { sourceWidgetId: string; widgetSpec: WidgetSpec; pinnedPosition?: number },
  ): Promise<FavoriteItem | null>;
  /** お気に入りを id 指定で削除。返り値は削除成否 */
  deleteFavorite(tenantId: string, userId: string, favoriteId: string): Promise<boolean>;
  /** お気に入り一覧を full item 形式で返す (UI CRUD 用)。fetchFavorites は compose 用軽量版 */
  listFavoriteItems(tenantId: string, userId: string): Promise<FavoriteItem[]>;
  /** daily を (tenant, user, dateKey) UNIQUE で upsert */
  persistDashboard(tenantId: string, userId: string, spec: DashboardSpec): Promise<void>;
}

export function createWidgetStore(options: WidgetStoreOptions = {}): WidgetStore {
  const driver = options.driver ?? createInMemoryWidgetStoreDriver();
  const logger =
    options.logger ?? ((message: string, error: unknown) => console.error(message, error));
  const now = options.now ?? (() => new Date());

  function toDashboardRow(
    tenantId: string,
    userId: string,
    spec: DashboardSpec,
    dateKey: string | null,
  ): DashboardRow {
    const ts = now().toISOString();
    return {
      id: spec.id,
      tenantId,
      userId,
      kind: spec.kind,
      dateKey,
      specJson: spec,
      tokensUsed: spec.tokensUsed ?? 0,
      createdAt: ts,
      updatedAt: ts,
    };
  }

  function toFavoriteItem(r: FavoriteRow): FavoriteItem {
    return {
      id: r.id,
      sourceWidgetId: r.sourceWidgetId,
      widgetSpec: r.widgetSpec,
      pinnedPosition: r.pinnedPosition,
      createdAt: r.createdAt,
    };
  }

  return {
    async fetchTodayCache(tenantId, userId) {
      try {
        const rows = await driver.findDashboards({
          tenantId,
          userId,
          kind: "daily",
          dateKey: todayDateKey(),
          limit: 1,
        });
        return rows[0]?.specJson ?? null;
      } catch {
        return null;
      }
    },

    async fetchSignalSummary() {
      try {
        const list = await driver.listSignals();
        if (list.length === 0) return "直近 24h に notable signal なし";
        return list.map((r) => `- [${r.signalType}] ${r.description}: ${r.value}`).join("\n");
      } catch {
        return "シグナル取得に失敗";
      }
    },

    async fetchFavorites(tenantId, userId) {
      try {
        const rows = await driver.findFavorites({ tenantId, userId, limit: 4 });
        return rows.map((r) => r.widgetSpec).filter(Boolean);
      } catch {
        return [];
      }
    },

    async fetchContextDashboard(tenantId, userId, kind, dateKey) {
      try {
        const key = dateKey ?? todayDateKey();
        const rows = await driver.findDashboards({ tenantId, userId, kind, dateKey: key, limit: 1 });
        return rows[0]?.specJson ?? null;
      } catch {
        return null;
      }
    },

    async fetchShotById(tenantId, userId, shotId) {
      try {
        const rows = await driver.findDashboards({ tenantId, userId, kind: "shot", id: shotId, limit: 1 });
        return rows[0]?.specJson ?? null;
      } catch {
        return null;
      }
    },

    async persistShot(tenantId, userId, spec, meta) {
      try {
        const enrichedSpec: DashboardSpec = {
          ...spec,
          question: meta.question,
          contextWidgetId: meta.contextWidgetId,
        };
        await driver.insertDashboard({
          ...toDashboardRow(tenantId, userId, spec, null),
          specJson: enrichedSpec,
        });
      } catch (err) {
        logger("[widget-store] persistShot failed", err);
      }
    },

    async persistStock(tenantId, userId, spec) {
      try {
        await driver.insertDashboard(toDashboardRow(tenantId, userId, spec, null));
      } catch (err) {
        logger("[widget-store] persistStock failed", err);
      }
    },

    async listStocks(tenantId, userId, limit = 50) {
      try {
        const rows = await driver.findDashboards({
          tenantId,
          userId,
          kind: "stock",
          orderByCreatedAtDesc: true,
          limit,
        });
        return rows.map((r) => ({
          id: r.id,
          title: r.specJson?.question ?? `Stock ${r.id.slice(0, 8)}`,
          createdAt: r.createdAt,
          question: r.specJson?.question,
        }));
      } catch {
        return [];
      }
    },

    async fetchStockById(tenantId, userId, stockId) {
      try {
        const rows = await driver.findDashboards({ tenantId, userId, kind: "stock", id: stockId, limit: 1 });
        return rows[0]?.specJson ?? null;
      } catch {
        return null;
      }
    },

    async addFavorite(tenantId, userId, input) {
      try {
        const row = await driver.upsertFavorite({
          tenantId,
          userId,
          sourceWidgetId: input.sourceWidgetId,
          widgetSpec: input.widgetSpec,
          pinnedPosition: input.pinnedPosition ?? null,
        });
        if (!row) return null;
        return toFavoriteItem(row);
      } catch (err) {
        logger("[widget-store] addFavorite failed", err);
        return null;
      }
    },

    async deleteFavorite(tenantId, userId, favoriteId) {
      try {
        return await driver.deleteFavorite({ tenantId, userId, favoriteId });
      } catch {
        return false;
      }
    },

    async listFavoriteItems(tenantId, userId) {
      try {
        const rows = await driver.findFavorites({ tenantId, userId });
        return rows.map(toFavoriteItem);
      } catch {
        return [];
      }
    },

    async persistDashboard(tenantId, userId, spec) {
      try {
        await driver.upsertDashboard(toDashboardRow(tenantId, userId, spec, spec.dateKey));
      } catch (err) {
        logger("[widget-store] persist failed", err);
      }
    },
  };
}

// ─── インメモリドライバ (参照実装 / テスト・開発用) ──────────────────────

export interface InMemoryWidgetStoreDriver extends WidgetStoreDriver {
  /** テスト・開発用: シグナル行を差し替える */
  setSignals(rows: SignalRow[]): void;
  /** テスト・開発用: 全データを破棄する */
  clear(): void;
}

export function createInMemoryWidgetStoreDriver(seed?: {
  signals?: SignalRow[];
}): InMemoryWidgetStoreDriver {
  let dashboards: DashboardRow[] = [];
  let favorites: FavoriteRow[] = [];
  let signals: SignalRow[] = seed?.signals ? [...seed.signals] : [];

  function sortFavorites(rows: FavoriteRow[]): FavoriteRow[] {
    // pinnedPosition asc (null last) → createdAt desc
    return [...rows].sort((a, b) => {
      if (a.pinnedPosition !== b.pinnedPosition) {
        if (a.pinnedPosition === null) return 1;
        if (b.pinnedPosition === null) return -1;
        return a.pinnedPosition - b.pinnedPosition;
      }
      return b.createdAt.localeCompare(a.createdAt);
    });
  }

  return {
    async findDashboards(query) {
      let rows = dashboards.filter((r) => r.tenantId === query.tenantId && r.userId === query.userId);
      if (query.kind !== undefined) rows = rows.filter((r) => r.kind === query.kind);
      if (query.dateKey !== undefined) rows = rows.filter((r) => r.dateKey === query.dateKey);
      if (query.id !== undefined) rows = rows.filter((r) => r.id === query.id);
      if (query.orderByCreatedAtDesc) {
        rows = [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      }
      if (query.limit !== undefined) rows = rows.slice(0, query.limit);
      return rows;
    },

    async insertDashboard(row) {
      dashboards.push({ ...row });
    },

    async upsertDashboard(row) {
      const idx = dashboards.findIndex(
        (r) =>
          r.tenantId === row.tenantId &&
          r.userId === row.userId &&
          r.dateKey !== null &&
          r.dateKey === row.dateKey,
      );
      if (idx >= 0) {
        const existing = dashboards[idx];
        dashboards[idx] = { ...row, createdAt: existing?.createdAt ?? row.createdAt };
      } else {
        dashboards.push({ ...row });
      }
    },

    async listSignals() {
      return [...signals];
    },

    async findFavorites(query) {
      const rows = sortFavorites(
        favorites.filter((r) => r.tenantId === query.tenantId && r.userId === query.userId),
      );
      return query.limit !== undefined ? rows.slice(0, query.limit) : rows;
    },

    async upsertFavorite(input) {
      const existing = favorites.find(
        (r) =>
          r.tenantId === input.tenantId &&
          r.userId === input.userId &&
          r.sourceWidgetId === input.sourceWidgetId,
      );
      if (existing) {
        existing.widgetSpec = input.widgetSpec;
        existing.pinnedPosition = input.pinnedPosition;
        return { ...existing };
      }
      const row: FavoriteRow = {
        id: cryptoRandomUuid(),
        tenantId: input.tenantId,
        userId: input.userId,
        sourceWidgetId: input.sourceWidgetId,
        widgetSpec: input.widgetSpec,
        pinnedPosition: input.pinnedPosition,
        createdAt: new Date().toISOString(),
      };
      favorites.push(row);
      return { ...row };
    },

    async deleteFavorite(query) {
      const before = favorites.length;
      favorites = favorites.filter(
        (r) => !(r.id === query.favoriteId && r.tenantId === query.tenantId && r.userId === query.userId),
      );
      return favorites.length < before;
    },

    setSignals(rows) {
      signals = [...rows];
    },

    clear() {
      dashboards = [];
      favorites = [];
      signals = [];
    },
  };
}

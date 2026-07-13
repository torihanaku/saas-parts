/**
 * @torihanaku/reauth — 機微操作前の再認証（re-auth）トークン基盤。
 *
 * 出典:
 *   - 実運用SaaS/server/lib/reauth-token.ts（32byte hex トークン / 15分TTL /
 *     インメモリ store / 定期クリーンアップ / requireReAuth ガード）
 *   - 実運用SaaS/server/routes/auth/reauth.ts（パスワード再検証フローの
 *     タイミング攻撃緩和: 80〜120ms のランダム遅延）
 *
 * 変更点: モジュールレベルの Map + setInterval → createReauthStore() ファクトリ
 * （dispose 可能）。パスワード検証は Supabase 直叩き → 注入 async コールバック
 * `verifyCredentials(email, password)`。パスワードに限らず OTP / 2FA など
 * 任意の「二要素目」検証に使える（コールバックの意味は呼び出し側が決める）。
 */
import { randomBytes } from "node:crypto";

// ─── Token store ────────────────────────────────────────────────────────────

interface ReauthTokenData {
  email: string;
  expiresAt: number;
}

export interface ReauthStoreOptions {
  /** トークンTTL（ms）。デフォルト 15分（元実装どおり）。 */
  ttlMs?: number;
  /** 期限切れトークンの掃除間隔（ms）。デフォルト 60秒。`null` でタイマー無効。 */
  cleanupIntervalMs?: number | null;
  /** トークンのバイト長。デフォルト 32（hex 64文字）。 */
  tokenBytes?: number;
  /** 再認証トークンを運ぶリクエストヘッダー名。デフォルト "X-Reauth-Token"。 */
  headerName?: string;
  /** 現在時刻（テスト注入用）。デフォルト Date.now。 */
  now?: () => number;
}

export interface ReauthStore {
  /** 32byte（デフォルト）の hex トークンを発行し TTL 付きで保持する。 */
  generateReauthToken: (email: string) => string;
  /** トークンが存在し、期限内で、同じ email に紐づくか検証する。 */
  verifyReauthToken: (token: string, email: string) => boolean;
  /**
   * Request ヘッダーからトークンを取り出して検証するガード。
   * 不備なら 403 Response、通過なら null（元実装の requireReAuth と同じ契約）。
   */
  requireReAuth: (req: Request, email: string) => Promise<Response | null>;
  /** 保持中トークン数（診断用）。 */
  size: () => number;
  /** クリーンアップタイマーを停止する（テスト・シャットダウン時）。 */
  dispose: () => void;
}

export function createReauthStore(options: ReauthStoreOptions = {}): ReauthStore {
  const ttlMs = options.ttlMs ?? 15 * 60 * 1000; // 15 minutes
  const cleanupIntervalMs = options.cleanupIntervalMs === undefined ? 60 * 1000 : options.cleanupIntervalMs;
  const tokenBytes = options.tokenBytes ?? 32;
  const headerName = options.headerName ?? "X-Reauth-Token";
  const now = options.now ?? Date.now;

  const reauthTokens = new Map<string, ReauthTokenData>();

  function generateReauthToken(email: string): string {
    const token = randomBytes(tokenBytes).toString("hex");
    const expiresAt = now() + ttlMs;
    reauthTokens.set(token, { email, expiresAt });
    return token;
  }

  function verifyReauthToken(token: string, email: string): boolean {
    const data = reauthTokens.get(token);
    if (!data) return false;
    if (data.expiresAt < now()) {
      reauthTokens.delete(token);
      return false;
    }
    if (data.email !== email) return false;
    return true;
  }

  async function requireReAuth(req: Request, email: string): Promise<Response | null> {
    const token = req.headers.get(headerName);
    if (!token) {
      return Response.json({ error: "Re-authentication required" }, { status: 403 });
    }
    if (!verifyReauthToken(token, email)) {
      return Response.json({ error: "Invalid or expired re-auth token" }, { status: 403 });
    }
    return null;
  }

  // Cleanup expired tokens periodically
  let timer: ReturnType<typeof setInterval> | null = null;
  if (cleanupIntervalMs !== null) {
    timer = setInterval(() => {
      const t = now();
      for (const [token, data] of reauthTokens.entries()) {
        if (data.expiresAt < t) {
          reauthTokens.delete(token);
        }
      }
    }, cleanupIntervalMs);
    timer.unref?.();
  }

  function dispose(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { generateReauthToken, verifyReauthToken, requireReAuth, size: () => reauthTokens.size, dispose };
}

// ─── Re-verification flow (timing-attack mitigated) ─────────────────────────

/**
 * 資格情報の再検証コールバック。true = 検証成功。
 * 元実装は Supabase の `/auth/v1/token?grant_type=password` を叩いていた。
 * パスワードに限らず OTP コードや 2FA チャレンジの検証でもよい。
 */
export type VerifyCredentials = (email: string, credential: string) => Promise<boolean>;

export interface ReauthFlowOptions {
  store: ReauthStore;
  verifyCredentials: VerifyCredentials;
  /** 遅延の下限（ms）。デフォルト 80（元実装どおり）。 */
  minDelayMs?: number;
  /** ランダムジッター幅（ms）。デフォルト 40 → 実遅延 80〜120ms。 */
  jitterMs?: number;
  /** sleep 実装（テスト注入用）。 */
  sleep?: (ms: number) => Promise<void>;
  /** 乱数源 [0,1)（テスト注入用）。 */
  random?: () => number;
}

export type VerifyAndIssueResult =
  | { ok: true; token: string }
  | { ok: false };

export interface ReauthFlow {
  /**
   * タイミング攻撃緩和のランダム遅延（min 80ms + jitter）を挟んでから
   * 資格情報を検証し、成功時のみ re-auth トークンを発行する。
   */
  verifyAndIssueToken: (email: string, credential: string) => Promise<VerifyAndIssueResult>;
  /**
   * 元実装 handleVerifySession（POST /api/auth/verify-session 相当）の移植。
   * セッション解決を注入して Request → Response で完結するハンドラを返す。
   * body: { password: string } / 成功: { reauth_token }。
   */
  createVerifySessionHandler: (
    getSessionEmail: (req: Request) => Promise<string | null>,
  ) => (req: Request) => Promise<Response>;
}

export function createReauthFlow(options: ReauthFlowOptions): ReauthFlow {
  const {
    store,
    verifyCredentials,
    minDelayMs = 80,
    jitterMs = 40,
    random = Math.random,
  } = options;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function verifyAndIssueToken(email: string, credential: string): Promise<VerifyAndIssueResult> {
    // Artificial delay to mitigate timing attacks (min 80ms, random jitter)
    const delay = minDelayMs + random() * jitterMs;
    await sleep(delay);

    const verified = await verifyCredentials(email, credential);
    if (!verified) return { ok: false };

    return { ok: true, token: store.generateReauthToken(email) };
  }

  function createVerifySessionHandler(
    getSessionEmail: (req: Request) => Promise<string | null>,
  ): (req: Request) => Promise<Response> {
    return async (req: Request): Promise<Response> => {
      const email = await getSessionEmail(req);
      if (!email) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }

      let body: { password?: string };
      try {
        body = (await req.json()) as { password?: string };
      } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
      }

      if (!body.password || typeof body.password !== "string") {
        return Response.json({ error: "Password is required" }, { status: 400 });
      }

      const result = await verifyAndIssueToken(email, body.password);
      if (!result.ok) {
        return Response.json({ error: "Invalid password" }, { status: 401 });
      }

      return Response.json({ reauth_token: result.token });
    };
  }

  return { verifyAndIssueToken, createVerifySessionHandler };
}

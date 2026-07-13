/**
 * クライアント（顧客）スコープの接続ID規約。
 * `client_{clientId}_{integrationId}` の命名でプロバイダ側の接続を
 * テナント内のクライアント単位に分離する。
 *
 * 出典: dev-dashboard-v2 server/lib/nango-client.ts（ロジックそのまま）
 */

/** クライアントスコープの接続IDを組み立てる */
export function buildConnectionId(clientId: string, integrationId: string): string {
  return `client_${clientId}_${integrationId}`;
}

/**
 * 接続IDからクライアントIDを抽出する。クライアントスコープでなければ null。
 *
 * 命名規約は `client_{clientId}_{integrationId}` で integrationId が末尾トークン。
 * clientId 自体にアンダースコアが含まれる場合（例: `acme_corp`）でも正しく復元する
 * よう、先頭の `client_` と末尾の `_{integrationId}` を除いた中間全体を返す。
 * 旧実装（`^client_([^_]+)_`）は最初の `_` までしか拾わず、`acme_corp` を `acme` と
 * 誤判定してクライアント（テナント内スコープ）を取り違えるバグがあった。
 */
export function extractClientId(connectionId: string): string | null {
  const match = connectionId.match(/^client_(.+)_[^_]+$/);
  return match ? (match[1] ?? null) : null;
}

/** 接続が特定クライアントのものかを判定する */
export function isClientConnection(connectionId: string, clientId: string): boolean {
  return connectionId.startsWith(`client_${clientId}_`);
}

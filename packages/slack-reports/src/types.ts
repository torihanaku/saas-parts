/**
 * @torihanaku/slack-reports — 共通型
 *
 * 定期レポートを Slack Block Kit として組み立てるビルダー群の共有型。
 * 送信 (sender)・データ取得 (provider)・文言 (copy) はすべて注入式。
 */

/** Slack Block Kit の 1 メッセージ分ペイロード (chat.postMessage / incoming webhook 共通)。 */
export interface BlockKitPayload {
  /** 通知バナー等に使われるフォールバックテキスト。 */
  text: string;
  /** Block Kit ブロック配列。中身は Slack の block 定義に準拠した任意オブジェクト。 */
  blocks: Array<Record<string, unknown>>;
}

/**
 * ペイロードを実際に Slack へ送る関数。
 *
 * incoming webhook / chat.postMessage / DM いずれの実装でもよい。
 * `@torihanaku/slack-harness` の `postSlackDm` などがこのシグネチャを充足する。
 * throw した場合、ランナーはそのテナントをスキップし次へ進む (ループは止まらない)。
 */
export type SlackReportSender = (payload: BlockKitPayload) => Promise<void>;

/** レポート対象テナント (最小限)。 */
export interface ReportTenant {
  id: string;
  name: string;
}

/** ISO 8601 週文字列 (YYYY-WNN) を返すヘルパの型。 */
export type IsoWeekFn = (date?: Date) => string;

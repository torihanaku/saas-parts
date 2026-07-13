/**
 * Brand Monitoring & Crisis Detection job.
 *
 * 監視ソース（CrisisSource）から言及を取得 → 感情分類（LLM）→ 保存 →
 * 24h スパイク検知 → 閾値超過でアラート。
 *
 * 出典: 実運用SaaS server/lib/brand-crisis-job.ts
 */
import {
  type BrandCrisisAlert,
  type BrandCrisisConfig,
  type BrandMention,
  DEFAULT_SEARCH_OPTIONS,
  DEFAULT_SENTIMENT_MODEL,
  DEFAULT_THRESHOLD,
  type GenerateJson,
} from "./types";

/**
 * Classify sentiment via the injected LLM.
 * apiKey が空なら LLM を呼ばず "neutral" を返す。
 */
async function classifySentiment(
  generateJson: GenerateJson,
  apiKey: string,
  content: string,
  model: string,
): Promise<string> {
  if (!apiKey) return "neutral";

  const prompt = `以下のテキストの感情を 'positive', 'neutral', 'negative' のいずれかで分類してください。
テキスト:
${content}

回答はJSON形式で以下のキーのみを含めてください:
{
  "sentiment": "positive" | "neutral" | "negative"
}`;

  const res = await generateJson<{ sentiment: string }>(
    apiKey,
    "あなたは感情分析の専門家です。",
    prompt,
    { sentiment: "neutral" },
    { maxTokens: 100, model },
  );
  return res.sentiment;
}

/**
 * Run one pass of the brand-crisis monitor.
 *
 * 原典の cron ハンドラ相当。feature flag / job-scheduler 登録は呼び出し側に委ねる。
 * 例外は内部で握り、throw しない（cron を落とさない設計を継承）。
 */
export async function runBrandCrisisMonitor(config: BrandCrisisConfig): Promise<void> {
  const threshold = config.threshold ?? DEFAULT_THRESHOLD;
  const searchOptions = config.searchOptions ?? DEFAULT_SEARCH_OPTIONS;
  const sentimentModel = config.sentimentModel ?? DEFAULT_SENTIMENT_MODEL;
  const resolveApiKey = config.resolveApiKey ?? (() => "");
  const log = config.logger ?? (() => {});

  try {
    const queries = await config.store.getMonitoredKeywords();
    if (!queries || !Array.isArray(queries)) return;

    for (const query of queries) {
      const tenantId = query.tenant_id;

      // すべての注入ソースを走査して言及を集約
      const mentions = (
        await Promise.all(config.sources.map((s) => s.search(query.keyword, searchOptions).then(
          (ms) => ms.map((m) => ({ m, source: s.name })),
          () => [],
        )))
      ).flat();

      const apiKey = (await resolveApiKey(tenantId)) || "";

      for (const { m, source } of mentions) {
        const sentiment = await classifySentiment(config.generateJson, apiKey, m.content || "", sentimentModel);
        const record: BrandMention = {
          tenant_id: tenantId,
          source,
          external_id: m.external_id,
          content: m.content,
          sentiment,
          fetched_at: new Date().toISOString(),
        };
        await config.store.insertMention(record);
      }

      // 24h スパイク検知
      const oneDayAgo = new Date(Date.now() - 86_400_000).toISOString();
      const count = await config.store.countRecentMentions(tenantId, oneDayAgo);

      if (count > threshold) {
        const alert: BrandCrisisAlert = {
          tenant_id: tenantId,
          alert_type: "spike",
          mention_count: count,
          threshold,
          triggered_at: new Date().toISOString(),
          notified_channels: config.alerter ? ["slack"] : [],
        };
        await config.store.insertAlert(alert);
        if (config.alerter) {
          try {
            await config.alerter({ tenantId, alertType: "spike", count, threshold });
          } catch (err) {
            log("error", "[BrandCrisis] Failed to send alert:", err);
          }
        }
      }
    }
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    log("error", `[BrandCrisis] monitor failed: ${error.message}`, error);
  }
}

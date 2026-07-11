/**
 * In-memory CrisisStore. テスト・PoC 向けの即戦力デフォルト実装。
 */
import type { BrandCrisisAlert, BrandMention, CrisisStore, MonitoredKeyword } from "./types";

export class InMemoryCrisisStore implements CrisisStore {
  private keywords: MonitoredKeyword[] = [];
  private mentions: BrandMention[] = [];
  private alerts: BrandCrisisAlert[] = [];
  private seq = 0;

  constructor(seed?: { keywords?: MonitoredKeyword[]; mentions?: BrandMention[] }) {
    if (seed?.keywords) this.keywords = [...seed.keywords];
    if (seed?.mentions) this.mentions = [...seed.mentions];
  }

  async getMonitoredKeywords(): Promise<MonitoredKeyword[]> {
    return this.keywords.map((k) => ({ ...k }));
  }

  async insertMention(mention: BrandMention): Promise<void> {
    this.mentions.push({ id: `m-${++this.seq}`, ...mention });
  }

  async countRecentMentions(tenantId: string, sinceIso: string): Promise<number> {
    const since = new Date(sinceIso).getTime();
    return this.mentions.filter(
      (m) => m.tenant_id === tenantId && new Date(m.fetched_at).getTime() > since,
    ).length;
  }

  async insertAlert(alert: BrandCrisisAlert): Promise<void> {
    this.alerts.push({ ...alert });
  }

  // ─── Test helpers ──────────────────────────────────────────────────────────
  _allMentions(): BrandMention[] {
    return this.mentions.map((m) => ({ ...m }));
  }
  _allAlerts(): BrandCrisisAlert[] {
    return this.alerts.map((a) => ({ ...a }));
  }
  /** countRecentMentions を任意数にプリセットしたい場合の言及ダミー投入。 */
  _seedRecentMentions(tenantId: string, n: number): void {
    const now = new Date().toISOString();
    for (let i = 0; i < n; i++) {
      this.mentions.push({
        id: `seed-${++this.seq}`,
        tenant_id: tenantId,
        source: "seed",
        external_id: `seed:${this.seq}`,
        content: "",
        sentiment: "neutral",
        fetched_at: now,
      });
    }
  }
}

import { describe, expect, it } from "vitest";
import {
  EmailSettingsService,
  TenantSettingsService,
  buildTenantSettingsPatch,
  defaultEmailSettings,
  isValidFilterRule,
  normalizeFilterRules,
} from "./settings";
import { InMemoryEmailSettingsStore, InMemoryTenantSettingsStore } from "./stores";

describe("buildTenantSettingsPatch", () => {
  it("有効なフィールドだけ通す", () => {
    const patch = buildTenantSettingsPatch({
      slackChannels: ["C1", "C2"],
      dailyBriefingEnabled: true,
      dailyBriefingTime: "09:30",
    });
    expect(patch).toEqual({
      slackChannels: ["C1", "C2"],
      dailyBriefingEnabled: true,
      dailyBriefingTime: "09:30",
    });
  });

  it("不正な型・不正な HH:MM は落とす。全滅なら null", () => {
    expect(
      buildTenantSettingsPatch({
        slackChannels: "not-array",
        dailyBriefingEnabled: "yes",
        dailyBriefingTime: "25:00",
      }),
    ).toBeNull();
    expect(buildTenantSettingsPatch({ dailyBriefingTime: "9:30" })).toBeNull();
    expect(buildTenantSettingsPatch({ dailyBriefingTime: "23:59" })).toEqual({
      dailyBriefingTime: "23:59",
    });
  });
});

describe("TenantSettingsService", () => {
  it("初回 update で owner_user_id が呼び出しユーザーになる", async () => {
    const store = new InMemoryTenantSettingsStore();
    const svc = new TenantSettingsService({ store });
    const res = await svc.update("t1", "caller-1", { slackChannels: ["C1"] });
    expect(res.ok).toBe(true);
    const settings = (res as { ok: true; settings: { ownerUserId: string } }).settings;
    expect(settings.ownerUserId).toBe("caller-1");
    expect((await svc.get("t1"))!.slackChannels).toEqual(["C1"]);
  });

  it("有効フィールドゼロは no_valid_fields", async () => {
    const svc = new TenantSettingsService({ store: new InMemoryTenantSettingsStore() });
    expect(await svc.update("t1", "u1", { slackChannels: 42 })).toEqual({
      ok: false,
      error: "no_valid_fields",
    });
  });
});

describe("normalizeFilterRules / isValidFilterRule", () => {
  it("最低 1 フィールド必須・200 文字上限", () => {
    expect(isValidFilterRule({ fromDomain: "a.com" })).toBe(true);
    expect(isValidFilterRule({})).toBe(false);
    expect(isValidFilterRule({ fromDomain: "x".repeat(201) })).toBe(false);
    expect(isValidFilterRule(null)).toBe(false);
  });

  it("20 件超・非配列・不正ルール混入は null", () => {
    expect(normalizeFilterRules("x")).toBeNull();
    expect(
      normalizeFilterRules(Array.from({ length: 21 }, () => ({ fromDomain: "a.com" }))),
    ).toBeNull();
    expect(normalizeFilterRules([{ fromDomain: "a.com" }, {}])).toBeNull();
    expect(normalizeFilterRules([{ fromDomain: "a.com", extra: "dropped" }])).toEqual([
      { fromDomain: "a.com", subjectContains: undefined, labelIncludes: undefined },
    ]);
  });
});

describe("EmailSettingsService", () => {
  it("未設定テナントはデフォルト形を返す", async () => {
    const svc = new EmailSettingsService({ store: new InMemoryEmailSettingsStore() });
    expect(await svc.get("t1")).toEqual(defaultEmailSettings("t1"));
  });

  it("update: integration 不正は google-mail に、lookback は 1〜168 に clamp", async () => {
    const svc = new EmailSettingsService({ store: new InMemoryEmailSettingsStore() });
    const res = await svc.update("t1", {
      integration: "carrier-pigeon",
      enabled: true,
      filterRules: [{ fromDomain: "a.com" }],
      lookbackHours: 9999,
    });
    expect(res.ok).toBe(true);
    const settings = (res as { ok: true; settings: { integration: string; lookbackHours: number } })
      .settings;
    expect(settings.integration).toBe("google-mail");
    expect(settings.lookbackHours).toBe(168);
  });

  it("不正な filterRules は invalid_filter_rules", async () => {
    const svc = new EmailSettingsService({ store: new InMemoryEmailSettingsStore() });
    expect(await svc.update("t1", { filterRules: [{}] })).toEqual({
      ok: false,
      error: "invalid_filter_rules",
    });
  });
});

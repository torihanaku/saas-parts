/**
 * 標準スキャナ群と、それらを全登録したレジストリのファクトリ。
 */
import { ScannerRegistry } from "../scanner";
import { createDeadLinkScanner } from "./dead-link";
import { createImageScanner } from "./image";
import { createSeoQualityScanner } from "./seo-quality";
import { createSeoRankScanner } from "./seo-rank";
import { createDormantEmailScanner } from "./dormant-email";
import { createCrmBounceScanner } from "./crm-bounce";
import { createScheduleExpiryScanner } from "./schedule-expiry";

export * from "./dead-link";
export * from "./image";
export * from "./seo-quality";
export * from "./seo-rank";
export * from "./dormant-email";
export * from "./crm-bounce";
export * from "./schedule-expiry";

/**
 * 7 種の標準スキャナ (dead-link / image / seo-quality / seo-rank /
 * dormant-email / crm-bounce / schedule-expiry) を全登録したレジストリを返す。
 * これらは `AssetScanner` の実装例。独自スキャナは `.register()` で追加できる。
 */
export function createDefaultScannerRegistry(): ScannerRegistry {
  return new ScannerRegistry()
    .register(createDeadLinkScanner())
    .register(createImageScanner())
    .register(createSeoQualityScanner())
    .register(createSeoRankScanner())
    .register(createDormantEmailScanner())
    .register(createCrmBounceScanner())
    .register(createScheduleExpiryScanner());
}

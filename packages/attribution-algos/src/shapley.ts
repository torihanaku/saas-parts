/**
 * Shapley-value attribution (uniform split over unique channels per
 * converting path — the closed-form Shapley solution for a symmetric
 * "any touch contributes" characteristic function).
 * Ported verbatim from 実運用SaaS `server/lib/marketing-roi/shapley.ts`.
 */
import {
  type ConversionPath,
  isConversionTouchpoint,
  touchpointKeyForModel,
} from "./attribution";

export function calculateShapleyAttribution(paths: ConversionPath[]): Map<string, number> {
  const credits = new Map<string, number>();
  for (const path of paths) {
    if (!path.converted) continue;
    const touches = path.touchpoints.filter((touchpoint) => !isConversionTouchpoint(touchpoint));
    if (touches.length === 0) continue;
    const uniqueKeys = Array.from(new Set(touches.map(touchpointKeyForModel)));
    const credit = 1 / uniqueKeys.length;
    for (const key of uniqueKeys) {
      credits.set(key, (credits.get(key) ?? 0) + credit);
    }
  }
  return credits;
}

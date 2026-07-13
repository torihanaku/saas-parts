import type { ForecastEngine, ForecastEngineSelector } from "./forecast-engine";
import { arimaEngine } from "./arima-engine";
import { movingAverageEngine } from "./moving-average-engine";
import { ProphetEngine } from "./prophet-engine";

const prophetEngine = new ProphetEngine();

/**
 * データ量による自動選択ロジック。30 日未満は null、30-90 日は MA、90 日以上は ARIMA/Prophet。
 * Ported verbatim from 実運用SaaS `server/lib/forecast/engine-selector.ts`.
 */
export const defaultEngineSelector: ForecastEngineSelector = {
  pickEngine(availableDays: number): ForecastEngine | null {
    if (availableDays < 30) return null;           // 明示エラー
    if (availableDays < 90) return movingAverageEngine; // 信頼区間広め
    // Assume seasonality if data > 180 days, else ARIMA
    if (availableDays >= 180) return prophetEngine;
    return arimaEngine;                             // ARIMA(1,1,1)
  },
};

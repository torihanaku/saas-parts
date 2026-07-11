/**
 * @torihanaku/stats-sim — シナリオ予測のモンテカルロ分布＋MMM弾力性抽出（因果オーバーライド付き）
 */

export {
  runMonteCarlo,
  makeRng,
  __testing as __monteCarloTesting,
  type MonteCarloInput,
  type MonteCarloDistribution,
  type MonteCarloOutput,
} from "./monte-carlo";

export {
  extractElasticitiesFromMmm,
  extractElasticitiesWithCausalPreference,
  buildCausalElasticityTable,
  channelToInputKey,
  FALLBACK_ELASTICITIES,
  __testing as __elasticityTesting,
  type SaturationForm,
  type MmmChannelResult,
  type MmmResultRow,
  type CausalToTwinLink,
  type CausalElasticityResult,
  type ElasticityExtractResult,
  type ElasticityWithCausalResult,
} from "./elasticity-extractor";

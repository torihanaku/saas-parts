/**
 * The two numeric primitives the ARIMA engine originally consumed from the
 * `timeseries-analysis` npm package, inlined so this package is dependency-free.
 *
 * `arLeastSquareDegree1` is the degree=1 specialization of that library's
 * `ARLeastSquare` (credits: Rainer Hegger 1998 / Paul Bourke's C code /
 * Julien Loutre's JS port). For degree 1 the normal equations collapse to
 * a single ratio, verified equivalent to the library's Gaussian-elimination
 * path:
 *
 *   coefficient = Σ_{i=0}^{n-2} v[i+1]·v[i]  /  Σ_{i=0}^{n-2} v[i]·v[i]
 *
 * `populationStdev` matches the library's `stdev()` (population variance,
 * divide by n).
 */

/** Lag-1 least-squares AR coefficient. Returns NaN when the series is all zeros (caller falls back to 0, matching the original `coeffs[0] || 0`). */
export function arLeastSquareDegree1(values: number[]): number {
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < values.length - 1; i++) {
    numerator += values[i + 1]! * values[i]!;
    denominator += values[i]! * values[i]!;
  }
  return numerator / denominator;
}

/** Population standard deviation (divide by n), as in timeseries-analysis `stdev()`. */
export function populationStdev(values: number[]): number {
  let sum = 0;
  let n = 0;
  for (const value of values) {
    sum += value;
    n++;
  }
  const mean = sum / n;
  let squared = 0;
  for (const value of values) {
    squared += (value - mean) * (value - mean);
  }
  return Math.sqrt(squared / n);
}

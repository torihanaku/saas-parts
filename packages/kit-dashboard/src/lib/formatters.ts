/**
 * 数値を K / M / B 単位に短縮する
 * 例: 1234567 → "1.2M"
 */
export function formatCompact(value: number): string {
  if (Math.abs(value) >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return value.toLocaleString('ja-JP')
}

/**
 * 数値をカンマ区切りにする
 */
export function formatNumber(value: number, decimals = 0): string {
  return value.toLocaleString('ja-JP', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

/**
 * パーセント表示
 */
export function formatPercent(value: number, decimals = 1): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(decimals)}%`
}

/**
 * Date → "YYYY/MM/DD" 形式
 */
export function formatDate(date: Date): string {
  return date.toLocaleDateString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
}

/**
 * Date → "MM/DD" 形式（チャート軸ラベル用）
 */
export function formatDateShort(date: Date): string {
  return date.toLocaleDateString('ja-JP', { month: '2-digit', day: '2-digit' })
}

/**
 * 数値フォーマット選択（numberFormat設定に応じて書式を切り替え）
 * 'smart' モード: 値の大きさに応じて自動的に K / M / B を選択
 */
export function applyNumberFormat(value: number, format?: string): string {
  if (format === 'compact') return formatCompact(value)
  if (format === 'smart') return formatCompact(value)
  if (format === 'percent') return `${value.toFixed(1)}%`
  if (format === 'comma') return formatNumber(value, 0)
  return formatNumber(value, 0) // 'auto' or undefined → comma
}

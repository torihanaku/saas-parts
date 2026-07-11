/**
 * 日付・テキストのフォーマットユーティリティ
 *
 * 複数ページで重複していた formatDate / formatDateTime / truncate を統合。
 *
 * Ported from dev-dashboard-v2 `src/utils/format.ts`.
 * Changes from source: locale is a parameter (optional, default "ja-JP")
 * instead of hardcoded.
 */

const DEFAULT_LOCALE = 'ja-JP';

/** 日付を "YYYY/MM/DD" 形式（デフォルト ja-JP）で返す */
export function formatDate(iso: string, locale: string = DEFAULT_LOCALE): string {
  return new Date(iso).toLocaleDateString(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

/** 日付を "YYYY/MM/DD HH:mm" 形式（デフォルト ja-JP）で返す */
export function formatDateTime(iso: string, locale: string = DEFAULT_LOCALE): string {
  return new Date(iso).toLocaleDateString(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** 日付を "YYYY年 M月 D日" 形式（短縮月・デフォルト ja-JP）で返す */
export function formatDateShort(dateStr: string, locale: string = DEFAULT_LOCALE): string {
  return new Date(dateStr).toLocaleDateString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** テキストを maxLen で切り詰め、省略時は "..." を付与 */
export function truncate(text: string, maxLen: number): string {
  if (!text || text.length <= maxLen) return text || '';
  return text.slice(0, maxLen) + '...';
}

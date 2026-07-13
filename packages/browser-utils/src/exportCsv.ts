/**
 * Client-side CSV download with UTF-8 BOM + escaping + Blob.
 *
 * Ported from 実運用SaaS `src/lib/exportCsv.ts`.
 * Changes from source:
 *   - `rows[0]` guarded via a local variable to satisfy
 *     `noUncheckedIndexedAccess` (behaviour identical).
 *   - CSV formula injection ("CSV injection" / DDE) is neutralised: a value
 *     whose first character is a formula trigger (`= + - @`, tab, CR) is
 *     prefixed with a `'` so Excel/Sheets treats it as literal text instead
 *     of executing it. See OWASP "CSV Injection".
 *   - `\r` (CR) is now a quote trigger too, so a lone CR can no longer break
 *     a row.
 */

// Characters that make a spreadsheet interpret a cell as a formula/command.
// Includes tab (\t) and carriage return (\r) which some parsers also honour.
const FORMULA_TRIGGERS = new Set(['=', '+', '-', '@', '\t', '\r']);

/**
 * Neutralise a value against CSV formula injection.
 * Exported for reuse/testing. Returns the string unchanged unless it starts
 * with a formula-triggering character, in which case a leading `'` is added.
 */
export function neutralizeCsvValue(value: unknown): string {
  const s = String(value ?? '');
  if (s.length > 0 && FORMULA_TRIGGERS.has(s[0]!)) {
    return `'${s}`;
  }
  return s;
}

export function exportToCsv(filename: string, rows: Record<string, string | number | boolean | null | undefined>[]) {
  const first = rows[0];
  if (!first) return;
  const headers = Object.keys(first);
  const escape = (v: unknown) => {
    const s = neutralizeCsvValue(v);
    return s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };
  const csv = [
    headers.join(','),
    ...rows.map(row => headers.map(h => escape(row[h])).join(',')),
  ].join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filename}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

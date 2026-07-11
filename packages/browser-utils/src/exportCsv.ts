/**
 * Client-side CSV download with UTF-8 BOM + escaping + Blob.
 *
 * Ported from dev-dashboard-v2 `src/lib/exportCsv.ts`.
 * Changes from source: `rows[0]` guarded via a local variable to satisfy
 * `noUncheckedIndexedAccess` (behaviour identical).
 */
export function exportToCsv(filename: string, rows: Record<string, string | number | boolean | null | undefined>[]) {
  const first = rows[0];
  if (!first) return;
  const headers = Object.keys(first);
  const escape = (v: unknown) => {
    const s = String(v ?? '');
    return s.includes(',') || s.includes('"') || s.includes('\n')
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

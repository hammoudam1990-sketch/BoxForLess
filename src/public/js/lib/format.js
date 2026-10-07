// Display formatting. Pure — no DOM, no React.

/** A number with thousands separators; empty for null / undefined / ''. */
export const num = (n) => (n === null || n === undefined || n === '' ? '' : Number(n).toLocaleString());

/** A timestamp in the viewer's locale; the original text if it will not parse. */
export function formatDateTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? String(ts) : d.toLocaleString();
}

/** "2026-10-07T09:30:00" -> "2026-10-07 09:30". */
export const shortTimestamp = (ts) => String(ts || '').replace('T', ' ').slice(0, 16);

// Sales-target calculations and formatting. Pure — no DOM, no fetch.
// One implementation, shared by the Sales Manager, Sales Representative and Warehouse screens,
// so the dashboards never disagree about the same numbers.
//
// Eligibility is decided on the server (net sales come from Odoo invoices, less credit notes);
// these helpers only turn a target and an eligible-sales figure into what the screens show.

/** GH₵ formatting, two decimals; null/undefined is a dash, never a zero. */
export function formatGhs(value) {
  if (value === null || value === undefined || value === '' || Number.isNaN(Number(value))) return '—';
  return `GH₵ ${Number(value).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Remaining target = max(0, target − eligible sales). Null when no target is set. */
export function remainingTarget(target, eligibleSales) {
  if (!hasTarget(target)) return null;
  return Math.max(0, Number(target) - (Number(eligibleSales) || 0));
}

/** Achievement percentage. 0 when there is no target (never a division by zero). */
export function achievementPct(target, eligibleSales) {
  if (!hasTarget(target)) return 0;
  return ((Number(eligibleSales) || 0) / Number(target)) * 100;
}

/** True when a real, positive target exists. */
export function hasTarget(target) {
  return target !== null && target !== undefined && Number.isFinite(Number(target)) && Number(target) > 0;
}

/** Amount above target; 0 unless eligible sales exceed the target. Null when no target. */
export function overTargetBy(target, eligibleSales) {
  if (!hasTarget(target)) return null;
  return Math.max(0, (Number(eligibleSales) || 0) - Number(target));
}

/**
 * The display state of a target:
 *   NONE      — no target assigned yet
 *   REACHED   — eligible sales meet the target exactly
 *   EXCEEDED  — eligible sales are above the target (never capped for display)
 *   ON_TRACK  — at least two thirds achieved
 *   BEHIND    — below that
 */
export function targetStatus(target, eligibleSales) {
  if (!hasTarget(target)) return 'NONE';
  const pct = achievementPct(target, eligibleSales);
  if (pct > 100) return 'EXCEEDED';
  if (pct === 100) return 'REACHED';
  return pct >= 100 * (2 / 3) ? 'ON_TRACK' : 'BEHIND';
}

export const TARGET_STATUS_LABEL = Object.freeze({
  NONE: 'No target set',
  REACHED: 'Target reached',
  EXCEEDED: 'Above target',
  ON_TRACK: 'On track',
  BEHIND: 'Behind',
});

/** Badge tone for a status (matches .bfl-badge in css/dashboard-pro.css). */
export const TARGET_STATUS_TONE = Object.freeze({
  NONE: 'neutral',
  REACHED: 'success',
  EXCEEDED: 'success',
  ON_TRACK: '',
  BEHIND: 'warning',
});

/** A month key like "2026-10" as "October 2026". */
export function monthLabel(month) {
  const d = new Date(`${month}-01T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? String(month || '—')
    : d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

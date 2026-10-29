// The shared "sales target" panel: monthly target, eligible sales achieved, remaining balance,
// achievement percentage and a progress bar — identical on the Sales Manager's team view and the
// sales rep's own dashboard, so the two never disagree about the same numbers.
//
// The figures come from the server (net sales are Odoo invoices less credit notes; the target is
// the Sales Manager's). Nothing here decides eligibility, and nothing is stored locally.
import { h, setChildren } from './lib/dom.js';
import {
  formatGhs, remainingTarget, achievementPct, overTargetBy, targetStatus,
  TARGET_STATUS_LABEL, TARGET_STATUS_TONE, hasTarget,
} from './lib/targets.js';

const badge = (status) => h('span', { class: `bfl-badge ${TARGET_STATUS_TONE[status]}`.trim() }, TARGET_STATUS_LABEL[status]);

/** A status badge for one target + eligible-sales pair. */
export function targetBadge(target, sales) {
  return badge(targetStatus(target, Number(sales) || 0));
}

const stat = (label, value, over = false) => h('div', { class: 'bfl-target-stat' },
  h('span', null, label), h('b', over ? { class: 'over' } : null, value));

/**
 * A target progress block for one target + one eligible-sales figure.
 * @param {{ target: number|null, sales: number|null, context?: string }} data
 * @returns {HTMLElement}
 */
export function targetProgress({ target, sales, context = '' }) {
  const achieved = Number(sales) || 0;
  const status = targetStatus(target, achieved);
  const pct = achievementPct(target, achieved);
  const remaining = remainingTarget(target, achieved);
  const over = overTargetBy(target, achieved);

  if (status === 'NONE') {
    return h('div', null,
      h('div', { class: 'bfl-target-grid' }, stat('Eligible sales achieved', formatGhs(achieved))),
      h('p', { class: 'bfl-note' },
        h('p', null, h('b', null, 'No monthly target is set yet.')),
        h('p', null, context || 'The Sales Manager sets targets on the monthly reports screen.')));
  }

  const reached = status === 'REACHED' || status === 'EXCEEDED';
  return h('div', null,
    h('div', { class: 'bfl-target-grid' },
      stat('Monthly target', formatGhs(target)),
      stat('Eligible sales achieved', formatGhs(achieved)),
      stat('Remaining target', formatGhs(remaining)),
      over > 0 ? stat('Above target', formatGhs(over), true) : stat('Achievement', `${pct.toFixed(1)}%`)),
    h('div', {
      class: `bfl-progress${reached ? ' reached' : status === 'BEHIND' ? ' behind' : ''}`,
      role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100',
      'aria-valuenow': String(Math.min(100, Math.round(pct))),
      'aria-label': `Target achievement ${pct.toFixed(1)} percent`,
    }, h('i', { style: { width: `${Math.min(100, pct)}%` } })),
    h('p', { class: 'bfl-panel-sub', style: { margin: '8px 0 0' } },
      `${pct.toFixed(1)}% of the monthly target achieved`, reached ? ' — ' : '', reached ? TARGET_STATUS_LABEL[status] : ''));
}

/**
 * A full panel with heading, status badge and the progress block.
 * @param {{ title: string, subtitle?: string, target: number|null, sales: number|null, context?: string }} options
 */
export function targetPanel({ title, subtitle = '', target, sales, context = '' }) {
  const status = targetStatus(target, Number(sales) || 0);
  return h('section', { class: 'bfl-panel', 'aria-label': title },
    h('div', { class: 'bfl-panel-head' },
      h('div', null, h('h2', null, title), subtitle ? h('p', null, subtitle) : null),
      badge(status)),
    targetProgress({ target, sales, context }));
}

/** A loading placeholder the shape of the target panel. */
export function targetSkeleton() {
  return h('div', { class: 'bfl-skeleton', role: 'status', 'aria-label': 'Loading target' }, h('i'), h('i'), h('i'));
}

/** One row of a team target table: name, target, achieved, remaining, % and a progress bar. */
export function teamTargetRow({ name, target, sales, extraCells = [] }) {
  const achieved = Number(sales) || 0;
  const status = targetStatus(target, achieved);
  const pct = achievementPct(target, achieved);
  const remaining = remainingTarget(target, achieved);
  return h('tr', null,
    h('td', { class: 'primary-text' }, name),
    h('td', { class: 'num' }, hasTarget(target) ? formatGhs(target) : '—'),
    h('td', { class: 'num' }, formatGhs(achieved)),
    h('td', { class: 'num' }, remaining === null ? '—' : formatGhs(remaining)),
    h('td', { class: 'num' }, hasTarget(target) ? `${pct.toFixed(1)}%` : '—'),
    ...extraCells,
    h('td', null,
      h('div', { class: `bfl-progress${status === 'REACHED' || status === 'EXCEEDED' ? ' reached' : status === 'BEHIND' ? ' behind' : ''}`, 'aria-hidden': 'true' },
        h('i', { style: { width: `${Math.min(100, pct)}%` } })),
      h('div', { style: { marginTop: '5px' } }, badge(status))));
}

export { setChildren };

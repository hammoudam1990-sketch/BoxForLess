// Pages for menu items whose screens arrive in later phases of the plan, and the Categories page.
// Each "soon" page says what it will do and which phase builds it — no invented data.
import { esc, num } from './api.js';

const SOON = {
  quotations: {
    title: 'Quotations', phase: 'Phase 4 · Orders to Odoo',
    lead: 'Every customer order goes to Odoo as a draft quotation for the Sales Manager to approve.',
    points: [
      'Each order lands in Odoo as a draft quotation, with the BFL reference on it.',
      'The customer sees the same Odoo number, for example S00456, on their Orders page.',
      'Status is read back from Odoo: waiting for approval, approved, dispatched, invoiced, paid.',
      'BFL never confirms, sends or cancels an order. A person approves every one in Odoo.',
    ],
    link: ['#/requests', 'Open today\'s orders (requests)'],
  },
  visibility: {
    title: 'Product Visibility', phase: 'Phase 2 · Accounts and visibility rules (S02)',
    lead: 'Hide products by brand, category or product for one customer or a group.',
    points: [
      'Rules are enforced on the server for every list, search, count, product page and order line.',
      'A preview shows exactly what that customer will see.',
      'Every change is logged.',
    ],
    link: ['#/products', 'Open the Product Master'],
  },
  stock: {
    title: 'Stock & Expiry', phase: 'Phase 7 · Warehouse expiry (S03, S04)',
    lead: 'Every lot gets an expiry band, an action and an owner.',
    points: [
      'Lots by band: expired, critical, warning and early warning, set per category.',
      'Actions: move to clearance, push through sales reps, return to supplier, donate or write off.',
      'A "Check these entries" list for expiry dates that look like typing mistakes.',
      'Returns to classify: damaged, expired or other.',
    ],
    link: ['#/products', 'See stock levels in the Product Master'],
  },
  invoices: {
    title: 'Invoices', phase: 'Phase 5 · Credit check and balance',
    lead: 'Invoices are read from Odoo. BFL never creates or changes one.',
    points: ['Open invoices per customer, with the order number they belong to.', 'Every figure comes from Odoo, never calculated by BFL.'],
  },
  payments: {
    title: 'Payments', phase: 'Phase 6 · Notifications (S07 Payments due)',
    lead: 'Payments are recorded by Finance in Odoo; BFL reminds customers on their own schedule.',
    points: [
      'Due this week, overdue, and reminders sent.',
      'Each credit customer\'s reminder schedule: invoice due date, weekly or monthly.',
      'Only going over the credit limit blocks new orders. Overdue invoices trigger reminders.',
    ],
  },
  credit: {
    title: 'Credit & Balances', phase: 'Phase 5 · Credit check and balance',
    lead: 'Available credit = credit limit − amount owed − open orders not yet invoiced.',
    points: [
      'Credit limits are set in Odoo and read by BFL, never edited here.',
      'An order that would go over the available credit cannot be sent.',
      'Cash customers have no credit, balance or reminders.',
    ],
  },
  users: {
    title: 'Users & Roles', phase: 'Phase 2 · Accounts, sales reps',
    lead: 'Staff, sales reps and customer accounts, each seeing only what their role allows.',
    points: ['Sales reps see only the customers assigned to them in Odoo.', 'Company-wide reports go to managers only.'],
  },
  settings: {
    title: 'Settings', phase: 'Phase 1 onward',
    lead: 'Platform settings such as expiry warning bands per category and the clearance location.',
    points: ['Changed by Operations; every change is logged.'],
  },
  sync: {
    title: 'Sync Logs', phase: 'Phase 1 · Read from Odoo (S05 Sync health)',
    lead: 'Today the data comes from the daily Odoo Excel export. The live sync replaces it in Phase 1.',
    points: [
      'Last successful sync per data type: products, stock, customers, invoices, orders.',
      'The outbox: quotations and new customers pending, sent and failed, with Retry.',
      'Alerts before staff or customers notice a problem.',
    ],
    link: ['#/imports', 'Open the import history'],
  },
};

const ARROW = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';

export function renderComingSoon(view, key) {
  const page = SOON[key];
  if (!page) { location.hash = '#/dashboard'; return; }
  view.innerHTML = `
    <section class="ad-card ad-soon">
      <span class="ad-soon-tag">Coming in ${esc(page.phase)}</span>
      <h1>${esc(page.title)}</h1>
      <p>${esc(page.lead)}</p>
      <ul>${page.points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
      ${page.link ? `<a class="ad-btn-row" href="${page.link[0]}">${esc(page.link[1])} ${ARROW}</a>` : ''}
    </section>`;
}

/** Categories: the Odoo category tree as the catalogue sees it, with product counts. */
export async function renderCategories(view) {
  const res = await fetch('/api/catalog/categories?view=full');
  const { items = [] } = res.ok ? await res.json() : {};
  const tops = items.filter((c) => c.level === 1);
  const subsOf = (top) => items.filter((c) => c.level === 2 && c.path.startsWith(`${top.path} / `));
  view.innerHTML = `
    <div class="ad-head">
      <div><h1>Categories</h1><p>${num(tops.length)} top-level categories from Odoo, with active product counts. Categories are changed in Odoo, never here.</p></div>
    </div>
    ${tops.length ? `<div class="ad-cat-grid">${tops.map((t) => `
      <section class="ad-cat">
        <b>${esc(t.name)}</b><span>${num(t.count)} products</span>
        ${subsOf(t).length ? `<ul>${subsOf(t).map((s) => `<li><span>${esc(s.name)}</span><span>${num(s.count)}</span></li>`).join('')}</ul>` : ''}
      </section>`).join('')}</div>` : '<div class="ad-card"><p class="ad-empty">No categories yet. Run a product import.</p></div>'}`;
}

// SAMPLE figures for the signed-in customer screens: prices per carton, the account overview,
// orders and invoices. None of this exists yet — prices arrive with Odoo price classes in Phase 3,
// orders in Phase 4, credit and balances in Phase 5 — so the screens are built against these.
//
// Rules kept even for samples:
//   - shown only to a signed-in, approved customer (never to a visitor)
//   - always marked as sample on screen (see SAMPLE_NOTE and the "Sample" tags)
//   - deterministic, so the same product always shows the same sample price
//
// When the real data arrives, replace these functions with calls to the server and delete the file.
import { accounts } from '../lib/local-accounts.js';

export const SAMPLE_NOTE = 'Sample figures: prices, credit and orders shown here are examples until Box for Less connects to Odoo.';

/** The signed-in customer, or null for a visitor. */
export const currentCustomer = () => accounts().currentAccount();

/** Small stable hash of a string, for repeatable sample numbers. */
function hash(text) {
  let n = 2166136261;
  for (const ch of String(text)) { n ^= ch.codePointAt(0); n = Math.imul(n, 16777619); }
  return n >>> 0;
}

/** Sample price per carton in GHS, or null when nobody is signed in. */
export function samplePrice(product) {
  if (!currentCustomer()) return null;
  return 40 + (hash(product.id || product.barcode || product.name) % 80) * 5;   // GHS 40 … 435
}

export const formatGhs = (amount) => `GH₵ ${Number(amount).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * The account overview. Credit customers: available credit = credit limit − amount owed − open
 * orders not yet invoiced (the rule from the plan). Cash customers have no credit at all.
 */
export function sampleAccount(account = currentCustomer()) {
  if (!account) return null;
  if (account.type === 'cash') return { type: 'cash' };
  const creditLimit = 10000;
  const amountOwed = 6300;
  const openOrders = 1200;
  return { type: 'credit', creditLimit, amountOwed, openOrders, available: creditLimit - amountOwed - openOrders, overdue: 850 };
}

export const ORDER_STATUS = {
  received: { label: 'Received', tone: 'grey' },
  pending: { label: 'Pending Approval', tone: 'amber' },
  approved: { label: 'Approved', tone: 'green' },
  dispatched: { label: 'Dispatched', tone: 'blue' },
  delivered: { label: 'Delivered', tone: 'blue' },
  invoiced: { label: 'Invoiced', tone: 'purple' },
  paid: { label: 'Paid', tone: 'green' },
};

const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString(); };

/** Sample orders, newest first. */
export function sampleOrders() {
  if (!currentCustomer()) return [];
  return [
    { ref: 'BFL-2026-000123', odoo: 'S00456', at: daysAgo(1), status: 'pending', cartons: 12, lines: 4, amount: 1240 },
    { ref: 'BFL-2026-000122', odoo: 'S00441', at: daysAgo(6), status: 'approved', cartons: 8, lines: 3, amount: 980 },
    { ref: 'BFL-2026-000121', odoo: 'S00430', at: daysAgo(14), status: 'delivered', cartons: 6, lines: 2, amount: 750 },
    { ref: 'BFL-2026-000120', odoo: 'S00412', at: daysAgo(22), status: 'invoiced', cartons: 14, lines: 5, amount: 1560 },
    { ref: 'BFL-2026-000118', odoo: 'S00397', at: daysAgo(35), status: 'paid', cartons: 10, lines: 4, amount: 1310 },
  ];
}

/** Sample invoices for a credit customer (cash customers have none on BFL). */
export function sampleInvoices() {
  const account = sampleAccount();
  if (!account || account.type !== 'credit') return [];
  return [
    { ref: 'INV/2026/00231', order: 'S00412', at: daysAgo(20), due: daysAgo(-10), amount: 1560, open: 1560, status: 'open' },
    { ref: 'INV/2026/00214', order: 'S00397', at: daysAgo(33), due: daysAgo(3), amount: 1310, open: 850, status: 'overdue' },
    { ref: 'INV/2026/00198', order: 'S00380', at: daysAgo(48), due: daysAgo(18), amount: 2240, open: 0, status: 'paid' },
  ];
}

export const formatDate = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

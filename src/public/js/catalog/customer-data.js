// The signed-in customer's own figures for the account pages (home, orders, balance, invoices, settings),
// read from the server. It replaces the client-side sample figures the first version of these pages used:
// the data now comes from /api/catalog (the customer's own session only; nothing here can name another customer).
//
// The pages read these synchronously, so the app loads them first (`loadCustomerData`) and reloads them whenever an
// account page opens. Until Odoo is connected the server fills them from the Sample Odoo stand-in, and the pages
// say so (SAMPLE_NOTE).
import { getJSON } from './http.js';
import { setSession, refreshOffers } from './prices.js';

export const SAMPLE_NOTE = 'Sample figures: Odoo is not connected yet, so orders, invoices and balances come from a stand-in for Odoo.';

export const ORDER_STATUS = {
  received: { label: 'Received', tone: 'grey' },
  pending: { label: 'Pending Approval', tone: 'amber' },
  approved: { label: 'Approved', tone: 'green' },
  dispatched: { label: 'Dispatched', tone: 'blue' },
  delivered: { label: 'Delivered', tone: 'blue' },
  invoiced: { label: 'Invoiced', tone: 'purple' },
  paid: { label: 'Paid', tone: 'green' },
  cancelled: { label: 'Cancelled', tone: 'red' },
};
// the server's order states -> the page's status keys
const STATUS_KEY = {
  RECEIVED: 'received', WAITING_FOR_APPROVAL: 'pending', APPROVED: 'approved', DISPATCHED: 'dispatched',
  INVOICED: 'invoiced', PAID: 'paid', CANCELLED: 'cancelled',
};

const empty = () => ({ customer: null, account: null, orders: [] });
let state = empty();

const todayIso = () => new Date().toISOString().slice(0, 10);

function shapeInvoice(i) {
  const open = Number(i.amountDue || 0);
  const status = open <= 0 ? 'paid' : (i.dueDate && i.dueDate < todayIso() ? 'overdue' : 'open');
  return { ref: i.number, order: i.orderNumber || '—', at: i.invoiceDate, due: i.dueDate, amount: i.amount, open, status, payBy: i.payBy || null };
}
function shapeOrder(o) {
  const items = (o.items || []).map((x) => ({ barcode: x.barcode, name: x.name, cartons: x.cartons, discountedCartons: x.discountedCartons || 0, discountPct: x.discountPct || null, bestBefore: x.bestBefore || null }));
  return {
    ref: o.reference, odoo: o.odooNumber || '—', at: o.placedAt, status: STATUS_KEY[o.status] || 'received',
    cartons: items.reduce((n, x) => n + x.cartons, 0), lines: items.length, amount: o.total ?? null, items, hint: o.hint || '',
  };
}

/** Ask the server who is signed in and, for a customer, their account and orders. Safe to call again at any time. */
export async function loadCustomerData() {
  let access = null;
  try { access = await getJSON('/api/catalog/access'); } catch { /* offline or not signed in: a visitor */ }
  if (!access || !access.authenticated) { state = empty(); setSession(null); return state; }
  const [account, orders, profile] = await Promise.all([
    getJSON('/api/catalog/account').catch(() => null),
    getJSON('/api/catalog/orders').catch(() => ({ orders: [] })),
    getJSON('/api/catalog/profile').catch(() => null),
  ]);
  const customer = {
    customerId: profile?.customerId || null,
    customerClass: profile?.customerClass || null,
    company: profile?.name || access.customer.name,
    address: profile?.deliveryAddress || access.customer.deliveryAddress || '',
    phone: profile?.phone || '',
    email: profile?.email || '',
    contact: profile?.salesperson ? `Assigned Rep: ${profile.salesperson}` : '',
    viaPassword: Boolean(profile?.viaPassword),
  };
  customer.type = account && account.type === 'CASH' ? 'cash' : 'credit';
  state = { customer, account, orders: (orders.orders || []).map(shapeOrder) };
  setSession({ name: customer.company });
  refreshOffers();
  return state;
}

/** The signed-in customer { company, address, type }, or null for a visitor. */
export const currentCustomer = () => state.customer;

/** Credit position for a credit customer (limit may be null: Odoo has not given us one), or { type: 'cash' }. */
export function accountSummary() {
  const { customer, account } = state;
  if (!customer || !account) return customer ? { type: customer.type } : null;
  if (account.type === 'CASH') return { type: 'cash' };
  return {
    type: 'credit', creditLimit: account.creditLimit, amountOwed: account.amountOwed, openOrders: account.openOrders,
    available: account.availableCredit, overdue: account.overdue,
  };
}

/** The customer's orders, newest first. */
export const orderList = () => state.orders;

/** The customer's invoices (a cash customer has none on BFL), newest first. */
export function invoiceList() {
  const { account } = state;
  return account && account.type === 'CREDIT' ? (account.invoices || []).map(shapeInvoice) : [];
}

export const formatGhs = (amount) => `GHS ${Number(amount).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const formatDate = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/** Sign out here and at the server, then back to the front door. */
export async function signOutCustomer() {
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  state = empty();
  location.assign('/');
}

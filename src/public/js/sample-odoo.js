// Staff screen: Sample Odoo — a stand-in for what happens in ODOO to an order.
//
// In the real system the Sales Manager confirms the quotation in Odoo, the warehouse validates the
// delivery there, Finance posts the invoice and records the payment there, and BFL just reads the
// result. Until that connection exists, this screen lets the owner play those people so the whole
// journey — and what the customer sees at each step — can be tested. It disappears (the server
// answers 404) once BFL_ODOO_CONNECTED=1.
//
// Built once. The credit-limit field is typed into, so the page is never rebuilt while it holds
// focus: only the tables around it are refreshed.
import { api, toast } from './api.js';
import { h, setChildren } from './lib/dom.js';

const money = (n) => (n === null || n === undefined ? '—' : `GHS ${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—');

const STATE_LABEL = {
  RECEIVED: 'Received', WAITING_FOR_APPROVAL: 'Waiting for approval', APPROVED: 'Approved',
  DISPATCHED: 'Dispatched', INVOICED: 'Invoiced', PAID: 'Paid', CANCELLED: 'Cancelled',
};
// who does each step in Odoo, and the button wording
const STEP = {
  send: ['Send quotation to Odoo', 'The BFL outbox worker'],
  confirm: ['Confirm quotation', 'The Sales Manager, in Odoo'],
  deliver: ['Validate delivery', 'The warehouse, after loading'],
  invoice: ['Post invoice', 'Finance, in Odoo'],
  pay: ['Record payment', 'Finance, in Odoo'],
  cancel: ['Cancel', 'The Sales Manager, in Odoo'],
};

export async function renderSampleOdoo(view) {
  const orders = h('tbody');
  const invoices = h('tbody');
  const finance = h('tbody');
  const pending = h('p', { class: 'muted' });
  const empty = h('p', { class: 'muted hidden' }, 'No orders yet. Submit a request in the catalogue as a customer and it appears here.');

  const act = async (fn) => {
    try { await fn(); await load(); } catch (e) { toast(e.message, 'err'); await load(); }
  };

  function orderRow(o) {
    return h('tr', null,
      h('td', null, h('b', null, o.reference), h('div', { class: 'muted' }, o.odooNumber || 'no Odoo number yet')),
      h('td', null, o.customer || '—', o.customerType === 'CASH' ? h('div', { class: 'muted' }, 'cash customer') : null),
      h('td', null, h('span', { class: 'badge' }, STATE_LABEL[o.state] || o.state)),
      h('td', { class: 'num' }, o.amountTotal === null ? '—' : money(o.amountTotal)),
      h('td', { class: 'muted' }, when(o.updatedAt)),
      h('td', { class: 'nowrap' }, o.next.map((step) => h('button', {
        type: 'button', class: step === 'cancel' ? 'danger' : (step === o.next[0] ? '' : 'secondary'), title: STEP[step][1],
        onClick: () => act(() => api.sampleOdooStep(o.id, step)),
      }, STEP[step][0]))));
  }

  function invoiceRow(i) {
    return h('tr', null,
      h('td', null, h('b', null, i.number)), h('td', null, i.customer),
      h('td', { class: 'num' }, money(i.amount)), h('td', { class: 'num' }, money(i.amountDue)),
      h('td', null, i.dueDate), h('td', null, h('span', { class: 'badge' }, i.state)),
      h('td', null, i.state === 'OPEN'
        ? h('button', { type: 'button', class: 'secondary', onClick: () => act(() => api.sampleOdooAge(i.id)) }, 'Make overdue') : null));
  }

  function financeRow(f) {
    const input = h('input', { type: 'number', min: '0', step: '100', inputmode: 'decimal', 'aria-label': `Credit limit for ${f.customer}`, value: f.creditLimit ?? '' });
    return h('tr', null,
      h('td', null, h('b', null, f.customer)),
      h('td', null, input, ' ',
        h('button', { type: 'button', class: 'secondary', onClick: () => act(() => api.sampleOdooCreditLimit(f.customerId, input.value.trim())) }, 'Set limit')),
      h('td', { class: 'num' }, money(f.amountOwed)),
      h('td', { class: 'num' }, money(f.openOrders)),
      h('td', { class: `num${f.available !== null && f.available <= 0 ? ' err' : ''}` }, f.available === null ? 'not checked' : money(f.available)),
      h('td', { class: `num${f.overdue > 0 ? ' err' : ''}` }, money(f.overdue)));
  }

  // Returns: the warehouse receives goods back into quarantine, Finance issues the credit note
  const retPick = h('select', { 'aria-label': 'What is being returned' }, h('option', { value: '' }, 'Choose…'));
  const retQty = h('input', { type: 'number', min: '1', step: '1', inputmode: 'numeric', 'aria-label': 'Cartons returned', value: '1', style: { width: '90px' } });
  const retBody = h('tbody');
  const historyBtn = h('button', { type: 'button', class: 'secondary', onClick: seedHistory }, 'Load fourteen months of sample history');
  const historyNote = h('span', { class: 'muted' });
  async function receiveReturn() {
    if (!retPick.value) { toast('Choose what is being returned.', 'err'); return; }
    await act(() => api.sampleCreateReturn({ optionId: retPick.value, cartons: Number(retQty.value) }));
    toast('Return received into quarantine. The warehouse can now classify it.', 'ok');
  }
  async function seedHistory() {
    historyBtn.disabled = true;
    try { const r = await api.sampleSeedHistory(); toast(`Loaded ${r.orders} sample orders for ${r.customers} customers.`, 'ok'); await load(); } catch (e) { toast(e.message, 'err'); } finally { historyBtn.disabled = false; }
  }

  setChildren(view,
    h('h1', null, 'Sample Odoo'),
    h('div', { class: 'notice' },
      h('b', null, 'This stands in for Odoo. '),
      'In the real system these steps are done in Odoo by the people named on each button; BFL only reads the result. ',
      'Use it to test what a customer sees at every step of an order. Every number is a sample.'),
    h('div', { class: 'card' },
      h('h2', null, 'Orders'),
      pending,
      h('div', { class: 'exp-wrap' },
        h('table', null,
          h('thead', null, h('tr', null, ['Order', 'Customer', 'Where it stands', 'Invoiced', 'Updated', 'Next step in Odoo'].map((t) => h('th', null, t)))),
          orders)),
      empty),
    h('div', { class: 'card' },
      h('h2', null, 'Returns and credit notes'),
      h('p', { class: 'muted' }, 'In Odoo the warehouse receives a return into a quarantine location and Finance issues the credit note. BFL reads both; the reason is then recorded on the Returns screen.'),
      h('div', { class: 'controls' }, retPick, retQty, h('button', { type: 'button', onClick: receiveReturn }, 'Receive return into quarantine')),
      h('div', { class: 'exp-wrap' }, h('table', null, h('thead', null, h('tr', null, ['Return', 'Customer', 'Received', 'Cartons', 'Credit note', ''].map((t) => h('th', null, t)))), retBody))),
    h('div', { class: 'card' },
      h('h2', null, 'Sample history for the monthly reports'),
      h('p', { class: 'muted' }, 'Fills fourteen months of made-up orders, invoices, payments and month-end stock for your first credit customers, so every monthly report has last month and last year to compare with. Marked SAMPLE; loads once.'),
      h('div', { class: 'controls' }, historyBtn, historyNote)),
    h('div', { class: 'card' },
      h('h2', null, 'Invoices'),
      h('div', { class: 'exp-wrap' },
        h('table', null,
          h('thead', null, h('tr', null, ['Invoice', 'Customer', 'Amount', 'Still due', 'Due date', 'Status', ''].map((t) => h('th', null, t)))),
          invoices))),
    h('div', { class: 'card' },
      h('h2', null, 'Customer accounts'),
      h('p', { class: 'muted' }, 'A credit customer appears here once they have an order. Until a limit is set they are not credit-checked. In Odoo the limit is set by Finance or the Sales Manager. Available = limit − owes − open orders; a request that would go over it is refused.'),
      h('div', { class: 'exp-wrap' },
        h('table', null,
          h('thead', null, h('tr', null, ['Customer', 'Credit limit', 'Owes', 'Open orders', 'Available', 'Overdue'].map((t) => h('th', null, t)))),
          finance))));

  let editing = false;
  view.addEventListener('focusin', (e) => { editing = e.target.tagName === 'INPUT'; });
  view.addEventListener('focusout', () => { editing = false; });

  async function load() {
    let data;
    try { data = await api.sampleOdoo(); } catch (e) { toast(e.message, 'err'); return; }
    setChildren(orders, data.orders.map(orderRow));
    setChildren(invoices, data.invoices.map(invoiceRow));
    // the limit fields are typed into: leave them alone while one has focus
    if (!editing) setChildren(finance, data.finance.map(financeRow));
    empty.classList.toggle('hidden', data.orders.length > 0);
    setChildren(retBody, data.returns.map((r) => h('tr', null, h('td', null, h('b', null, r.number)), h('td', null, r.customer), h('td', null, r.receivedOn), h('td', { class: 'num' }, String(r.cartons)),
      h('td', null, r.creditNote || '—'),
      h('td', null, r.creditNote ? null : h('button', { type: 'button', class: 'secondary', onClick: () => act(() => api.sampleReturnCreditNote(r.id)) }, 'Issue credit note')))));
    try {
      const o = await api.sampleReturnOptions();
      const keep = retPick.value;
      setChildren(retPick, [h('option', { value: '' }, 'Choose what is being returned…'), ...o.options.map((x) => h('option', { value: x.id, selected: x.id === keep }, x.label))]);
      historyBtn.disabled = o.historyLoaded;
      historyNote.textContent = o.historyLoaded ? 'Already loaded.' : '';
    } catch { /* the rest of the screen still works */ }
    pending.textContent = `Waiting in the outbox to go to Odoo: ${data.outbox.summary.PENDING} · sent: ${data.outbox.summary.SENT}`;
  }

  await load();
  clearInterval(view.sampleOdooTimer);
  view.sampleOdooTimer = setInterval(() => {
    if (!view.isConnected || location.hash.split('/')[1] !== 'sample-odoo') { clearInterval(view.sampleOdooTimer); return; }
    load();
  }, 10000);
}

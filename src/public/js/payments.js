// Staff screen S07 — Payments due.
//
// What is due this week and what is overdue, the reminders that were composed (and whether a person
// has sent them), and each credit customer's payment schedule. The platform REMINDS; it does not
// collect: customers pay as they do today and Finance records the payment in Odoo, which stops the
// reminders. No email, SMS or WhatsApp provider is connected yet, so a reminder is a message ready to
// copy; "Mark sent" records that a person sent it.
//
// Built once; the schedule fields are typed into, so the list of schedules is left alone while one of
// its fields has focus.
import { api, toast } from './api.js';
import { h, setChildren } from './lib/dom.js';
import { mountPaymentDue } from './payment-due.js';

const money = (n) => `GHS ${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dayText = (iso) => (iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—');
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const KIND_TEXT = { BEFORE: 'Day before', DUE: 'Payment day', OVERDUE: 'Overdue' };
const STATUS_TEXT = { PENDING: 'Ready to send', SENT: 'Sent', NO_CONTACT: 'No contact on file' };

async function copy(text, button) {
  const original = button.textContent;
  let ok = false;
  try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); ok = true; } } catch { /* fall through */ }
  if (!ok) {
    const ta = h('textarea', { readonly: true, style: { position: 'fixed', top: '-1000px', opacity: '0' } });
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
  }
  button.textContent = ok ? '✓ Copied' : 'Select it by hand';
  setTimeout(() => { button.textContent = original; }, 1500);
}

export async function renderPayments(view) {
  const tiles = h('div', { class: 'exp-tiles' });
  const invoices = h('tbody');
  const reminders = h('div', { class: 'pay-reminders' });
  const schedules = h('tbody');
  const noInvoicesText = 'No open invoices. Invoices appear here once Odoo posts them (on the Sample Odoo screen for now).';
  const noInvoices = h('p', { class: 'muted hidden' }, noInvoicesText);
  const invSearch = h('input', {
    type: 'search', class: 'pay-search', placeholder: 'Search customer, invoice number, date or amount…', 'aria-label': 'Search open invoices',
    onInput: () => paintInvoices(),
  });
  const dueList = h('div', { class: 'pay-due-list' });
  const dueCard = h('div', { class: 'card' },
    h('h2', null, 'Order payment due dates'),
    h('p', { class: 'muted' }, 'Credit orders still without a due date. Choose a date for an order, then save. Changing a date later needs a reason. The date is kept in BFL and is not sent to Odoo.'),
    dueList);
  async function loadDue() {
    let r;
    try { r = await api.ordersAwaitingDueDate(); } catch (e) {
      if (e.status === 403) { dueCard.classList.add('hidden'); return; }
      setChildren(dueList, h('p', { class: 'pd-error' }, `Could not load orders: ${e.message}`)); return;
    }
    setChildren(dueList, r.items.length ? r.items.map((o) => {
      const panel = h('div', { class: 'pay-due-panel hidden' });
      const btn = h('button', { type: 'button', class: 'secondary', 'aria-expanded': 'false' }, 'Set due date');
      btn.addEventListener('click', () => {
        const open = panel.classList.toggle('hidden') === false;
        btn.setAttribute('aria-expanded', String(open));
        btn.textContent = open ? 'Close' : 'Set due date';
        if (open && !panel.children.length) mountPaymentDue(panel, o.requestId);
      });
      return h('div', { class: 'pay-due-item' },
        h('div', { class: 'pay-due-head' },
          h('div', null, h('b', null, o.customer), h('div', { class: 'muted' }, `${o.reference}${o.odooNumber ? ` · ${o.odooNumber}` : ''} · placed ${dayText(String(o.placedAt || '').slice(0, 10))}`)),
          h('div', { class: 'num' }, o.amount === null || o.amount === undefined ? '—' : money(o.amount)),
          btn),
        panel);
    }) : h('p', { class: 'muted' }, 'Every credit order has a due date.'));
  }
  const noReminders = h('p', { class: 'muted hidden' }, 'No reminders yet. They are composed the day before a payment day, on it, and every 7 days while an invoice stays unpaid.');
  const runBtn = h('button', { type: 'button', class: 'secondary', onClick: run }, 'Check for reminders now');
  const followUp20dBtn = h('button', { type: 'button', onClick: runFollowUp20d }, 'Generate 20+ Day Follow-Up Reminders');
  let onlyUnsettled20d = false;
  let allInvoicesCache = [];

  const filter20dBtn = h('button', {
    type: 'button',
    class: 'secondary',
    onClick: () => {
      onlyUnsettled20d = !onlyUnsettled20d;
      filter20dBtn.className = onlyUnsettled20d ? '' : 'secondary';
      filter20dBtn.textContent = onlyUnsettled20d ? '✓ Showing 20+ Days Unsettled Only (Show All)' : 'Filter: 20+ Days Unsettled Follow-Up';
      paintInvoices();
    },
  }, 'Filter: 20+ Days Unsettled Follow-Up');

  setChildren(view,
    h('h1', null, 'Payments due & Credit Follow-Up'),
    h('div', { class: 'notice' },
      h('b', null, 'The platform reminds; it does not collect. '),
      'Customers pay as they do today and Finance records the payment in Odoo, which stops the reminders. ',
      'Invoices unsettled for 20+ days since invoice date are highlighted for follow-up. ',
      'Only a credit customer is reminded, each message lists only their own open invoices, and a reminder never blocks an order — only the credit limit does.'),
    tiles,
    h('div', { class: 'card' },
      h('div', { style: 'display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:8px;' },
        h('h2', { style: 'margin:0;' }, 'Open invoices & 20-Day Follow-Up'),
        filter20dBtn),
      h('div', { class: 'controls' }, invSearch),
      h('div', { class: 'exp-wrap' },
        h('table', null,
          h('thead', null, h('tr', null, ['Customer', 'Invoice', 'Invoiced', 'Still due', 'Pay by', 'Where it stands / Follow-up', 'Schedule', 'Last reminder'].map((t) => h('th', { class: t === 'Still due' ? 'num' : null }, t)))),
          invoices)),
      noInvoices),
    dueCard,
    h('div', { class: 'card' },
      h('h2', null, 'Reminders'),
      h('p', { class: 'muted' }, 'No email, SMS or WhatsApp provider is connected yet. Copy a message, send it yourself, then tap Mark sent. Every reminder stays in this log.'),
      h('div', { class: 'controls' }, runBtn, followUp20dBtn),
      reminders, noReminders),
    h('div', { class: 'card' },
      h('h2', null, 'Payment schedules'),
      h('p', { class: 'muted' }, 'Set by the Sales Manager. The default is each invoice\'s own due date. A weekly or monthly schedule means every open invoice is expected on that day.'),
      h('div', { class: 'exp-wrap' },
        h('table', null,
          h('thead', null, h('tr', null, ['Customer', 'Schedule', ''].map((t) => h('th', null, t)))),
          schedules))));

  function tile(label, count, amount, tone) {
    return h('div', { class: `exp-tile ${tone}`, style: { cursor: 'default' } },
      h('span', { class: 'exp-tile-n' }, String(count)), h('span', { class: 'exp-tile-l' }, label), h('span', { class: 'exp-tile-v' }, amount === null ? '' : money(amount)));
  }

  function invoiceRow(i) {
    const stands = i.daysToPay < 0 ? `Overdue ${-i.daysToPay} day${i.daysToPay === -1 ? '' : 's'}` : i.daysToPay === 0 ? 'Due today' : `In ${i.daysToPay} day${i.daysToPay === 1 ? '' : 's'}`;
    return h('tr', i.unsettled20d ? { style: 'background:rgba(254, 242, 242, 0.55);' } : null,
      h('td', null, h('b', null, i.customer)),
      h('td', null, i.number),
      h('td', { class: 'muted' }, dayText(i.invoiceDate)),
      h('td', { class: 'num' }, money(i.amountDue)),
      h('td', null, dayText(i.payBy)),
      h('td', null,
        h('span', { class: `badge${i.bucket === 'OVERDUE' ? ' err' : ''}` }, stands),
        i.unsettled20d ? h('span', { class: 'badge warn', style: 'margin-left:6px;' }, `20+ days unsettled (${i.daysSinceInvoice}d)`) : null),
      h('td', { class: 'muted' }, i.schedule),
      h('td', { class: 'muted' }, dayText(i.lastReminder)));
  }

  function paintInvoices() {
    const q = invSearch.value.trim().toLowerCase();
    const hay = (i) => [i.customer, i.number, dayText(i.invoiceDate), dayText(i.payBy), i.amountDue, i.schedule].join(' ').toLowerCase();
    const list = allInvoicesCache
      .filter((i) => !onlyUnsettled20d || i.unsettled20d)
      .filter((i) => !q || hay(i).includes(q));
    setChildren(invoices, list.map(invoiceRow));
    noInvoices.textContent = q ? `No invoice matches “${invSearch.value.trim()}”.` : noInvoicesText;
    noInvoices.classList.toggle('hidden', list.length > 0);
  }

  function reminderCard(r) {
    const copyBtn = h('button', { type: 'button', class: 'secondary' }, 'Copy message');
    copyBtn.addEventListener('click', () => copy(`${r.subject}\n\n${r.body}`, copyBtn));
    return h('details', { class: 'pay-reminder' },
      h('summary', null,
        h('b', null, r.customer), ' · ', KIND_TEXT[r.kind] || r.kind, ' · ', dayText(r.remindOn), ' · ',
        `${r.invoiceCount} invoice${r.invoiceCount === 1 ? '' : 's'}, ${money(r.totalDue)} · `,
        h('span', { class: `badge${r.status === 'NO_CONTACT' ? ' err' : ''}` }, STATUS_TEXT[r.status] || r.status)),
      h('p', { class: 'muted' }, r.to ? `To: ${r.to}` : 'No email or phone number on file for this customer — add one, then send it by hand.', r.sentAt ? ` · sent ${new Date(r.sentAt).toLocaleString()}${r.sentBy ? ` by ${r.sentBy}` : ''}` : ''),
      h('pre', { class: 'pay-body' }, `${r.subject}\n\n${r.body}`),
      h('div', { class: 'controls' }, copyBtn,
        r.status === 'PENDING' ? h('button', { type: 'button', onClick: () => markSent(r.id) }, 'Mark sent') : null));
  }

  function scheduleRow(s) {
    const kind = h('select', { 'aria-label': `Schedule for ${s.customer}`, onChange: sync },
      [['DUE_DATE', "Each invoice's due date"], ['WEEKLY', 'Every week on…'], ['MONTHLY', 'Every month on the…']].map(([v, t]) => h('option', { value: v, selected: v === s.kind }, t)));
    const weekday = h('select', { 'aria-label': 'Day of the week' }, WEEKDAYS.map((d, i) => h('option', { value: String(i), selected: i === (s.weekday ?? 3) }, d)));
    const dom = h('input', { type: 'number', min: '1', max: '31', step: '1', inputmode: 'numeric', 'aria-label': 'Day of the month', value: s.dayOfMonth ?? 25, style: { width: '80px' } });
    const note = h('span', { class: 'muted' }, s.description);
    function sync() {
      weekday.hidden = kind.value !== 'WEEKLY';
      dom.hidden = kind.value !== 'MONTHLY';
    }
    sync();
    const save = h('button', {
      type: 'button', class: 'secondary', onClick: async () => {
        try {
          const r = await api.setPaymentSchedule(s.customerId, {
            kind: kind.value, weekday: kind.value === 'WEEKLY' ? Number(weekday.value) : undefined, dayOfMonth: kind.value === 'MONTHLY' ? Number(dom.value) : undefined,
          });
          note.textContent = `Saved — ${r.description}`;
          load();
        } catch (e) { toast(e.message, 'err'); }
      }
    }, 'Save');
    return h('tr', null, h('td', null, h('b', null, s.customer)), h('td', null, kind, ' ', weekday, ' ', dom, ' ', note), h('td', null, save));
  }

  async function markSent(id) {
    try { await api.markPaymentReminderSent(id); await load(); } catch (e) { toast(e.message, 'err'); }
  }

  async function run() {
    runBtn.disabled = true;
    try {
      const r = await api.runPaymentReminders();
      toast(r.created ? `${r.created} new reminder${r.created === 1 ? '' : 's'} composed.` : 'Nothing is due for a reminder today.', 'ok');
      await load();
    } catch (e) { toast(e.message, 'err'); } finally { runBtn.disabled = false; }
  }

  async function runFollowUp20d() {
    followUp20dBtn.disabled = true;
    try {
      const r = await api.runFollowUp20d({ days: 20 });
      toast(r.created ? `${r.created} new 20+ day follow-up reminder${r.created === 1 ? '' : 's'} composed.` : 'All 20+ day unsettled invoices already have today\'s follow-up reminder.', 'ok');
      await load();
    } catch (e) { toast(e.message, 'err'); } finally { followUp20dBtn.disabled = false; }
  }

  let editing = false;
  view.addEventListener('focusin', (e) => { editing = /^(INPUT|SELECT)$/.test(e.target.tagName); });
  view.addEventListener('focusout', () => { editing = false; });

  async function load() {
    let d;
    try { d = await api.payments(); } catch (e) { toast(e.message, 'err'); return; }
    allInvoicesCache = d.invoices || [];
    const u20 = d.summary.unsettled20d || { count: 0, amount: 0 };
    setChildren(tiles,
      tile('Overdue', d.summary.overdue.count, d.summary.overdue.amount, 'err'),
      tile('20+ days unsettled', u20.count, u20.amount, u20.count ? 'warn' : 'ok'),
      tile('Due this week', d.summary.thisWeek.count, d.summary.thisWeek.amount, 'warn'),
      tile('Later', d.summary.later.count, d.summary.later.amount, 'ok'),
      tile('Reminders ready to send', d.summary.remindersWaiting, null, 'info'));
    paintInvoices();
    setChildren(reminders, d.reminders.map(reminderCard));
    noReminders.classList.toggle('hidden', d.reminders.length > 0);
    if (!editing) setChildren(schedules, d.schedules.map(scheduleRow));
  }

  await load();
  loadDue();
}

// The payment due date panel on an order (staff): the Sales Manager sets, after the purchase, the date the customer is
// to pay by. Changing a date already set asks for a reason, and every change is listed. Server: domain/payment-due.js
// via /api/payments/orders/:requestId/due-date (Sales Manager and administrator only).
//
// The date field and the reason field are built once; only the summary and the history around them are repainted.
import { api, toast } from './api.js';
import { h, setChildren, toggleHidden } from './lib/dom.js';

const dateText = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—');
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

/** Mount the panel into `container` for one request. Returns { reload }. */
export function mountPaymentDue(container, requestId) {
  const summary = h('div', { class: 'pd-summary' });
  const date = h('input', { type: 'date', class: 'pd-date', 'aria-label': 'Payment due date', required: true });
  const reasonLabel = h('label', { class: 'pd-field hidden' }, h('span', null, 'Why is the date changing?'),
    h('input', { type: 'text', class: 'pd-reason', maxlength: '300', placeholder: 'e.g. agreed with the customer by phone' }));
  const reason = reasonLabel.querySelector('input');
  const save = h('button', { type: 'submit', class: 'pd-save' }, 'Save due date');
  const error = h('p', { class: 'pd-error hidden', role: 'alert' });
  const form = h('form', { class: 'pd-form hidden', onSubmit: submit },
    h('label', { class: 'pd-field' }, h('span', null, 'Pay by'), date), reasonLabel, save);
  const history = h('div', { class: 'pd-history' });
  setChildren(container,
    h('div', { class: 'section-title' }, 'Payment due date'),
    h('div', { class: 'card pd-card' },
      h('p', { class: 'muted pd-intro' }, 'The date this customer is to pay this order by. You set it after the purchase; payment reminders and the customer\'s "Pay by" date follow it. It stays in BFL and is not sent to Odoo.'),
      summary, form, error, history));

  let current = null;

  function paint(d) {
    current = d;
    if (!d.applies) {
      setChildren(summary, h('p', null, d.reason || 'A due date does not apply to this order.'));
      toggleHidden(form, true);
    } else {
      setChildren(summary, d.dueDate
        ? h('p', null, 'Pay by ', h('b', null, dateText(d.dueDate)), d.setBy ? ` — set by ${d.setBy}, ${when(d.setAt)}` : '')
        : h('p', { class: 'pd-missing' }, h('b', null, 'No due date yet.'), ' Set one so the customer knows when to pay.'));
      date.min = d.earliest;
      date.max = d.latest;
      if (!date.value || document.activeElement !== date) date.value = d.dueDate || '';
      toggleHidden(reasonLabel, !d.dueDate);
      save.textContent = d.dueDate ? 'Change due date' : 'Save due date';
      toggleHidden(form, false);
    }
    setChildren(history, d.history.length
      ? [h('p', { class: 'pd-history-title' }, 'History'),
        h('ul', { class: 'pd-history-list' }, d.history.map((x) => h('li', null,
          x.oldDate ? `${dateText(x.oldDate)} → ${dateText(x.newDate)}` : `Set to ${dateText(x.newDate)}`,
          h('span', { class: 'muted' }, ` · ${x.changedBy || 'Staff'}, ${when(x.changedAt)}${x.reason ? ` · “${x.reason}”` : ''}`))))]
      : null);
  }

  async function submit(e) {
    e.preventDefault();
    toggleHidden(error, true);
    if (!date.value) { error.textContent = 'Choose a date.'; toggleHidden(error, false); return; }
    if (current?.dueDate && date.value === current.dueDate) { error.textContent = 'That is already the due date.'; toggleHidden(error, false); return; }
    save.disabled = true;
    try {
      const d = await api.setPaymentDue(requestId, { dueDate: date.value, reason: reason.value });
      reason.value = '';
      paint(d);
      toast('Payment due date saved.');
    } catch (err) {
      error.textContent = err.message;
      toggleHidden(error, false);
    } finally { save.disabled = false; }
  }

  async function reload() {
    try { paint(await api.paymentDue(requestId)); } catch (err) {
      if (err.status === 403) { container.replaceChildren(); return; }   // not a role that sets due dates
      setChildren(summary, h('p', { class: 'pd-error' }, `Could not load the due date: ${err.message}`));
    }
  }
  reload();
  return { reload };
}

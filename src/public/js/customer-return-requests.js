// Review customer-submitted return requests. This is intentionally separate
// from the warehouse's Odoo-return classification screen.
import { api, toast } from './api.js';
import { h, setChildren } from './lib/dom.js';

const day = (iso) => (iso
  ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  : '—');

export async function renderCustomerReturnRequests(view) {
  const pending = h('div', { class: 'ret-list' });
  const history = h('div', { class: 'ret-list' });
  setChildren(view,
    h('h1', null, 'Customer Return Requests'),
    h('div', { class: 'notice' },
      h('b', null, 'Review only. '),
      'Approving or declining records your decision in Box for Less; it does not create an Odoo return, issue a credit, or move stock.'),
    h('div', { class: 'card' }, h('h2', null, 'Waiting for review'), pending),
    h('div', { class: 'card' }, h('h2', null, 'Reviewed requests'), history));

  async function load() {
    try {
      const { requests } = await api.customerReturnRequests();
      const rows = requests || [];
      setChildren(pending, rows.filter((request) => request.status === 'PENDING').map(requestCard));
      setChildren(history, rows.filter((request) => request.status !== 'PENDING').map(requestCard));
      if (!rows.some((request) => request.status === 'PENDING')) {
        setChildren(pending, h('p', { class: 'muted' }, 'No customer return requests are waiting for review.'));
      }
      if (!rows.some((request) => request.status !== 'PENDING')) {
        setChildren(history, h('p', { class: 'muted' }, 'No reviewed return requests yet.'));
      }
    } catch (error) {
      toast(error.message, 'err');
      setChildren(pending, h('p', { class: 'errbox' }, error.message));
    }
  }

  function requestCard(request) {
    const declineReason = h('textarea', {
      maxlength: '1000',
      rows: '3',
      placeholder: 'Required if you decline. Explain the decision for the customer.',
      'aria-label': `Reason for declining ${request.reference}`,
    });
    const message = h('p', { class: 'muted', role: 'status' });
    const decide = async (decision) => {
      if (decision === 'DECLINED' && !declineReason.value.trim()) {
        declineReason.setCustomValidity('Enter a reason so the customer understands the decision.');
        declineReason.reportValidity();
        return;
      }
      declineReason.setCustomValidity('');
      const buttons = controls.querySelectorAll('button');
      buttons.forEach((button) => { button.disabled = true; });
      try {
        await api.decideCustomerReturn(request.reference, {
          decision,
          declineReason: decision === 'DECLINED' ? declineReason.value : '',
        });
        await load();
      } catch (error) {
        message.textContent = error.message;
        buttons.forEach((button) => { button.disabled = false; });
      }
    };
    const controls = request.status === 'PENDING'
      ? h('div', { class: 'controls customer-return-review-controls' },
        declineReason,
        h('button', { type: 'button', class: 'btn', onClick: () => decide('APPROVED') }, 'Approve'),
        h('button', { type: 'button', class: 'btn danger', onClick: () => decide('DECLINED') }, 'Decline'),
        message)
      : h('div', { class: 'muted' },
        h('b', null, request.status === 'APPROVED' ? 'Approved' : 'Declined'),
        request.reviewedBy ? ` by ${request.reviewedBy}` : '',
        request.reviewedAt ? ` · ${day(request.reviewedAt)}` : '',
        request.status === 'DECLINED' ? h('p', null, h('b', null, 'Reason given to customer: '), request.declineReason) : null);

    return h('article', { class: 'ret-card' },
      h('div', { class: 'ret-top' },
        h('div', null, h('b', null, request.reference), ` · ${request.customerName}`),
        h('span', { class: `badge ${request.status === 'PENDING' ? 'warn' : request.status === 'APPROVED' ? 'ok' : 'err'}` }, request.status)),
      h('ul', { class: 'ret-lines' },
        h('li', null, `${request.cartons} carton${request.cartons === 1 ? '' : 's'} · ${request.productName}`),
        h('li', null, `Order ${request.orderReference}`)),
      h('p', null, h('b', null, 'Customer reason: '), request.reason),
      h('p', { class: 'muted' }, `Submitted ${day(request.createdAt)}`),
      controls);
  }

  await load();
}

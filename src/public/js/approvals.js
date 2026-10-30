// Staff screen: Approvals (part of S01) — the Sales Manager approves or turns down the discounts
// reps propose on shop visits, Finance's follow-up (the credit note), overdue visits per rep, and
// the returns that visits have expected. SAMPLE data until the Odoo deliveries sync exists.
//
// Each list is built into its own container; the reason / credit-note fields live inside the item
// they belong to, so a refresh after an action replaces items, never the page around them.
import { api, toast } from './api.js';
import { h, setChildren } from './lib/dom.js';

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const date = (iso) => (iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—');
const daysText = (d) => (d === null ? '' : d < 0 ? `expired ${plural(-d, 'day')} ago` : `${plural(d, 'day')} left`);

export async function renderApprovals(view) {
  const shelfBox = h('div');
  const pendingBox = h('div');
  const financeBox = h('div');
  const overdueBox = h('div');
  const returnsBox = h('div');
  const decidedBox = h('div');
  const counts = h('p', { class: 'muted', role: 'status' });

  setChildren(view,
    h('h1', null, 'Customer Discount'),
    h('div', { class: 'notice exp-banner' }, h('b', null, 'Shelf discounts & credit notes. '),
      'Review and decide on shelf discounts proposed by sales reps, track Finance credit note tasks, and monitor expected returns.'),
    counts,
    h('div', { class: 'card' }, h('h2', null, 'Set a discount for customer shelves'),
      h('p', { class: 'muted' }, 'Lots already on customers\' shelves that are close to expiry. Put a discount on a lot and every rep who visits a shop holding it sees it: when the customer\'s contact agrees to it (or to less), it is approved straight away and Finance gets the credit note task. A rep who proposes more than your discount still needs your approval below.'),
      shelfBox),
    h('div', { class: 'card' }, h('h2', null, 'Discounts waiting for your decision'),
      h('p', { class: 'muted' }, 'A rep proposes a discount after the customer\'s contact agrees to it. It is not final until you approve it. A rejection goes back to the rep with your reason.'),
      pendingBox),
    h('div', { class: 'card' }, h('h2', null, 'For Finance: credit notes to issue in Odoo'),
      h('p', { class: 'muted' }, 'Finance issues the credit note in Odoo. Enter its number here to close the alert (on the real system BFL finds it in the next sync).'),
      financeBox),
    h('div', { class: 'card' }, h('h2', null, 'Visits per rep'), overdueBox),
    h('div', { class: 'card' }, h('h2', null, 'Returns expected'),
      h('p', { class: 'muted' }, 'Lots where the customer refused a discount. The return itself is handled in Odoo.'), returnsBox),
    h('div', { class: 'card' }, h('h2', null, 'Decided'), decidedBox));

  async function load() {
    let d;
    try { d = await api.shelfApprovals(); } catch (e) { toast(e.message, 'err'); return; }
    counts.textContent = `${plural(d.pending.length, 'discount')} to decide · ${plural(d.financeTasks.length, 'credit note')} to issue`;
    await loadShelfLots();
    setChildren(pendingBox, d.pending.length ? d.pending.map((p) => pendingItem(p)) : h('p', { class: 'muted' }, 'Nothing waiting.'));
    setChildren(financeBox, d.financeTasks.length ? d.financeTasks.map((p) => financeItem(p)) : h('p', { class: 'muted' }, 'No credit notes to issue.'));
    setChildren(overdueBox, table(['Rep', 'Lots waiting for a visit', 'Overdue'],
      d.overdueByRep.map((r) => [r.rep, String(r.openAlerts), r.overdue ? h('span', { class: 'pill err' }, String(r.overdue)) : '0'])));
    setChildren(returnsBox, d.returnsExpected.length
      ? table(['Customer', 'Product', 'Lot', 'Expires', 'Cartons', 'Return reason', 'Rep'],
        d.returnsExpected.map((r) => [
          r.customer, h('span', null, r.productName, r.barcode ? h('div', { class: 'muted' }, r.barcode) : null), r.lotName, date(r.expiryDate), String(r.cartonsOnShelf),
          r.returnReason ? `${r.returnReason}${r.returnNote ? ` (${r.returnNote})` : ''}` : 'Expired',
          r.rep,
        ]))
      : h('p', { class: 'muted' }, 'None.'));
    setChildren(decidedBox, d.decided.length
      ? table(['Customer', 'Product', 'Discount', 'Outcome'],
        d.decided.map((r) => [r.customer, r.productName, `${r.discountPct}%`,
        r.approvalStatus === 'REJECTED'
          ? h('span', null, h('span', { class: 'pill err' }, 'Turned down'), ` ${r.reason}`)
          : h('span', null, h('span', { class: 'pill ok' }, 'Approved'), ` credit note ${r.creditNoteRef}`)]))
      : h('p', { class: 'muted' }, 'Nothing decided yet.'));
  }

  /** The shelf lots and the discount on each. Each row's field is built once per load and never rebuilt while typed in. */
  async function loadShelfLots() {
    let d;
    try { d = await api.shelfLotDiscounts(); } catch (e) { toast(e.message, 'err'); return; }
    setChildren(shelfBox, d.lots.length
      ? h('div', { class: 'exp-wrap' }, h('table', { class: 'exp-table' },
        h('thead', null, h('tr', null, ['Product', 'Lot', 'Expires', 'Customer (shop)', 'Sales rep responsible', 'Cartons on shelf', 'Discount'].map((t) => h('th', null, t)))),
        h('tbody', null, d.lots.map(lotRow))))
      : h('p', { class: 'muted' }, 'No lot on a customer shelf is waiting for a visit.'));
  }

  function lotRow(l) {
    const pct = h('input', {
      type: 'number', min: '1', max: '90', step: '1', inputmode: 'decimal', placeholder: '%', value: l.discountPct ?? '', class: 'exp-disc-in',
      'aria-label': `Discount percent for ${l.productName}, lot ${l.lotName}`,
      onKeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); save(pct.value.trim() === '' ? null : pct.value.trim(), set); } },
    });
    const remove = h('button', { type: 'button', class: 'ghost' + (l.discountPct ? '' : ' hidden'), onClick: (e) => save(null, e.currentTarget) }, 'Remove');
    async function save(value, control) {
      control.disabled = true;
      try {
        const r = await api.setShelfLotDiscount(l.key, value);
        l.discountPct = r.lot.discountPct;
        pct.value = l.discountPct ?? '';
        remove.classList.toggle('hidden', !l.discountPct);
        try { localStorage.setItem('bfl.discounts.updated', String(Date.now())); } catch { }
        try { const bc = new BroadcastChannel('bfl_discounts'); bc.postMessage({ type: 'discount_updated', at: Date.now() }); bc.close(); } catch { }
        toast(value === null ? 'Discount removed' : 'Discount saved: live for reps & customers', 'ok');
      } catch (e) { toast(e.message, 'err'); } finally { control.disabled = false; }
    }
    const set = h('button', { type: 'button', class: 'secondary', onClick: (e) => save(pct.value.trim() === '' ? null : pct.value.trim(), e.currentTarget) }, 'Set');
    return h('tr', null,
      h('td', null, h('b', null, l.productName), h('div', { class: 'muted' }, l.barcode)),
      h('td', null, l.lotName),
      h('td', null, `${date(l.expiryDate)} (${daysText(l.daysLeft)})`),
      // one line per shop that holds this lot: who they are, which rep looks after them, how many cartons
      h('td', null, l.holders.map((x) => h('div', null, h('b', null, x.customer), h('span', { class: 'muted' }, ` · Odoo ID ${x.odooId}`)))),
      h('td', null, l.holders.map((x) => h('div', null, x.rep || h('span', { class: 'muted' }, 'no rep yet')))),
      h('td', { class: 'num' }, l.holders.map((x) => h('div', null, String(x.cartons)))),
      h('td', null, h('div', { class: 'exp-disc' }, pct, ' %', set, remove)));
  }

  function pendingItem(p) {
    const reason = h('input', { type: 'text', maxlength: '300', placeholder: 'Reason for the rep', 'aria-label': `Reason for turning down the discount on ${p.productName}`, class: 'hidden' });
    const approve = h('button', { type: 'button', onClick: () => act(p.id, { decision: 'APPROVE' }, approve) }, 'Approve');
    const reject = h('button', {
      type: 'button', class: 'ghost', onClick: () => {
        if (reason.classList.contains('hidden')) { reason.classList.remove('hidden'); reason.focus(); reject.textContent = 'Confirm turn down'; return; }
        act(p.id, { decision: 'REJECT', reason: reason.value }, reject);
      }
    }, 'Turn down');
    return h('div', { class: 'appr-item' },
      h('div', null,
        h('b', null, `${p.discountPct}% off `), `${p.productName} · lot ${p.lotName}`,
        h('div', { class: 'muted' },
          `${p.customer} · ${plural(p.cartonsOnShelf, 'carton')} on the shelf · expires ${date(p.expiryDate)} (${daysText(p.daysLeft)})`),
        h('div', { class: 'muted' }, `Proposed by ${p.rep} on ${date(p.visitedOn)} · agreed by ${p.contactName}, who confirmed the lot will not be returned for expiry`),
        p.offeredPct ? h('div', { class: 'muted' }, `Your discount on this lot is ${p.offeredPct}%; the rep proposed more.`) : null),
      h('div', { class: 'appr-actions' }, reason, approve, reject));
  }

  function financeItem(p) {
    const ref = h('input', { type: 'text', maxlength: '60', placeholder: 'Credit note number', 'aria-label': `Credit note number for ${p.customer}, ${p.productName}` });
    const save = h('button', {
      type: 'button', onClick: async () => {
        save.disabled = true;
        try { await api.shelfCreditNote(p.id, ref.value); toast('Credit note recorded', 'ok'); await load(); } catch (e) { toast(e.message, 'err'); save.disabled = false; }
      }
    }, 'Credit note issued');
    return h('div', { class: 'appr-item' },
      h('div', null, h('b', null, `${p.discountPct}% credit `), `${p.customer} · ${p.productName} · lot ${p.lotName}`,
        h('div', { class: 'muted' }, `${plural(p.cartonsOnShelf, 'carton')} · order ${p.salesOrder} · ${p.preApproved ? `approved at once (within your ${p.offeredPct}% discount)` : 'approved'}`)),
      h('div', { class: 'appr-actions' }, ref, save));
  }

  async function act(id, body, button) {
    button.disabled = true;
    try {
      await api.shelfDecide(id, body);
      toast(body.decision === 'APPROVE' ? 'Approved: Finance has a task' : 'Turned down: the rep will see your reason', 'ok');
      await load();
    } catch (e) { toast(e.message, 'err'); button.disabled = false; }
  }

  function table(head, rows) {
    return h('div', { class: 'exp-wrap' }, h('table', { class: 'exp-table' },
      h('thead', null, h('tr', null, head.map((t) => h('th', null, t)))),
      h('tbody', null, rows.map((r) => h('tr', null, r.map((c) => h('td', null, c)))))));
  }

  await load();
}

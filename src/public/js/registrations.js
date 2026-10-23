// S01 — the Sales Manager's decision on a registration.
//
// Shows who registered, whether we may already know them (the duplicate check), and asks for the
// four things the approval needs: credit or cash, the sales rep, the price class, and — if the
// registration matches someone — whether it IS that customer. Everything here is a choice from a
// list, so there is no typing to protect; the panel is built once per registration.
import { api, toast } from './api.js';
import { h, setChildren, toggleHidden } from './lib/dom.js';

const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—');

function field(label, value) {
  return h('div', { class: 'reg-field' }, h('dt', null, label), h('dd', null, value || '—'));
}

/**
 * @param {object} request  from GET /access-requests/:id (with `duplicates` and `suggestedType`)
 * @param {object} options  from GET /access-requests/options
 * @param {{onApproved:(result:object)=>void, onCancel:()=>void}} hooks
 */
export function buildDecisionPanel(request, options, { onApproved, onCancel }) {
  const dupes = request.duplicates || { customers: [], requests: [] };
  const state = {
    type: request.suggestedType,
    link: null,          // customer id this registration IS, or null
    createNew: dupes.customers.length === 0,
    priceClass: options.defaultPriceClass,
    rep: '',
  };

  // ---- duplicate check -----------------------------------------------------------------
  const dupeBox = h('div', { class: 'reg-dupes' });
  if (dupes.customers.length) {
    const group = 'dup-' + request.id;
    const choices = dupes.customers.map((c) => h('label', { class: 'reg-choice' },
      h('input', { type: 'radio', name: group, onChange: () => { state.link = c.id; state.createNew = false; refresh(); } }),
      h('span', null,
        h('b', null, 'This is ', c.name),
        h('span', { class: 'muted' }, ` — ${c.reasons.join(', ').toLowerCase()}`),
        h('span', { class: 'muted reg-sub' },
          [c.odooRef ? `Odoo ${c.odooRef}` : null, c.priceClass, c.salesperson ? `rep ${c.salesperson}` : null].filter(Boolean).join(' · ')),
        h('span', { class: 'muted reg-sub' }, 'Their Odoo details are kept; only blanks are filled in.'))));
    choices.push(h('label', { class: 'reg-choice' },
      h('input', { type: 'radio', name: group, onChange: () => { state.link = null; state.createNew = true; refresh(); } }),
      h('span', null, h('b', null, 'None of these — it is a new customer'))));
    dupeBox.append(
      h('div', { class: 'notice' }, h('b', null, 'We may already know this customer. '), 'Say which one it is before approving.'),
      ...choices);
  } else {
    dupeBox.append(h('div', { class: 'okbox' }, 'No existing customer matches the name, phone or email.'));
  }
  if (dupes.requests.length) {
    dupeBox.append(h('p', { class: 'muted' },
      'Other registrations that look alike: ',
      dupes.requests.map((r) => `${r.reference || `#${r.id}`} ${r.name} (${r.status.toLowerCase()}; ${r.reasons.join(', ').toLowerCase()})`).join('; ')));
  }

  // ---- type, class, rep ------------------------------------------------------------------
  const typeGroup = 'type-' + request.id;
  const typeRadio = (value, label, hint) => h('label', { class: 'reg-choice' },
    h('input', { type: 'radio', name: typeGroup, checked: state.type === value, onChange: () => { state.type = value; refresh(); } }),
    h('span', null, h('b', null, label), h('span', { class: 'muted reg-sub' }, hint)));

  const classSel = h('select', { 'aria-label': 'Price class', onChange: () => { state.priceClass = classSel.value; refresh(); } },
    options.priceClasses.filter((c) => !c.isCashAccount).map((c) => h('option', { value: c.name, selected: c.isDefault }, c.name + (c.isDefault ? ' (default)' : ''))));
  const classFixed = h('p', { class: 'muted' }, `Cash customers always use ${options.cashPriceClass}.`);
  const repSel = h('select', { 'aria-label': 'Sales rep', onChange: () => { state.rep = repSel.value; refresh(); } },
    h('option', { value: '' }, 'Choose a rep…'),
    options.reps.map((r) => h('option', { value: r.id }, r.name)));

  const odooNote = h('p', { class: 'muted' });
  const problem = h('p', { class: 'reg-problem', role: 'status' });
  const approveBtn = h('button', { type: 'button', onClick: approve }, 'Approve and issue code');

  const panel = h('div', { class: 'card reg-panel' },
    h('h2', null, 'Review registration ', request.reference || `#${request.id}`),
    h('dl', { class: 'reg-fields' },
      field('Company', request.company), field('Contact', request.contact), field('Phone', request.phone),
      field('Email', request.email), field('Delivery address', request.delivery_address), field('Asked', when(request.created_at)),
      request.note ? field('Note', request.note) : null),
    h('h3', null, '1 · Do we already have them?'), dupeBox,
    h('h3', null, '2 · Credit or cash customer'),
    typeRadio('CREDIT', 'Credit customer', 'A company with its own Odoo account, credit limit and invoices. Created in Odoo once approved.'),
    typeRadio('CASH', 'Cash customer', 'Pays in cash on the shared cash account. Nothing is created in Odoo.'),
    h('h3', null, '3 · Price class and sales rep'),
    h('div', { class: 'reg-row' },
      h('label', null, h('span', { class: 'muted' }, 'Price class'), classSel, classFixed),
      h('label', null, h('span', { class: 'muted' }, 'Sales rep'), repSel)),
    odooNote,
    problem,
    h('div', { class: 'controls' }, approveBtn, h('button', { type: 'button', class: 'ghost', onClick: onCancel }, 'Cancel')));

  function refresh() {
    const cash = state.type === 'CASH';
    toggleHidden(classSel, cash);
    toggleHidden(classFixed, !cash);
    const linked = Boolean(state.link);
    let msg = '';
    if (linked) msg = 'Existing customer: nothing is sent to Odoo.';
    else if (cash) msg = 'Nothing is created in Odoo for a cash customer.';
    else msg = 'A new customer will be queued for Odoo with this registration reference. (The Odoo connection is not live yet, so it waits in the outbox.)';
    odooNote.textContent = msg;
    let why = '';
    if (dupes.customers.length && !state.link && !state.createNew) why = 'Say whether this is one of the customers above.';
    else if (state.type === 'CREDIT' && !state.rep) why = 'Choose the sales rep.';
    problem.textContent = why;
    approveBtn.disabled = Boolean(why);
  }

  async function approve() {
    approveBtn.disabled = true;
    try {
      const result = await api.approveAccessRequest(request.id, {
        customerType: state.type,
        priceClass: state.type === 'CASH' ? undefined : state.priceClass,
        salespersonId: state.rep || undefined,
        linkCustomerId: state.link || undefined,
        createNew: state.link ? undefined : state.createNew,
      });
      onApproved(result);
    } catch (e) {
      toast(e.message, 'err');
      refresh();
    }
  }

  refresh();
  return panel;
}

/** The Odoo outbox, shown plainly so the owner can see nothing has been sent. */
export function buildOutboxNote(options) {
  const s = options.outbox.summary;
  const box = h('div', { class: 'card' });
  setChildren(box,
    h('h3', null, 'Waiting to go to Odoo'),
    h('p', { class: 'muted' }, 'New credit customers are queued here when approved. Odoo is not connected yet, so nothing has been sent.'),
    options.outbox.pending.length
      ? h('ul', null, options.outbox.pending.map((p) => h('li', null, `${p.name} — ${p.reference || ''}`)))
      : h('p', { class: 'muted' }, 'Nothing is waiting.'),
    h('p', { class: 'muted' }, `Pending ${s.PENDING} · sent ${s.SENT} · failed ${s.FAILED}`));
  return box;
}

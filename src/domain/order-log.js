// A log of orders that could not be placed, kept for the monthly reports (S06):
//   LOW_STOCK  cartons a customer wanted but could not order because stock was too low — "lost demand",
//              an input for purchasing
//   CREDIT     requests refused by the credit check
// Written ONLY when a customer actually tries to submit (never by a dry run), after the refusal has
// been rolled back, so a failure to log can never turn into a failure to refuse. Staff-only data.
const nowIso = () => new Date().toISOString();

/** Record the lines of a refused request that fell short of stock. `lines` are validateRequest's results. */
export function logLowStock(db, customerId, lines, now = new Date()) {
  try {
    const ins = db.prepare(`INSERT INTO order_check_log (customer_id, kind, barcode, product_name, cartons_wanted, cartons_short, at)
                            VALUES (?, 'LOW_STOCK', ?, ?, ?, ?, ?)`);
    for (const l of lines || []) {
      if (l.code !== 'INSUFFICIENT_STOCK' && l.code !== 'NOT_REQUESTABLE') continue;
      const wanted = Number(l.quantityCtn);
      if (!Number.isInteger(wanted) || wanted < 1) continue;
      const short = Math.max(1, wanted - Math.max(0, Number(l.availableCtn) || 0));
      ins.run(customerId ?? null, l.barcode, l.name ?? null, wanted, short, (now || new Date()).toISOString());
    }
  } catch { /* the log must never break an order */ }
}

/** Record a request refused by the credit check. */
export function logCreditBlock(db, customerId, check, now = new Date()) {
  try {
    db.prepare(`INSERT INTO order_check_log (customer_id, kind, order_value, available_credit, at) VALUES (?, 'CREDIT', ?, ?, ?)`)
      .run(customerId ?? null, check.orderValue ?? null, check.available ?? null, (now || new Date()).toISOString() || nowIso());
  } catch { /* the log must never break an order */ }
}

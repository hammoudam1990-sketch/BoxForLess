// Customers download their invoices and their account statement (domain/pdf.js, domain/customer-documents.js,
// GET /api/catalog/invoices/:number/pdf, /statement.pdf, /statement.csv).
//
// What is at risk, in order: one customer downloading another's invoice or balance; the shared cash account's
// figures reaching anyone; a broken file. Identity is the session; there is no parameter that names a customer.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { freshDb } from './helpers.js';
import { createApp } from '../src/server/index.js';
import { issueAccessCode } from '../src/domain/access-codes.js';
import { submitRequest } from '../src/domain/requests.js';
import { createOrderForRequest } from '../src/domain/orders.js';
import { sendQuotation, confirmOrder, validateDelivery, postInvoice, recordPayment, setCreditLimit } from '../src/domain/sample-odoo.js';
import { setPaymentDue } from '../src/domain/payment-due.js';
import { PdfDocument, textWidth, wrap } from '../src/domain/pdf.js';
import { invoiceData, invoicePdf, statementData, statementCsv, DocumentError } from '../src/domain/customer-documents.js';
import { resetAccessAttempts } from '../src/server/customer-access.js';

beforeEach(() => resetAccessAttempts());

const SPICE = '5283001117266';
const ts = new Date().toISOString();
const today = ts.slice(0, 10);
const plusDays = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

function setup() {
  const db = freshDb();
  db.prepare("INSERT INTO import_batches (filename, status, imported_at, confirmed_at, completed_at) VALUES ('t.xlsx','COMPLETED',?,?,?)").run(ts, ts, ts);
  db.prepare('INSERT INTO products (barcode, name, box_uom, free_to_use, is_active, created_at, updated_at) VALUES (?,?,?,?,1,?,?)').run(SPICE, 'ABIDO ALL SPICE GROUND 500G * 14', 'CTN14', 500, ts, ts);
  return db;
}
function customer(db, name, type = 'CREDIT') {
  const id = Number(db.prepare(`INSERT INTO customers (name, odoo_customer_ref, customer_type, pricelist, delivery_address, is_active, created_at, updated_at)
    VALUES (?, ?, ?, 'CLASS A (GHS)', 'Spintex Road, Accra', 1, ?, ?)`).run(name, `R${Math.floor(Math.random() * 1e6)}`, type, ts, ts).lastInsertRowid);
  if (type === 'CREDIT') setCreditLimit(db, id, 50000);
  return id;
}
/** An order taken all the way to an invoice; returns its invoice number and the request id. */
function invoiced(db, customerId, cartons = 2) {
  const r = submitRequest(db, { lines: [{ barcode: SPICE, quantityCtn: cartons }], customerId, onInsert: (id) => createOrderForRequest(db, id) });
  const orderId = db.prepare('SELECT id FROM odoo_orders WHERE request_id = ?').get(r.requestId).id;
  sendQuotation(db, orderId); confirmOrder(db, orderId); validateDelivery(db, orderId); postInvoice(db, orderId);
  return { requestId: r.requestId, orderId, number: db.prepare('SELECT number FROM odoo_invoices WHERE order_id = ?').get(orderId).number };
}

// ===========================================================================
// the PDF writer
// ===========================================================================
test('1. a PDF file is well formed: header, objects at the offsets the index says, and the end marker', () => {
  const doc = new PdfDocument({ title: 'Test (one)' });
  doc.text(40, 60, 'Invoice INV/1 (copy) \\ GH₵ 10 — paid', { size: 12, bold: true });
  doc.rect(40, 80, 100, 20, { fill: [234, 242, 252] });
  doc.line(40, 110, 200, 110);
  doc.addPage();
  doc.text(40, 60, 'Page two');
  const buf = doc.toBuffer();
  const text = buf.toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4'));
  assert.ok(text.trimEnd().endsWith('%%EOF'));
  assert.match(text, /\/Count 2/);
  assert.ok(text.includes('(Invoice INV/1 \\(copy\\) \\\\ GHS 10 \\227 paid)'), 'brackets and backslash escaped, the cedi sign written GHS, the dash in WinAnsi');
  const startxref = Number(/startxref\n(\d+)/.exec(text)[1]);
  assert.ok(text.slice(startxref).startsWith('xref'), 'startxref points at the index');
  const offsets = text.slice(startxref).split('\n').filter((l) => / 00000 n $/.test(l)).map((l) => Number(l.slice(0, 10)));
  offsets.forEach((o, i) => assert.ok(text.slice(o).startsWith(`${i + 1} 0 obj`), `object ${i + 1} is where the index says`));
});

test('2. text is measured with the font metrics and wrapped to the width', () => {
  assert.equal(textWidth('0123456789', 10), 55.6);
  assert.ok(textWidth('W', 10, true) > textWidth('i', 10, true));
  const lines = wrap('PERSIL LIQUID DETERGENT DEEP CLEAN LAVENDER GEL 2.5LT * 6', 120, 9);
  assert.ok(lines.length > 1);
  assert.ok(lines.every((l) => textWidth(l, 9) <= 120));
  assert.equal(lines.join(' '), 'PERSIL LIQUID DETERGENT DEEP CLEAN LAVENDER GEL 2.5LT * 6');
});

// ===========================================================================
// what goes in the documents
// ===========================================================================
test('3. an invoice copy has its lines, payments, amount due, and the "pay by" date the Sales Manager set', () => {
  const db = setup();
  const a = customer(db, 'Adom Supermarket');
  const inv = invoiced(db, a);
  setPaymentDue(db, inv.requestId, { dueDate: plusDays(9) }, 'Ama Boateng');
  const d = invoiceData(db, a, inv.number, today);
  assert.equal(d.number, inv.number);
  assert.equal(d.payBy, plusDays(9));
  assert.equal(d.status, 'Open');
  assert.equal(d.lines.length, 1);
  assert.equal(d.lines[0].cartons, 2);
  assert.equal(d.amountDue, d.amount);
  const pdf = invoicePdf(db, a, inv.number, today).buffer.toString('latin1');
  assert.ok(pdf.includes(inv.number) && pdf.includes('Adom Supermarket') && pdf.includes('ABIDO ALL SPICE'));
  recordPayment(db, inv.orderId);
  const paid = invoiceData(db, a, inv.number, today);
  assert.deepEqual([paid.status, paid.amountDue, paid.payments.length], ['Paid', 0, 1]);
});

test('4. another customer\'s invoice is "not found", and a cash account has nothing to download', () => {
  const db = setup();
  const a = customer(db, 'Adom Supermarket');
  const b = customer(db, 'Other Co');
  const theirs = invoiced(db, b);
  assert.throws(() => invoiceData(db, a, theirs.number, today), (e) => e instanceof DocumentError && e.status === 404);
  const cash = customer(db, 'Walk-in buyer', 'CASH');
  assert.throws(() => statementData(db, cash, today), (e) => e instanceof DocumentError && e.status === 409);
});

test('5. the statement: credit position, open invoices, the year\'s invoices and payments — only this customer\'s', () => {
  const db = setup();
  const a = customer(db, 'Adom Supermarket');
  const b = customer(db, 'Other Co');
  const one = invoiced(db, a);
  const two = invoiced(db, a, 3);
  recordPayment(db, one.orderId);
  invoiced(db, b);
  const s = statementData(db, a, today);
  assert.deepEqual(s.invoices.map((i) => i.number).sort(), [one.number, two.number].sort());
  assert.deepEqual(s.open.map((i) => i.number), [two.number]);
  assert.equal(s.payments.length, 1);
  assert.equal(s.summary.creditLimit, 50000);
  assert.equal(s.summary.amountOwed, s.open[0].amountDue);
  const csv = statementCsv(db, a, today).text;
  assert.ok(csv.includes(one.number) && csv.includes(two.number));
  assert.ok(!csv.includes('Other Co'));
});

test('6. a spreadsheet never runs a formula from the statement', () => {
  const db = setup();
  const a = customer(db, '=HYPERLINK("http://evil","x")');
  invoiced(db, a);
  const csv = statementCsv(db, a, today).text;
  assert.ok(csv.includes('"\'=HYPERLINK(""http://evil"",""x"")"'), 'the name is prefixed so it stays text');
});

// ===========================================================================
// the routes
// ===========================================================================
async function withApp(db, fn) {
  const server = http.createServer(createApp(db));
  await new Promise((r) => server.listen(0, r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}
async function signIn(base, db, id) {
  const res = await fetch(`${base}/api/catalog/access`, { method: 'POST', headers: { 'Content-Type': 'application/json', origin: base }, body: JSON.stringify({ code: issueAccessCode(db, id) }) });
  assert.equal(res.status, 200);
  return (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
}
const get = (base, path, cookie) => fetch(base + path, { headers: cookie ? { cookie } : {} });

test('7. downloads need a signed-in customer and give them only their own documents', async () => {
  const db = setup();
  const a = customer(db, 'Adom Supermarket');
  const b = customer(db, 'Other Co');
  const mine = invoiced(db, a);
  const theirs = invoiced(db, b);
  await withApp(db, async (base) => {
    for (const p of [`/api/catalog/invoices/${encodeURIComponent(mine.number)}/pdf`, '/api/catalog/statement.pdf', '/api/catalog/statement.csv']) {
      assert.equal((await get(base, p)).status, 401, `${p} needs a sign-in`);
    }
    const cookie = await signIn(base, db, a);
    const pdf = await get(base, `/api/catalog/invoices/${encodeURIComponent(mine.number)}/pdf`, cookie);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.match(pdf.headers.get('content-disposition'), /^attachment; filename="Invoice-[A-Za-z0-9._-]+\.pdf"$/);
    assert.equal(pdf.headers.get('cache-control'), 'no-store');
    const body = Buffer.from(await pdf.arrayBuffer()).toString('latin1');
    assert.ok(body.startsWith('%PDF') && body.includes(mine.number));
    assert.equal((await get(base, `/api/catalog/invoices/${encodeURIComponent(theirs.number)}/pdf`, cookie)).status, 404, 'not mine: not found');
    assert.equal((await get(base, `/api/catalog/invoices/${encodeURIComponent(theirs.number)}/pdf?customer=${b}&customerId=${b}`, cookie)).status, 404, 'no parameter names another customer');
    const st = Buffer.from(await (await get(base, '/api/catalog/statement.pdf', cookie)).arrayBuffer()).toString('latin1');
    assert.ok(st.includes('Adom Supermarket') && !st.includes('Other Co') && !st.includes(theirs.number));
    const csv = await get(base, '/api/catalog/statement.csv', cookie);
    assert.match(csv.headers.get('content-type'), /^text\/csv/);
    assert.ok((await csv.text()).includes(mine.number));
  });
});

test('8. a cash customer is told there is nothing to download', async () => {
  const db = setup();
  const cash = customer(db, 'Walk-in buyer', 'CASH');
  await withApp(db, async (base) => {
    const cookie = await signIn(base, db, cash);
    const r = await get(base, '/api/catalog/statement.pdf', cookie);
    assert.equal(r.status, 409);
    assert.match((await r.json()).error, /cash account/);
  });
});

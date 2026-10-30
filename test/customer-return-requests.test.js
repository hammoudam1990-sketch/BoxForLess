import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { freshDb } from './helpers.js';

const SAVED_CONTEXT = process.env.NODE_TEST_CONTEXT;
const SAVED_STAFF_USERNAME = process.env.BFL_STAFF_USERNAME;
const SAVED_STAFF_PASSWORD = process.env.BFL_STAFF_PASSWORD;
const SAVED_SESSION_SECRET = process.env.BFL_SESSION_SECRET;
delete process.env.NODE_TEST_CONTEXT;
process.env.BFL_STAFF_USERNAME = 'owner';
process.env.BFL_STAFF_PASSWORD = 'owner-secret-passphrase';
process.env.BFL_SESSION_SECRET = crypto.randomBytes(32).toString('hex');
after(() => {
  if (SAVED_CONTEXT !== undefined) process.env.NODE_TEST_CONTEXT = SAVED_CONTEXT;
  if (SAVED_STAFF_USERNAME === undefined) delete process.env.BFL_STAFF_USERNAME;
  else process.env.BFL_STAFF_USERNAME = SAVED_STAFF_USERNAME;
  if (SAVED_STAFF_PASSWORD === undefined) delete process.env.BFL_STAFF_PASSWORD;
  else process.env.BFL_STAFF_PASSWORD = SAVED_STAFF_PASSWORD;
  if (SAVED_SESSION_SECRET === undefined) delete process.env.BFL_SESSION_SECRET;
  else process.env.BFL_SESSION_SECRET = SAVED_SESSION_SECRET;
});

const { createApp } = await import('../src/server/index.js');
const staff = await import('../src/domain/staff-accounts.js');
const { hashPassword } = await import('../src/domain/passwords.js');
const { resetStaffAttempts } = await import('../src/server/staff-auth.js');
const { resetAuthAttempts } = await import('../src/server/routes/auth.js');

beforeEach(() => { resetStaffAttempts(); resetAuthAttempts(); });

const PASSWORD = 'a sufficiently long password';
const time = new Date().toISOString();

function makeCustomer(db, name, odooId, salesperson) {
  return Number(db.prepare(`
    INSERT INTO customers (name, odoo_customer_ref, salesperson, password_hash, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?)
  `).run(name, odooId, salesperson, hashPassword(PASSWORD), time, time).lastInsertRowid);
}

function makeOrder(db, customerId, reference, barcode, productName, state, cartons) {
  const productId = Number(db.prepare(`
    INSERT INTO products (barcode, name, box_uom, created_at, updated_at)
    VALUES (?, ?, 'Carton', ?, ?)
  `).run(barcode, productName, time, time).lastInsertRowid);
  const requestId = Number(db.prepare(`
    INSERT INTO requests (reference, customer_id, status, submitted_at, created_at, updated_at)
    VALUES (?, ?, 'ACCEPTED', ?, ?, ?)
  `).run(reference, customerId, time, time, time).lastInsertRowid);
  db.prepare(`
    INSERT INTO request_items
      (request_id, product_id, quantity_ctn, product_name_at_request, barcode_at_request, box_uom_at_request, created_at)
    VALUES (?, ?, ?, ?, ?, 'Carton', ?)
  `).run(requestId, productId, cartons, productName, barcode, time);
  db.prepare(`
    INSERT INTO odoo_orders (request_id, customer_id, state, received_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(requestId, customerId, state, time, time);
}

async function start(db) {
  const server = http.createServer(createApp(db));
  await new Promise((resolve) => server.listen(0, resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const request = (base, path, cookie, method = 'GET', body) => fetch(`${base}${path}`, {
  method,
  headers: { origin: base, 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const cookieFrom = (response) => (response.headers.getSetCookie?.() || [])
  .map((value) => value.split(';')[0]).filter((value) => !value.endsWith('=')).join('; ');

async function signInCustomer(base, customerReference) {
  const response = await request(base, '/api/auth/customer/login', null, 'POST', { id: customerReference, password: PASSWORD });
  assert.equal(response.status, 200);
  return cookieFrom(response);
}

async function signInStaff(base, role) {
  const { user, temporaryPassword } = staff.createStaffUser(
    dbForStaff, { name: `Return ${role}`, email: `${role.toLowerCase()}-return@example.test`, role },
    'ADMIN',
  );
  staff.changeStaffPassword(dbForStaff, user.id, temporaryPassword, PASSWORD);
  const response = await request(base, '/api/staff/login', null, 'POST', {
    identifier: `${role.toLowerCase()}-return@example.test`, password: PASSWORD,
  });
  assert.equal(response.status, 200);
  return cookieFrom(response);
}
let dbForStaff;

test('customers can request only their own eligible cartons; managers decide and customers see decline reasons', async () => {
  const db = freshDb();
  dbForStaff = db;
  const customerId = makeCustomer(db, 'Customer One', 'CUST-1', 'Assigned Rep');
  const otherCustomerId = makeCustomer(db, 'Customer Two', 'CUST-2', 'Other Rep');
  makeOrder(db, customerId, 'ORD-OWN', '111', 'Own product', 'DISPATCHED', 4);
  makeOrder(db, customerId, 'ORD-OPEN', '222', 'Not yet delivered', 'APPROVED', 5);
  makeOrder(db, otherCustomerId, 'ORD-OTHER', '333', 'Other product', 'PAID', 8);

  const rep = staff.createStaffUser(db, {
    name: 'Assigned Rep', email: 'rep-contact@example.test', phone: '+233 20 123 4567', role: 'SALES_REP', repId: 'rep-1',
  }, 'ADMIN');
  staff.changeStaffPassword(db, rep.user.id, rep.temporaryPassword, PASSWORD);
  const { server, base } = await start(db);
  try {
    const customerCookie = await signInCustomer(base, 'CUST-1');
    const managerCookie = await signInStaff(base, 'SALES_MANAGER');
    const warehouseCookie = await signInStaff(base, 'WAREHOUSE');

    const profileResponse = await request(base, '/api/catalog/profile', customerCookie);
    const profile = await profileResponse.json();
    assert.equal(profile.assignedSalesRep.name, 'Assigned Rep');
    assert.equal(profile.assignedSalesRep.email, 'rep-contact@example.test');
    assert.equal(profile.assignedSalesRep.phone, '+233 20 123 4567');
    assert.equal(JSON.stringify(profile).includes('Customer Two'), false);
    assert.equal('id' in profile, false);

    const listing = await (await request(base, '/api/catalog/return-requests', customerCookie)).json();
    assert.deepEqual(listing.items.map((item) => item.orderReference), ['ORD-OWN']);
    assert.equal(JSON.stringify(listing).includes('ORD-OTHER'), false);
    assert.equal(JSON.stringify(listing).includes('customerId'), false);

    const noReason = await request(base, '/api/catalog/return-requests', customerCookie, 'POST', {
      orderReference: 'ORD-OWN', barcode: '111', cartons: 1, reason: '  ',
    });
    assert.equal(noReason.status, 400);
    const otherOrder = await request(base, '/api/catalog/return-requests', customerCookie, 'POST', {
      orderReference: 'ORD-OTHER', barcode: '333', cartons: 1, reason: 'Wrong item',
      customerId: otherCustomerId,
    });
    assert.equal(otherOrder.status, 404);
    const tooMany = await request(base, '/api/catalog/return-requests', customerCookie, 'POST', {
      orderReference: 'ORD-OWN', barcode: '111', cartons: 5, reason: 'Too many cartons',
    });
    assert.equal(tooMany.status, 400);

    const first = await request(base, '/api/catalog/return-requests', customerCookie, 'POST', {
      orderReference: 'ORD-OWN', barcode: '111', cartons: 1, reason: 'Packaging was damaged',
    });
    assert.equal(first.status, 201);
    const approvedRef = (await first.json()).request.reference;
    const second = await request(base, '/api/catalog/return-requests', customerCookie, 'POST', {
      orderReference: 'ORD-OWN', barcode: '111', cartons: 2, reason: 'Wrong product sent',
    });
    assert.equal(second.status, 201);
    const declinedRef = (await second.json()).request.reference;

    const staffList = await request(base, '/api/customer-return-requests', managerCookie);
    assert.equal(staffList.status, 200);
    assert.equal((await request(base, '/api/customer-return-requests', warehouseCookie)).status, 403);
    assert.equal((await request(base, `/api/customer-return-requests/${encodeURIComponent(declinedRef)}/decision`, managerCookie, 'POST', {
      decision: 'DECLINED', declineReason: ' ',
    })).status, 400);
    const decline = await request(base, `/api/customer-return-requests/${encodeURIComponent(declinedRef)}/decision`, managerCookie, 'POST', {
      decision: 'DECLINED', declineReason: 'The item is outside the return period.',
    });
    assert.equal(decline.status, 200);
    const approve = await request(base, `/api/customer-return-requests/${encodeURIComponent(approvedRef)}/decision`, managerCookie, 'POST', {
      decision: 'APPROVED',
    });
    assert.equal(approve.status, 200);
    assert.equal((await request(base, `/api/customer-return-requests/${encodeURIComponent(approvedRef)}/decision`, managerCookie, 'POST', {
      decision: 'DECLINED', declineReason: 'Already approved.',
    })).status, 409);

    const customerRequests = await (await request(base, '/api/catalog/return-requests', customerCookie)).json();
    assert.deepEqual(customerRequests.requests.map((item) => item.status), ['DECLINED', 'APPROVED']);
    assert.equal(customerRequests.requests[0].declineReason, 'The item is outside the return period.');
    assert.equal(JSON.stringify(customerRequests).includes('customerId'), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    dbForStaff = undefined;
  }
});

test('products bought at a discount can never be listed or requested for return', async () => {
  const { createCustomerReturnRequest, listReturnableItems } = await import('../src/domain/customer-return-requests.js');
  const db = freshDb();
  const customerId = makeCustomer(db, 'Discount Buyer', 'CUST-D', 'Rep');
  makeOrder(db, customerId, 'ORD-DISC', '777', 'Discounted product', 'DISPATCHED', 4);
  makeOrder(db, customerId, 'ORD-FULL', '888', 'Full price product', 'DISPATCHED', 4);
  db.prepare("UPDATE request_items SET clearance_cartons = 2, clearance_pct = 30 WHERE barcode_at_request = '777'").run();
  assert.deepEqual(listReturnableItems(db, customerId).map((i) => i.orderReference), ['ORD-FULL']);
  assert.throws(() => createCustomerReturnRequest(db, customerId, { orderReference: 'ORD-DISC', barcode: '777', cartons: 1, reason: 'Damaged' }),
    (e) => e.status === 403);
  assert.equal(createCustomerReturnRequest(db, customerId, { orderReference: 'ORD-FULL', barcode: '888', cartons: 1, reason: 'Damaged' }).status, 'PENDING');
});

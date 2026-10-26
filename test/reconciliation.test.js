// Tests for Daily Reconciliation & Alert Engine (ODOO_CONNECTION_PLAN.md Section 4.9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { runDailyReconciliation } from '../src/domain/reconciliation.js';

test('1. reconciliation is clean on a fresh database', () => {
  const db = freshDb();
  const report = runDailyReconciliation(db);
  assert.equal(report.isClean, true);
  assert.equal(report.totalDiscrepancies, 0);
  assert.equal(report.summary.outboxAnomaliesCount, 0);
  assert.equal(report.summary.unlinkedRequestsCount, 0);
  assert.equal(report.summary.missingOdooNumberCount, 0);
});

test('2. outbox anomalies: detects failed entries and entries pending for more than 2 hours', () => {
  const db = freshDb();
  const now = new Date('2026-10-26T12:00:00Z');
  const threeHoursAgo = new Date('2026-10-26T09:00:00Z').toISOString();
  const tenMinutesAgo = new Date('2026-10-26T11:50:00Z').toISOString();

  // 1. Failed entry
  db.prepare(`INSERT INTO odoo_outbox (kind, dedupe_key, payload, status, attempts, created_at, last_error)
              VALUES ('DRAFT_QUOTATION', 'q:1', '{}', 'FAILED', 1, ?, 'Archived product')`).run(tenMinutesAgo);

  // 2. Pending entry > 2 hours old
  db.prepare(`INSERT INTO odoo_outbox (kind, dedupe_key, payload, status, attempts, created_at)
              VALUES ('DRAFT_QUOTATION', 'q:2', '{}', 'PENDING', 3, ?)`).run(threeHoursAgo);

  // 3. Normal pending entry < 2 hours old (not an anomaly)
  db.prepare(`INSERT INTO odoo_outbox (kind, dedupe_key, payload, status, attempts, created_at)
              VALUES ('DRAFT_QUOTATION', 'q:3', '{}', 'PENDING', 0, ?)`).run(tenMinutesAgo);

  const report = runDailyReconciliation(db, { now });
  assert.equal(report.isClean, false);
  assert.equal(report.summary.outboxAnomaliesCount, 2);
  const keys = report.details.outboxAnomalies.map((a) => a.dedupeKey);
  assert.deepEqual(keys.sort(), ['q:1', 'q:2']);
});

test('3. quotation discrepancies: flags requests without odoo_orders and dispatched orders missing odoo_number', () => {
  const db = freshDb();
  const ts = new Date().toISOString();

  const cid = db.prepare("INSERT INTO customers (name, is_active, created_at, updated_at) VALUES ('Kofi Stores', 1, ?, ?)").run(ts, ts).lastInsertRowid;

  // 1. Request with no odoo_orders row
  const r1 = db.prepare("INSERT INTO requests (reference, customer_id, status, submitted_at, created_at, updated_at) VALUES ('REQ-001', ?, 'SUBMITTED', ?, ?, ?)").run(cid, ts, ts, ts).lastInsertRowid;

  // 2. Order that was approved/dispatched but never got an Odoo quotation number
  const r2 = db.prepare("INSERT INTO requests (reference, customer_id, status, submitted_at, created_at, updated_at) VALUES ('REQ-002', ?, 'SUBMITTED', ?, ?, ?)").run(cid, ts, ts, ts).lastInsertRowid;
  db.prepare("INSERT INTO odoo_orders (request_id, customer_id, state, received_at, updated_at) VALUES (?, ?, 'WAITING_FOR_APPROVAL', ?, ?)").run(r2, cid, ts, ts);

  const report = runDailyReconciliation(db);
  assert.equal(report.isClean, false);
  assert.equal(report.summary.unlinkedRequestsCount, 1);
  assert.equal(report.details.unlinkedRequests[0].reference, 'REQ-001');

  assert.equal(report.summary.missingOdooNumberCount, 1);
  assert.equal(report.details.missingOdooNumber[0].requestReference, 'REQ-002');
});

test('4. customer finance at risk: flags overdue accounts without payment schedules', () => {
  const db = freshDb();
  const ts = new Date().toISOString();

  const c1 = db.prepare("INSERT INTO customers (name, is_active, created_at, updated_at) VALUES ('Overdue Shop', 1, ?, ?)").run(ts, ts).lastInsertRowid;
  db.prepare("INSERT INTO odoo_customer_finance (customer_id, credit_limit, amount_owed, overdue, updated_at) VALUES (?, 1000, 500, 200, ?)").run(c1, ts);

  const report = runDailyReconciliation(db);
  assert.equal(report.summary.creditAtRiskCount, 1);
  assert.equal(report.details.creditAtRisk[0].name, 'Overdue Shop');
  assert.equal(report.details.creditAtRisk[0].overdue, 200);

  // Now add schedule -> no longer at risk
  db.prepare("INSERT INTO payment_schedules (customer_id, kind, updated_at) VALUES (?, 'DUE_DATE', ?)").run(c1, ts);
  const reportAfter = runDailyReconciliation(db);
  assert.equal(reportAfter.summary.creditAtRiskCount, 0);
});

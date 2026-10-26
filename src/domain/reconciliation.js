// Daily Reconciliation & Alert Engine (ODOO_CONNECTION_PLAN.md Section 4.9).
// Compares BFL with Odoo to detect quotations missing on either side, stalled outbox entries,
// customer balance/limit drifts, and sync health. On a normal day, this report is completely empty.

const STALE_SYNC_MINUTES = {
  stock: 20,
  customers: 20,
  orders: 20,
  products: 60,
  invoices: 60,
};

/**
 * Run daily reconciliation analysis across outbox, orders, finance and sync state.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ now?: Date }} [opts]
 * @returns {object} Reconciliation report
 */
export function runDailyReconciliation(db, { now = new Date() } = {}) {
  const nowTs = now.getTime();
  const twoHoursAgo = new Date(nowTs - 2 * 3600 * 1000).toISOString();

  // 1. Outbox anomalies: failed writes, or entries pending for more than 2 hours
  const outboxAnomalies = db.prepare(`
    SELECT id, kind, dedupe_key AS dedupeKey, status, attempts, last_error AS lastError,
           created_at AS createdAt, next_attempt_at AS nextAttemptAt
      FROM odoo_outbox
     WHERE status = 'FAILED'
        OR (status = 'PENDING' AND created_at <= ?)
     ORDER BY id DESC
  `).all(twoHoursAgo);

  // 2. Quotation discrepancies: requests submitted without linked odoo_order, or orders missing Odoo number
  const unlinkedRequests = db.prepare(`
    SELECT r.id, r.reference, r.customer_id AS customerId, r.submitted_at AS submittedAt,
           c.name AS customerName
      FROM requests r
      LEFT JOIN odoo_orders o ON o.request_id = r.id
      LEFT JOIN customers c ON c.id = r.customer_id
     WHERE r.status NOT IN ('DELETED', 'WITHDRAWN')
       AND o.id IS NULL
     ORDER BY r.id DESC
  `).all();

  const missingOdooNumber = db.prepare(`
    SELECT o.id, o.request_id AS requestId, r.reference AS requestReference,
           c.name AS customerName, o.state, o.sent_at AS sentAt
      FROM odoo_orders o
      JOIN requests r ON r.id = o.request_id
      LEFT JOIN customers c ON c.id = o.customer_id
     WHERE o.state NOT IN ('RECEIVED', 'CANCELLED')
       AND (o.odoo_number IS NULL OR trim(o.odoo_number) = '')
     ORDER BY o.id DESC
  `).all();

  // 3. Customer Finance drifts: credit customers with overdue balances but no schedule or contact
  const creditAtRisk = db.prepare(`
    SELECT c.id, c.name, c.odoo_customer_ref AS odooRef, c.salesperson,
           f.credit_limit AS creditLimit, f.amount_owed AS amountOwed, f.overdue
      FROM customers c
      JOIN odoo_customer_finance f ON f.customer_id = c.id
     WHERE c.is_active = 1
       AND f.overdue > 0
       AND c.id NOT IN (SELECT customer_id FROM payment_schedules)
     ORDER BY f.overdue DESC
  `).all();

  // 4. Sync State & Stale Jobs
  const syncRows = db.prepare(`
    SELECT data_type AS dataType, cursor, last_success_at AS lastSuccessAt,
           last_attempt_at AS lastAttemptAt, last_error AS lastError,
           runs_ok AS runsOk, runs_failed AS runsFailed
      FROM sync_state
     ORDER BY data_type
  `).all();

  const syncStatusList = syncRows.map((row) => {
    let stale = false;
    let minutesSinceSuccess = null;
    if (row.lastSuccessAt) {
      minutesSinceSuccess = Math.floor((nowTs - Date.parse(row.lastSuccessAt)) / 60000);
      const maxAllowed = STALE_SYNC_MINUTES[row.dataType] || 60;
      stale = minutesSinceSuccess > maxAllowed;
    } else {
      stale = true;
    }
    return {
      ...row,
      minutesSinceSuccess,
      stale,
    };
  });

  const staleSyncJobs = syncStatusList.filter((s) => s.stale);

  const totalDiscrepancies =
    outboxAnomalies.length +
    unlinkedRequests.length +
    missingOdooNumber.length +
    staleSyncJobs.length;

  const isClean = totalDiscrepancies === 0;

  return {
    reconciledAt: now.toISOString(),
    isClean,
    totalDiscrepancies,
    summary: {
      outboxAnomaliesCount: outboxAnomalies.length,
      unlinkedRequestsCount: unlinkedRequests.length,
      missingOdooNumberCount: missingOdooNumber.length,
      creditAtRiskCount: creditAtRisk.length,
      staleSyncCount: staleSyncJobs.length,
    },
    details: {
      outboxAnomalies,
      unlinkedRequests,
      missingOdooNumber,
      creditAtRisk,
      syncStatus: syncStatusList,
    },
  };
}

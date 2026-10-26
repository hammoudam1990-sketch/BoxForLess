# Box for Less (BFL) — Backend Memory & Execution Plan

---

## 1. Project Identity & Architecture Memory

### Identity & Purpose
- **Project:** Box for Less (`BoxForLess`) — Digital Product Catalog and Sales Management Platform for fast-moving consumer goods (FMCG).
- **Core Mission:** Provide a modern, mobile-friendly customer catalogue, carton-based request cart, rep field visit tracking, warehouse expiry management, and executive monthly reports, with Odoo ERP as the master source of truth.
- **Tech Stack:**
  - **Runtime:** Node.js (>= 22) ES Modules.
  - **Backend Framework:** Express.js REST API.
  - **Database:** SQLite file (`data/product_master.db`) utilizing Node's built-in `node:sqlite` (`DatabaseSync`) with WAL mode and foreign key enforcement.
  - **Frontend:** Pure HTML5, CSS3, Vanilla ES Modules (`src/public/js/`). No build step, no framework, zero external CDN dependencies.
  - **Integration Layer:** Unified Odoo external client (`src/odoo/client.js`), outbox worker, and sync daemon.

### Non-Negotiable Operational Guardrails
1. **Critical Isolation Rule:** Completely separate project. Never touch or import code from `Shipment_Manager` or any other project. Double A is a separate business with separate credentials.
2. **Odoo is Master:** All master business data originates from Odoo. Local tables are a read-copy.
3. **Allowed Odoo Writes (Only 2 Things):**
   - **Draft Quotations** (`sale.order` in `draft`): Customer from session, BFL reference in `client_order_ref`, carton quantity per line, **no price** (Odoo calculates price). Clearance lines may specify a lot and discount.
   - **New Customer Partners** (`res.partner`): Created only after Sales Manager approves registration, with BFL registration reference in `ref`.
   - **Never write:** Confirmations, cancellations, invoices, payments, journal entries, inventory adjustments, or pricelists.
4. **Data Safety Rule:** Never delete products, images, categories, history, requests, or customers. Absent records become inactive. Barcode and UoM changes are queued for human review. Images are application-controlled and never modified by sync.
5. **Customer Data Protection & Leak Prevention:**
   - Never expose cost prices, valuation, supplier info, internal IDs, or other customers' data.
   - Identity is always bound to the server session (`session_epoch`), never taken from request payloads.
   - Product visibility rules are strictly enforced server-side.

---

## 2. Current Implementation State

| Stage / Component | Scope | Status | Notes |
|---|---|---|---|
| **Phase 1: Product Master** | Product catalogue import, category tree, audit logs | ✅ Complete | 3,883 products, 143 categories, image linkage |
| **Stage 2: Customer Catalog** | Mobile-first `/catalog`, availability chips, search | ✅ Complete | Verified on iPhone; responsive 1080p scanning |
| **Stage 3: Request Cart** | CTN-only request cart, stock freshness guards | ✅ Complete | Atomic submissions, snapshot pricing/UoM |
| **Stage 4: Access & Staff Auth** | 8-character access codes, staff roles, request management | ✅ Complete | Secure cookies, session epochs, soft delete |
| **Odoo Integration Framework** | Protocol client, rate limiter, fake Odoo test server | ✅ Complete | Outbox worker & sync state implemented |
| **Warehouse Expiry (W1-W4)** | Expiry lists, lot clearance discounts, shelf audit | ✅ Implemented (Sample) | Driven by sample-odoo; ready for live data |
| **Monthly Reports (S06)** | CEO, Sales & Warehouse monthly analytics & targets | ✅ Implemented (Sample) | Real snapshot engine ready; uses sample orders |
| **Field Rep Application** | Rep route visits, customer shelf check, discount proposals | ✅ Implemented (Sample) | Role-restricted to assigned customers |

---

## 3. The Plan to Complete the Backend (`/plan`)

To complete the backend from the current state (fully working stand-in / sample data) to **Live Production Odoo Connection**, the work is organized into 5 concrete phases:

```
[Phase A: Foundations & Odoo Admin]
                │
                ▼
[Phase B: Offline Hardening & Real-World Fixtures]
                │
                ▼
[Phase C: Staging Sync Activation (Read-Only)]
                │
                ▼
[Phase D: Outbox Worker & Bidirectional Quotations]
                │
                ▼
[Phase E: Production Cutover, Backup & Verification]
```

### Phase A: Environment & Administrative Foundations (Readiness Group A)
- **Goal:** Obtain credentials, configure integration user, and establish hosting parameters.
- **Tasks:**
  1. Confirm Odoo version, edition (Online vs sh vs on-prem), and API capability (JSON API bearer token vs XML-RPC `execute_kw`).
  2. Provision the dedicated integration user `bfl-integration` in Odoo with exact read rights and restricted create rights (`res.partner`, `sale.order` draft only; no delete rights).
  3. Confirm custom Odoo fields: `x_brand` on `product.template`, `x_min_shelf_life_days` on `res.partner`, and lot expiry tracking on perishable categories.
  4. Set up Staging Odoo database instance for sandbox verification.
  5. Configure production hosting environment (Node.js >= 22, persistent disk for SQLite, HTTPS TLS certificate, environment secrets).

### Phase B: Backend Module Hardening & Timeout Resilience
- **Goal:** Ensure all test suites pass unconditionally and mock services match production Odoo payloads.
- **Tasks:**
  1. Tune network socket timeouts in `src/odoo/client.js` for Windows and high-latency connections (adjust rate limiter test tolerance in `test/odoo.test.js`).
  2. Verify all 636 automated tests pass with 100% green status.
  3. Validate fake Odoo server against edge-case network partitions, retry backoffs, and duplicate quotation handling.

### Phase C: Staging Read Sync (Phase 1 & 2 Live Reads)
- **Goal:** Replace Excel importers with live scheduled sync workers.
- **Tasks:**
  1. Configure `BFL_ODOO_SYNC=on` pointing to staging Odoo.
  2. Run initial full sync of:
     - `products` and `categories` (every 15 min; `write_date` cursor).
     - Stock levels: `qty_available` and `free_qty` context (every 5 min).
     - Customers (`res.partner`): import Odoo ID as permanent identity, price class, salesperson, credit limit, and balance.
  3. Verify data safety: ensure missing items are inactivated, never deleted.
  4. Decommission Excel customer and product manual import CLI once staging sync validates 100% parity.

### Phase D: Live Outbox Worker & Draft Quotations (Phase 4 Live Writes)
- **Goal:** Send customer orders directly to Odoo as draft quotations.
- **Tasks:**
  1. Activate `outbox-worker.js` against staging Odoo.
  2. Implement draft quotation creation with duplicate protection:
     - Check for existing quotation matching `client_order_ref`.
     - Create `sale.order` with zero line price (Odoo calculates price).
     - Read back assigned `odoo_number` (e.g. `S00456`) and update `odoo_orders`.
  3. Test registration approvals: writing new approved partners to `res.partner` with `registration_ref`.
  4. Validate retry backoff sequence: 1m, 5m, 15m, 60m, hourly up to 24h failure alert.
  5. Test kill switch: disabling `bfl-integration` queues orders safely without data loss.

### Phase E: Production Cutover, Telemetry & Acceptance Sign-off
- **Goal:** Final verification, monitoring dashboards, and deployment cutover.
- **Tasks:**
  1. Deploy to production server with persistent storage.
  2. Configure automated hourly payment reminders and month-end inventory snapshot cron jobs.
  3. Verify Sync Health dashboard (`/api/odoo/health`) and Daily Reconciliation report.
  4. Perform 50-product price match validation across all price classes.
  5. Obtain sign-off from Sales Manager and Operations Lead.

---

## 4. Database Schema Summary (44 Tables)

Refer to [DATA_MODEL.md](file:///c:/Users/hp/bos4less/BoxForLess/DATA_MODEL.md) for full column-by-column DDL and entity diagrams.

| Domain | Table Count | Tables |
|---|---|---|
| **Catalog & Products** | 5 | `products`, `categories`, `product_images`, `import_batches`, `import_changes` |
| **Customers & Staff Auth** | 5 | `customers`, `customer_imports`, `access_requests`, `staff_users`, `sales_users` |
| **Requests & Quotations** | 4 | `requests`, `request_items`, `quotations`, `request_shelf_acceptances` |
| **Odoo Sync & Outbox** | 4 | `odoo_outbox`, `sync_state`, `sync_changes`, `odoo_call_log` |
| **Odoo Financial & Sales** | 10 | `odoo_orders`, `odoo_invoices`, `odoo_invoice_lines`, `odoo_payments`, `odoo_credit_notes`, `odoo_returns`, `odoo_return_lines`, `return_classifications`, `odoo_customer_finance`, `order_check_log` |
| **Warehouse Expiry & Reps** | 9 | `expiry_actions`, `shelf_visits`, `shelf_visit_lines`, `delivery_lots`, `rep_visits`, `rep_visit_lines`, `lot_discounts`, `lot_discount_log`, `shop_reps` |
| **Rules & Reminders** | 4 | `visibility_rules`, `visibility_log`, `payment_schedules`, `payment_reminders` |
| **Reporting & Snapshots** | 3 | `stock_snapshots`, `report_targets`, `report_notes` |

# Phase Status

## Phase 1 — Product Master ✅ COMPLETE

Delivered and tested:
- [x] Validated two-step import (preview → Confirm Import); no DB writes before confirm.
- [x] Import preview with all required metrics (total/valid/invalid, new/existing/changed, barcode & UoM changes, inactivations, duplicate barcodes, missing values).
- [x] Stable internal product identity (`products.id`); `source_odoo_id` ready for future exports.
- [x] Product Master model with all required fields + review/data-quality flags.
- [x] Stock fields preserved; IN/LIMITED/OUT **computed on read** (no schema change needed later).
- [x] Repeatable imports: create / update / unchanged / inactivate (never delete) / reactivate.
- [x] Barcode & UoM changes **flagged for review**, never silently applied.
- [x] Import audit: `import_batches` + `import_changes` change log.
- [x] Data validation (required columns/fields, duplicates, numeric stock, unexpected columns reported not fatal).
- [x] Admin UI: Product Master (search + filters), Imports, Change Review.
- [x] Separate image + category architecture; never overwritten by import.
- [x] Transactional import with rollback (no partial imports).
- [x] 36 automated tests (covers all 18 required scenarios) + mutation-verified.
- [x] Fixture derived from the real export; original Excel never modified.
- [x] Full documentation set.

### Verified against the real export
3,879 rows → 3,879 created, 0 errors, 56 data-quality warnings. Re-import =
3,879 unchanged, 0 changes. See `data/data-quality-report.json`.


## Stage 2 — Customer Digital Product Catalog ✅ IMPLEMENTED

Customer-facing catalog at **`/catalog`**, built as a read-only, customer-safe
presentation layer over the existing Product Master. Full detail:
`STAGE_2_CATALOG.md`.

- [x] One database — no second product or image store; Product Master untouched.
- [x] Explicit customer-safe serializer (allow-list), enforced server-side.
- [x] Availability reuses the Product Master classification 1:1 (In / Limited / Out); no quantities exposed.
- [x] Search: name + barcode, case-insensitive, partial match (7–13 ms on 3,879 rows).
- [x] Filters (availability, with-image) with live counts; sorting Name A→Z / Z→A only.
- [x] Reuses the existing image architecture; "No product image available" placeholder.
- [x] Inactive products invisible and unreachable through every customer entry point.
- [x] Mobile-first UI; pagination (24/page, 12.6 KB JSON per 60 products).
- [x] 30 tests covering all 18 required cases; mutation-verified. Full suite 107/107.

**✅ Verified on a real iPhone (2026-10-02)** at `https://192.168.100.8:3443/catalog`:
Odoo categories, search, product detail, customer-safe fields, availability, the
preserved image for barcode 5283013330912, and correct image orientation.

### Stage 2.1 — Odoo categories + stable identity ✅ IMPORTED & VALIDATED
- [x] Fixed a critical alias defect that would have inverted the Product Master.
- [x] Real 3,883-row categorized export imported: 4 created, 3,879 updated, 0 inactivated.
- [x] Full Odoo category path preserved; 143-node hierarchy; FOOD/NON-FOOD/DRINKS & BEVERAGES/PETS kept separate.
- [x] Internal Reference stored as `source_odoo_id` and backfilled — barcode-change detection now possible.
- [x] Product photo preserved across re-import; import is idempotent.
- [x] Customer API exposes category names/path only. 139/139 tests pass.
- [x] **Mobile-verified on a real iPhone (2026-10-02).**

**Stage 2.1 is a CLOSED, verified baseline — checkpoint `v0.2.1`.**

### Explicitly NOT in Stage 2 (stop conditions honored)
- ❌ No request cart, ordering, checkout or payment.
- ❌ No pricing, cost, margin or discounts.
- ❌ No quotations or Odoo quotation export.
- ❌ No customer accounts, registration or salesperson assignment.
- ❌ No sales dashboard, no WhatsApp automation.

## Stage 3 — Customer Request Cart ✅ COMPLETE

Implemented, server-verified and **verified on a real iPhone (2026-10-03)**.
Released as `v0.3.0`. Detail: `STAGE_3_REQUESTS.md`.

- [x] Available Now (951) / Full Catalogue (3,883) browsing.
- [x] CTN-only request cart, server-validated, atomic submission.
- [x] Stock freshness BLOCKS submission when stale or missing (browsing unaffected).
- [x] Sub-1-CTN products keep Limited Stock badge but are not requestable.
- [x] Odoo customer master architecture; opaque handles; "not listed" path.
- [x] Staff read-only Requests view.
- [x] 188/188 tests; 9 mutants caught; production DB byte-identical to checkpoint.
- [x] **Real-iPhone verification PASSED (2026-10-03)** — all ten checks.
- [ ] Customer master import — BLOCKED pending an export with stable Customer IDs.

### Explicitly NOT in Stage 3
- ❌ No pricing, cost, margin, discounts or pricelists.
- ❌ No quotations or Odoo quotation export.
- ❌ No stock reservation, backorders or waitlists.
- ❌ No PCS or CTN↔PCS conversion.
- ❌ No customer accounts, login or passwords.

## Explicitly NOT in Phase 1 (stop conditions honored)
- ❌ No customer pricing (not imported, stored, or displayed).
- ❌ No customer ordering / request cart / sales dashboard.
- ❌ No quotation creation or Odoo quotation export.
- ❌ No direct Odoo connection.

## Future phases (schema already prepared)
| Phase | Scope | Prepared by |
|---|---|---|
| 2 | Image Library | STARTED — product photo capture+save implemented (scan page) |
| 3 | Customer Product Catalog | ✅ DONE — Stage 2, see `STAGE_2_CATALOG.md` |
| 4 | Request Cart | `requests`, `request_items` skeleton |
| 5 | Sales Dashboard | audit tables, `sales_users` |
| 6 | Odoo Quotation Export | `quotations` skeleton |
| 7 | Repeated Product Master updates | the import engine (done) |
| 8 | Direct Odoo integration | `source_odoo_id` identity, column aliases |

## Open business decisions
See the "Issues requiring business decisions" section of the handover / README.
Summary: (1) Odoo export has **no stable product ID** — recommend adding one;
(2) 39 barcodes contain embedded pack-size suffixes e.g. `...(*12)`;
(3) 11 unusually short barcodes; (4) 7 negative forecasted values.

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
- [x] ~~Customer master import — BLOCKED pending an export with stable Customer IDs.~~
      **Unblocked in Stage 4** by dropping the stable-id requirement and matching
      on display name instead (decision D1). 504 customers imported 2026-10-05.

### Explicitly NOT in Stage 3
- ❌ No pricing, cost, margin, discounts or pricelists.
  → Stage 4 stores a price-TIER NAME per customer (`customers.pricelist`). It is a
    label, never an amount, and no price is displayed anywhere. See `CLAUDE.md`.
- ❌ No quotations or Odoo quotation export.
- ❌ No stock reservation, backorders or waitlists.
- ❌ No PCS or CTN↔PCS conversion.
- ❌ No customer accounts, login or passwords.
  → Still true for customers: an access code is not an account and has no password.
    Stage 4 did add a **staff** sign-in for the admin area.

## Stage 4 — Customer Access, Customer Master & Staff Sign-in ✅ COMPLETE

Implemented, server-verified and **verified on a real phone (2026-10-05 / 06)**.
Released as `v0.4.1`. Detail: `STAGE_4_ACCESS.md`.

- [x] **Closed the customer-master exposure.** `GET /api/catalog/customers` is
      removed; it let anyone holding the public catalogue link enumerate all 504
      customer names. A per-customer access code replaced it.
- [x] Access codes — 8 characters, no ambiguous letters, rate-limited, reissuable,
      revoked by deactivating the customer.
- [x] **Submission identity comes from the signed session, never the request body** —
      a customer cannot order in another company's name even by crafting the payload.
- [x] **The session ends at submission**, enforced server-side by a session epoch —
      one salesman's phone visits several customers a day.
- [x] "I don't have a code" → staff approve → code issued. Asking and ordering are
      separate acts.
- [x] Delivery address required of a new company; carried onto their requests;
      editable per order without rewriting the customer record.
- [x] Customer master import with its own audit; codes issued automatically.
- [x] Staff sign-in over the admin area; `/catalog` stays public by design.
- [x] Request accept · Excel export · **withdraw (reversible) and restore**.
- [x] 280/280 tests; write paths exercised against a COPY of production.
- [x] **Real-device verification PASSED** — seven checks, see `STAGE_4_ACCESS.md`.

### Explicitly NOT in Stage 4
- ❌ No pricing displayed. A price TIER NAME is stored; no amount anywhere (D2).
- ❌ No customer accounts, logins or passwords — a code is not an account.
- ❌ No quotations or Odoo quotation export.
- ❌ No stock reservation; a request still holds nothing.
- ❌ No direct Odoo connection.
- ❌ No PCS; quantities remain CTN only.

### Decisions closed in Stage 4
| | |
|---|---|
| **D1** | Odoo has no customer identity, so the access code IS the identity. New customers are coded automatically on import. |
| **D2** | `pricelist` stores a tier NAME, never an amount. No price displayed pending a CEO decision. |
| **D3** | Absence on a customer import does NOT deactivate — a contact export is often a filtered view. |
| **D4** | Deleting a request withdraws it reversibly; nothing is destroyed. |
| **D5** | `/catalog` browsing stays public; the code gates *requesting*. |

## Explicitly NOT in Phase 1 (stop conditions honored)
- ❌ No customer pricing (not imported, stored, or displayed).
- ❌ No customer ordering / request cart / sales dashboard.
- ❌ No quotation creation or Odoo quotation export.
- ❌ No direct Odoo connection.

## Still to come

> The old numbered "Future phases" table was removed on 2026-10-06. It used a
> SECOND numbering that disagreed with the stage names used everywhere else — its
> "Phase 4 — Request Cart" is what shipped as **Stage 3**, and most of its rows
> were already delivered. Two numbering schemes for the same work is worse than
> none. The stages above are the record; what is genuinely outstanding is below.

| Not built yet | Prepared by | Note |
|---|---|---|
| **Deployment** | — | **The only thing between this and real customers.** Runs on a private LAN address today. See `CONTINUE_HERE.md`. |
| Image Library | `product_images`, `primary_image_id` | Partly there: photo capture and save work from the scan page. |
| Sales Dashboard | audit tables, `sales_users` | |
| Odoo Quotation Export | `quotations` skeleton | Blocked by the pricing decision (D2). |
| Direct Odoo integration | `source_odoo_id`, column aliases | Would also supply the stable customer id that D1 works around. |
| Showing prices | `customers.pricelist` holds a tier name | Awaiting the CEO decision (D2). Multiple price classes per customer type is a separate piece of work. |

## Open business decisions

**D1–D5 were closed on 2026-10-06** — see the table under Stage 4.

Still open, all from the Phase 1 data-quality review and none of them blocking:

1. The Odoo product export has **no stable product ID** — recommend adding one.
   (The same gap on the customer side is what D1 works around.)
2. 39 barcodes contain embedded pack-size suffixes, e.g. `...(*12)`.
3. 11 unusually short barcodes.
4. 7 negative forecasted values.

A fifth, newer one worth a look: the product imports on 2026-10-05 and 2026-10-06
both reported **`unchanged: 3883`** — every row identical to what was already
stored. Either stock genuinely has not moved, or the export is not carrying current
quantities. A daily import that changes nothing puts a fresh timestamp on stale
numbers, which is worse than not importing at all.

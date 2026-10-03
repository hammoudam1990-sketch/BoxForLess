# Stage 3 — Customer Request Cart & Submission

**Status:** implemented and server-verified. **Not yet verified on a real iPhone**,
so Stage 3 is *not* declared complete. See [Verification](#verification).

Quantities are **CTN only**. No PCS, no unit selection, no CTN↔PCS conversion, no
parsing of `CTN24` strings, no loose-piece logic.

---

## 1. What a request is — and is not

A request is a customer **asking** for products.

- **Not an order.** Nothing is committed.
- **Not a reservation.** No stock is held, so two customers can successfully
  request the same cartons. Deliberate, documented, and stated to the customer on
  the submission screen. Reservation belongs with quotations, in a later stage.
- **No pricing** anywhere: no price, cost, margin, discount or pricelist.

---

## 2. Browsing: Available Now vs Full Catalogue

| View | Means | Live count |
|---|---|---|
| **Available Now** (default) | active **and** `free_to_use > 0` | **951** |
| **Full Catalogue** | all active products | **3,883** |

"Available Now" is not the same as the **In Stock** band (which means *plenty*,
`> 5`). A product with 1 carton is *Limited Stock* but is still available now.
Selected over HTTP with `?view=available|full`; an unrecognised value falls back
to Available Now.

---

## 3. Requestability

A product can be requested only when **all** hold:

1. `is_active = 1`
2. stock data is **fresh** (§4)
3. **`floor(free_to_use) ≥ 1`** — at least one whole carton

Rule 3 covers the ~40 real products holding a part carton (e.g. `0.46`). They keep
their **Limited Stock** badge — Stage 2 banding is untouched — but show
*"Not available to request right now"* with no quantity control, rather than
offering a control whose every use would fail.

The catalog payload carries `requestable: true|false`. **A boolean, never a count.**

---

## 4. Stock freshness — a gate, not a warning

Odoo is the operational truth; this catalog holds a copy taken at the last import.
`config.stock.freshnessHours` (default **24**, env `BFL_STOCK_FRESHNESS_HOURS`).

| Stock state | Browsing | Submission |
|---|---|---|
| Fresh | ✅ | ✅ allowed |
| Older than threshold | ✅ | 🚫 **blocked** |
| No stock data at all | ✅ | 🚫 **blocked** |

Customers see only: *"Product availability needs to be refreshed before requests
can be submitted."* — no timestamp, no age. **Staff** see the real timestamp on the
Requests screen and at `GET /api/requests/stock-status`.

Enforced server-side on both validate and submit; the client cannot bypass it.

`src/domain/stock-source.js` hides where the numbers come from behind one
interface, so switching to a live Odoo API later is a swap, not a rewrite.
`LiveOdooStockSource` is specified and deliberately unimplemented — this project
has no Odoo API connection.

---

## 5. Customer identity

**Odoo's customer master is the source of truth.** `odoo_customer_ref` (the stable
`res.partner` id) is the only permanent identity stored on a request.

- Display name may **match** an incoming row to an existing record; it is never
  the stored identity, because a rename would otherwise orphan every request.
- **Phone is never an identity.** The real export contains `"0"` five times and
  `"Office"`.
- An export without a stable Customer ID is **refused** by the importer.
- `odoo_customer_ref` is **backfilled** onto a name-matched record — fills a NULL,
  never overwrites — the pattern already proven for `products.source_odoo_id`.

### 🔒 The customer master is intentionally EMPTY

The available `Contact (res.partner).xlsx` (355 rows) has **no stable Customer ID
column**, so it has **not** been imported and must not be. The architecture, schema
and tests are built and exercised with synthetic fixtures; the day a revised export
carries the id, one import fills it.

Until then the **"My company is not listed"** path is the live route.

### Opaque handles

Customer search returns the display **name** and an **opaque handle** — never the
Odoo customer id. The handle is a keyed digest (`config.customerSearch.handleSecret`,
env `BFL_CUSTOMER_HANDLE_SECRET`), resolved server-side at submission. It is a
transport token, not a secret: it names a company the customer already found by
typing its name.

### Selection UI

Search-only: **minimum 3 characters**, **capped results**, no browse-all, no count
disclosed.

> ⚠️ **Known limitation:** the catalog has no login, so anyone who can reach it can
> search the customer master and confirm whether a company exists. Search-only
> narrows this; it does not eliminate it. An access gate on `/catalog` is the real
> mitigation and is a Stage 4 decision.

### "Customer not listed"

Captures company + contact name + phone and stores an **unlinked** request
(`customer_id` NULL, `unlisted_*` set, `needs_customer_match = 1`) for staff to
reconcile. It **never** creates a customer master record, and there is no account,
login or password anywhere in Stage 3.

---

## 6. Submission validation

Server-side, every line, every submission. The client's view of availability is a
stale copy and is never trusted.

1. **Freshness gate first** — stale or absent stock rejects outright.
2. Re-read `free_to_use` for every product in the request.
3. Reject a line if: product inactive or unknown · quantity not a whole number ≥ 1
   · `floor(free_to_use) < 1` · **quantity > `floor(free_to_use)`**.
4. **Atomic** — any failing line rejects the whole submission (`409`). A partially
   written request is impossible: validation runs *inside* the transaction.
5. On success, persist `stock_as_of` and `available_ctn_at_request`.

All failing lines are reported together, so the customer fixes everything in one pass.

---

## 7. Data boundary

The customer API never returns: exact stock quantities · `free_to_use` · Odoo ids
(`source_odoo_id`, `odoo_customer_ref`) · internal `products.id` / `customers.id` /
request ids · import or change history · pricing, cost, margin, **pricelist** ·
customer phone, email or country · other customers' data.

**Rejection messages disclose no figure.** *"Availability changed for X. The
quantity you requested is no longer available — please reduce it."* This rules out
a "reduce to maximum" button, which would reveal the number. A deliberate trade.

Availability stays **In Stock / Limited Stock / Out of Stock** everywhere.

---

## 8. Data model (additive only)

**`products` — unchanged. No new columns.** The Product Master cannot regress.

| Table | Added |
|---|---|
| `customers` | `odoo_customer_ref` (unique when present) · `phone` · `country` |
| `requests` | `reference` · `unlisted_company` / `_contact` / `_phone` · `needs_customer_match` · `notes` · `submitted_at` · `stock_as_of` |
| `request_items` | `quantity_ctn` · `product_name_at_request` · `barcode_at_request` · `box_uom_at_request` · `available_ctn_at_request` |

`request_items.quantity` is the unused legacy skeleton column, kept because
migrations here are additive only.

**Snapshots** exist because products change: a request must still read correctly
months later. `ON DELETE RESTRICT` on `product_id` already protects history.

Indexes on new columns are created in `applyMigrations()`, **never** in
`schema.sql` — on a pre-Stage-3 database that file runs *before* the columns are
added, and an index there fails the whole open. This trap has now bitten twice;
`test/migration.test.js` exists so it cannot bite a third time silently.

---

## 9. API

| Route | Audience |
|---|---|
| `GET /api/catalog/products?view=available\|full` | customer |
| `GET /api/catalog/customers?q=` | customer — name + opaque handle only |
| `GET /api/catalog/requests/stock-status` | customer — verdict only, no timestamp |
| `POST /api/catalog/requests/validate` | customer — dry run, writes nothing |
| `POST /api/catalog/requests` | customer — validate **then** submit, one transaction |
| `GET /api/requests`, `/api/requests/:id`, `/api/requests/stock-status` | **staff** — internal detail |

The staff router is read-only: POST/PUT/PATCH/DELETE all return 404.

---

## 10. Files

**New:** `src/domain/stock-source.js` · `src/domain/requests.js` ·
`src/domain/customers.js` · `src/server/routes/requests.js` ·
`src/public/js/cart.js` · `src/public/js/request-ui.js` ·
`src/public/js/requests.js` · `scripts/checkpoint.js` ·
`test/requests.test.js` · `test/migration.test.js`

**Modified:** `src/config.js` · `src/db/schema.sql` · `src/db/connection.js` ·
`src/domain/catalog.js` · `src/server/routes/catalog.js` · `src/server/index.js` ·
`src/public/js/catalog.js` · `src/public/js/app.js` · `src/public/css/catalog.css` ·
`src/public/index.html` · `test/catalog.test.js`

---

## Verification

**Automated: 188/188 pass.** Nine mutants of the critical logic were introduced and
all caught — floor-vs-round, the stock comparison boundary, the freshness gate, the
sub-1-CTN guard, search field exposure, identity backfill, handle opacity, the
Available Now filter, and the inactive-product guard.

Two mutants initially **survived** and were only killed after adding a test:
identity-backfill overwrite (masked because a ref-matched row always has the same
ref) and the inactive guard (masked because a second layer also filters
`is_active`). Both are logged as a recurring lesson: redundant safeguards make a
mutation score misleading.

**Write path verified against a COPY** of the real database
(`/tmp/bfl-verify/verify.db`, port 3100) — never production: customer search
minimum length and cap · selection by opaque handle · forged and raw-ref handles
rejected · unlisted path · submission with snapshots · reference generation
(`REQ-2026-0001…`) · over-quantity rejection · sub-1-CTN rejection · inactive
rejection · stale-stock blocking with browsing still live · nothing written on any
failure · a 20-term leak probe across five customer endpoints returning **zero**
leaks · staff read-only view.

**Production database:** product, image and category data verified **byte-identical**
to the `v0.3.0-pre-stage3` checkpoint. Zero requests, zero customers.

**❌ Not verified on a real iPhone.** The cart, drawer, customer search and
submission have not been exercised on the device. Stage 3 is not complete until
they are.

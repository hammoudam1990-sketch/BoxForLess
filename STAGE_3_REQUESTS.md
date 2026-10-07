# Stage 3 — Customer Request Cart & Submission

**Status:** ✅ **COMPLETE** — implemented, server-verified, and **verified on a real
iPhone (2026-10-03)**. Released as `v0.3.0`. See [Verification](#verification).

> ## ⚠️ Read this first — parts of this document are history, not current behaviour
>
> This describes Stage 3 **as built on 2026-10-03**. Stage 4 changed four things it
> states, and each is marked `SUPERSEDED IN STAGE 4` where it appears:
>
> | This document says | What is true now |
> |---|---|
> | The customer master is intentionally EMPTY | 504 customers are imported and active |
> | An export without a stable Customer ID is refused | matched on display name instead (**D1**) |
> | `GET /api/catalog/customers` lists customers | **removed** — it made the customer book enumerable |
> | The staff router is read-only | it has accept, restore, export and a soft delete |
>
> The reasoning here is kept because it still explains *why* things are as they
> are. For how the system behaves today, read `IMPORT_RULES.md`, `CHANGELOG.md`
> from `0.4.0` onward, and `CONTINUE_HERE.md`.

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
  → ⚠️ **SUPERSEDED IN STAGE 4.** The refusal was removed. See below.
- `odoo_customer_ref` is **backfilled** onto a name-matched record — fills a NULL,
  never overwrites — the pattern already proven for `products.source_odoo_id`.

### ⚠️ SUPERSEDED IN STAGE 4 — the customer master is NOT empty

> **This section described Stage 3 as built on 2026-10-03 and is no longer true.**
> It is kept because the reasoning still matters; see `IMPORT_RULES.md` and the
> `0.4.0` entry in `CHANGELOG.md` for what actually happens now.
>
> Odoo never supplied a stable customer id, so rather than wait, the refusal was
> dropped and rows are matched on the **display name**, case- and
> spacing-insensitive. **504 customers are imported and active.** `odoo_customer_ref`
> stays nullable and is still matched first when present, so adding real Odoo ids
> later needs no migration — today no customer has one.
>
> The trade this accepts: renaming a company in Odoo creates a SECOND record with a
> NEW code, while the old record keeps the code already sent. That is the known
> cost of name-based identity (decision **D1**), and Odoo data is never edited or
> merged here to compensate.
>
> The **"My company is not listed"** path below is also gone. A company without a
> code now *asks* for one, staff approve, and a code is issued — asking and
> ordering are separate acts.

#### What Stage 3 originally said

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
| ~~`GET /api/catalog/customers?q=`~~ | ⚠️ **REMOVED IN STAGE 4** — see below |
| `GET /api/catalog/requests/stock-status` | customer — verdict only, no timestamp |
| `POST /api/catalog/requests/validate` | customer — dry run, writes nothing |
| `POST /api/catalog/requests` | customer — validate **then** submit, one transaction |
| `GET /api/requests`, `/api/requests/:id`, `/api/requests/stock-status` | **staff** — internal detail |

The staff router is read-only: POST/PUT/PATCH/DELETE all return 404.

> ### ⚠️ SUPERSEDED IN STAGE 4 — both statements above
>
> **`GET /api/catalog/customers` no longer exists.** Because the catalog is public,
> that endpoint let anyone holding the link type letters and read back real company
> names — the whole customer book was enumerable. A per-customer **access code**
> replaced it: the customer proves who they are instead of finding themselves in a
> list, so there is nothing left to search. Do not reintroduce a customer lookup on
> the customer router.
>
> **The staff router is no longer read-only.** It now has
> `POST /api/requests/:id/accept`, `POST /api/requests/:id/restore`,
> `GET /api/requests/:id/export.xlsx`, `DELETE /api/requests/:id` (a soft delete —
> the request is withdrawn, never destroyed), and the access-code and
> access-request routes. Every one of them sits behind the staff sign-in.
>
> Submission identity also changed: it comes from the signed access-code session,
> never from the request body, so a customer cannot submit in another company's
> name even by crafting the payload. The session ends at submission, because one
> salesman's phone visits several customers in a day.

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

> ⚠️ **That count was true when Stage 3 was verified on 2026-10-03 and is a record
> of that moment, not of today.** The customer list was imported on 2026-10-05 and
> real requests have been placed since. For the live figures, read the database —
> never this line. The byte-identical product, image and category data is the part
> worth preserving here: it is the evidence that Stage 3 added a request cart
> without disturbing the Product Master.

### ✅ Real-device verification — PASSED (iPhone, 2026-10-03)

Tested on a real iPhone over the LAN at `http://192.168.100.213:3000/catalog`,
against the committed build (`39b7a64`; served `catalog.js` / `cart.js` /
`request-ui.js` hash-matched the working tree). All ten checks passed:

| # | Check | Result |
|---|---|---|
| 1 | **Available Now** tab | ✅ |
| 2 | **Full Catalogue** tab | ✅ |
| 3 | Add-to-request control | ✅ |
| 4 | CTN increment / decrement | ✅ |
| 5 | Cart bar shows correct CTN and product count | ✅ |
| 6 | Cart drawer opens; quantity controls work | ✅ |
| 7 | Customer search behaves correctly | ✅ |
| 8 | "My company is not listed" path | ✅ |
| 9 | Submission succeeds and shows the request reference | ✅ |
| 10 | No exact stock, Odoo customer id, pricing or internal data exposed | ✅ |

Item 7 passed with the customer master **empty by design** — search correctly
returns nothing below three characters and nothing above it, because no customer
records exist until an export with stable `res.partner` ids is supplied. The
"not listed" path (item 8) is therefore the live route, exactly as intended.

### Environment note from the device session

Two LAN issues surfaced during testing, neither a defect in this project: the
machine's Wi-Fi address moved `192.168.100.8 → 192.168.100.213` (DHCP), and the
network was reclassified `Private → Public`, which left the existing
`LocalSubnet` firewall rules scoped to a profile that was no longer active and
silently dropped inbound traffic. Reclassifying the network as Private restored
it. The TLS certificate's SAN still lists only the old address, so LAN testing
uses **HTTP on port 3000**; only the barcode scanner needs a secure context.

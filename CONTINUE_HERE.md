# CONTINUE HERE — Box for Less Sales Catalog

**Updated:** 2026-10-05
**Released:** `v0.4.0` — Stage 4, customer access codes.
**Working tree:** clean at the tag.

---

## 1. Where things stand

| Stage | Scope | State |
|---|---|---|
| 1 | Product Master + audited two-step import | ✅ |
| 2 | Customer catalog `/catalog` | ✅ iPhone-verified 2026-10-02 |
| 2.1 | Odoo categories + `source_odoo_id` identity | ✅ checkpoint `v0.2.1` |
| 3 | CTN-only request cart | ✅ `v0.3.0`, iPhone-verified 2026-10-03 |
| 3.1 | Scanner 1080p + manual barcode entry | ✅ `v0.3.1`, iPhone-verified 2026-10-03 |
| **4** | **Customer import · staff auth · request actions · access codes** | ✅ **`v0.4.0`** — *not yet device-verified* |

### Live data

| | |
|---|---|
| Products (active) | 3,883 |
| Categories | 143 |
| Product images | 6 |
| **Customers** | **504** — all 504 hold an access code |
| Requests | 0 |
| Access requests | 1 |

Checkpoints: `v0.2.1`, `v0.2.1-post-uom923`, `v0.3.0-pre-stage3`, `v0.3.0-complete`,
`v0.3.1-complete`, `v0.3.1-pre-customer-import`, `v0.4.0-pre-access-codes`,
`v0.4.0-pre-stock-refresh`.

### Running it
```bash
node --env-file=.env.local src/server/index.js
```
`.env.local` holds the staff sign-in and is gitignored. Catalogue:
`http://<lan-ip>:3000/catalog` · scanner needs HTTPS on 3443.

---

## 2. What Stage 4 added

- **Customer-master import** — separate `customer_imports` audit so product import
  history is provably unchanged.
- **Staff authentication** — `/`, `/scan.html` and every admin API behind a signed
  8-hour session. `/catalog` stays public.
- **Request actions** — accept, Excel export, delete.
- **Per-customer access codes** — the catalogue is public to browse, but sending a
  request needs a code. The code *identifies* the customer, which is what allowed
  `GET /api/catalog/customers` to be deleted: that endpoint let anyone holding the
  link enumerate the whole customer book.
- **"I don't have a code"** — a company asks, staff approve, a code is issued.

---

## 3. ⚠️ Still open

### Decisions that reverse something previously written down
**D1 — Name-based customer identity.** 0 of 504 customers have an Odoo
`res.partner` id; matching is by display name, which Stage 3 argued must never be
an identity. Today a rename creates a *second* customer with a *new* code while the
old record keeps the code already sent. The Oct 5 import showed this live:
`TATA Africa Holdings (Ghana) limted` vs `...limited` became two records.
*Fix:* get the Customer ID column into the Odoo export and backfill.

**D2 — `pricelist` tier is stored.** `CLAUDE.md` forbids implementing or displaying
"any pricing", and `pricelist` was on the forbidden-columns list. A tier *name* is
now stored for every customer. It never reaches a customer payload (leak-tested),
but the rule needs amending or the column removing.

**D3 — `deactivateMissing` is off for customers**, on for products. The two
importers now differ on absence. State it in `IMPORT_RULES.md`.

**D4 — `DELETE /api/requests/:id` is a hard delete** with no audit row. It has
already cost information: two test requests vanished between Oct 4 and Oct 5 and
there is no record of who removed them. Consider `status = 'DELETED'`.

**D5 — `/catalog` is public to browse.** Settled for now: the access code gates
*requesting*, and removing customer search closed the enumeration hole. Revisit only
if product and stock-band visibility itself becomes a concern.

### Docs that still contradict the code
`STAGE_3_REQUESTS.md` is the worst offender — it still says the customer master is
"intentionally EMPTY", that an export without a stable Customer ID is "refused", and
that the staff router is "read-only". `PHASE_STATUS.md` still lists the customer
import as BLOCKED and has no Stage 4 section. `CLAUDE.md` / `AGENTS.md` still say
"Current phase: Phase 1". A `STAGE_4_ACCESS.md` matching the existing stage-doc
convention is the missing piece.

### Known gaps
- **Stage 4 has never been verified on a real iPhone.** Every earlier stage was.
- **The access-code keyboard bug is unconfirmed.** Reported twice on a real phone
  (keyboard closes after ~3 characters). Measured here: the DOM does *not* re-render
  and focus is *not* lost, so the JS is innocent. Two CSS causes were removed —
  `-webkit-overflow-scrolling: touch` on the fixed drawer, and `vh` ignoring the
  keyboard — plus a `visualViewport` hook. **Not reproducible off-device**; if it
  persists, move code entry to its own page outside the fixed drawer.
- **Stock freshness blocks submission 24h after each import.** Live, that means a
  daily import or a higher `BFL_STOCK_FRESHNESS_HOURS`.
- The 2026-10-05 stock import reported `unchanged: 3883` — the clock was reset but
  no figure moved. Worth confirming the export is actually current.

---

## 4. Going live

The app currently runs on a private LAN address, so **no customer can reach it**.
Deployment needs, in order:

1. A host running Node ≥ 22 with **persistent disk** (SQLite is a file on disk).
2. A domain and a real certificate, so customers see no security warning.
3. Secrets set in the host's own config: `BFL_STAFF_USERNAME`, `BFL_STAFF_PASSWORD`,
   `BFL_SESSION_SECRET`, `BFL_CUSTOMER_SESSION_SECRET`, `BFL_CUSTOMER_HANDLE_SECRET`,
   `NODE_ENV=production`.
4. A plan for the daily stock import.

---

## 5. Verification as of `v0.4.0`

| | |
|---|---|
| `npm test` | **269 / 269** |
| Customer journey, against a copy of live data | 29 / 29 |
| Staff journey, against a copy | 25 / 25 |
| Browser, real UI | no console errors on any screen |

Write paths are exercised against a **copy** of the production database, never
production — the convention Stage 3 established.

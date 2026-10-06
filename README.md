# Box for Less — Product Master (Phase 1)

The foundational **Product Master** for the Box for Less Digital Product
Catalog & Sales Request Application. Phase 1 delivers a safe, repeatable,
fully audited import pipeline from the Odoo *Product Variant* export, plus an
admin UI to search products, review imports, and approve flagged changes.

> **Pricing is intentionally out of scope.** No selling prices are imported,
> stored in, or displayed by the Product Master. See `PHASE_STATUS.md`.

---

## Quick start

```bash
npm install          # pure-JS deps only (no native build; uses node:sqlite)
npm run migrate      # create data/product_master.db
npm start            # http://localhost:3000
```

Node **>= 22** is required (for the built-in `node:sqlite` module).

### Staff sign-in before public use

The customer catalog stays public. Product management, imports, customer
details, and request actions require the staff sign-in. Configure these server
environment variables before starting the app:

- `BFL_STAFF_USERNAME` — staff sign-in name.
- `BFL_STAFF_PASSWORD` — private password of at least 12 characters.
- `BFL_SESSION_SECRET` — random secret of at least 32 characters, used to sign
  the eight-hour staff session cookie.
- `NODE_ENV=production` — enables secure cookies and proxy-aware HTTPS handling.
- `BFL_PUBLIC_URL` — the address customers reach the catalogue on, e.g.
  `https://catalogue.example.com`. **Required once deployed:** the catalogue link
  in the message staff send to customers is built from it. Without it the link
  falls back to the machine's own network address, which on a hosted server is an
  internal address no customer can open. On the LAN the fallback is correct.

If the staff credentials or session secret are missing or too short, staff
endpoints fail closed. Keep these values in the hosting provider's secret
settings; never commit them to this repository. Customer browsing and request
submission continue to work without a staff account.

### Import the Odoo export

**Via the UI:** open http://localhost:3000 → **Imports** → drop the `.xlsx` →
review the preview → **Confirm Import**.

**Via the CLI:**
```bash
node scripts/import-cli.js "C:/path/to/Product Variant (product.product).xlsx"            # preview only
node scripts/import-cli.js "C:/path/to/Product Variant (product.product).xlsx" --confirm  # apply
```

### Other commands
```bash
npm test                        # 36 automated tests (node --test)
npm run data-quality            # print + save data/data-quality-report.json
node scripts/make-fixtures.js   # regenerate fixtures/sample-products.xlsx (read-only on source)
```

---

## What Phase 1 does

- **Validated, two-step import**: upload → **preview** (no DB writes) → **Confirm Import** (one transaction).
- **Repeatable imports**: new products created, existing updated, missing ones **marked inactive (never deleted)**.
- **Human-in-the-loop safety**: barcode and UoM changes are **flagged for review**, never applied silently.
- **Full audit trail**: every import is a batch; every effect is a change-log row.
- **Admin UI**: Product Master (search + filters), Imports (history + preview/confirm), Change Review (accept/reject).
- **Stock status** (IN / LIMITED / OUT) is **computed on read** — ready for the customer catalog with no schema change.

## Architecture at a glance

```
src/
  config.js              # paths, stock thresholds
  db/        schema.sql, connection.js, migrate.js
  domain/    constants.js, normalize.js, stock.js, products.js, review.js
  import/    reader → headers → validate → planner → commit → service
  server/    index.js (Express) + routes/{products,imports,changes}.js
  public/    index.html + css + js modules (no single giant HTML file)
scripts/     import-cli.js, data-quality-report.js, make-fixtures.js
test/        36 tests covering the 18 required scenarios + edge cases
fixtures/    sample-products.xlsx (derived from the real export)
```

See `ARCHITECTURE.md`, `DATA_MODEL.md`, and `IMPORT_RULES.md` for detail.

## Stack & why

| Concern | Choice | Reason |
|---|---|---|
| Runtime | Node.js ≥ 22 | Available in-environment; `node:sqlite` built in |
| Database | SQLite via `node:sqlite` | Real persistent SQL, **zero native build**, one file, deployable |
| Backend | Express | Minimal, standard, maintainable |
| Excel | SheetJS (`xlsx`) | De-facto XLSX reader |
| Frontend | Static HTML/CSS/vanilla-JS modules | No build step, easy to maintain |
| Tests | `node --test` | Built-in, no extra tooling |

> **Security note:** `xlsx` carries a known npm advisory. Phase 1 parses only
> **trusted internal Odoo exports**. Revisit before accepting untrusted uploads.

## Project isolation

This project is fully self-contained (see `CLAUDE.md`). It does not read or
write any other project, and it never modifies the original Excel source file.

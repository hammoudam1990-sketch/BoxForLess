# Architecture

## Layers

```
┌─────────────────────────────────────────────────────────────┐
│ Frontend (src/public)                                        │
│   index.html shell + js modules: app(router), products,      │
│   imports, changes. Talks to the REST API only.              │
├─────────────────────────────────────────────────────────────┤
│ HTTP API (src/server)                                        │
│   Express app + routers: /api/products, /api/imports,        │
│   /api/reviews. Thin — delegates to domain/import layers.    │
├─────────────────────────────────────────────────────────────┤
│ Domain / business logic (src/domain)                         │
│   constants, normalize, stock (computed status), products    │
│   (search/detail/stats), review (accept/reject).             │
├─────────────────────────────────────────────────────────────┤
│ Import engine (src/import)                                   │
│   reader → headers → validate → planner → commit → service   │
│   Deterministic pipeline; planner never writes.              │
├─────────────────────────────────────────────────────────────┤
│ Database (src/db)                                            │
│   schema.sql applied by connection.js; node:sqlite file DB.  │
└─────────────────────────────────────────────────────────────┘
```

Each layer depends only on the ones below it. The import **planner** reads the
database but performs no writes, so the exact same code powers the preview and
the confirmed import.

## Import pipeline (deterministic)

`src/import/` implements the required 12-step pipeline:

| Step | Module | Writes? |
|---|---|---|
| 1 Read XLSX / 2 Validate workbook | `reader.js` | no |
| 3 Detect & map headers | `headers.js` | no |
| 4 Normalize values | `domain/normalize.js` | no |
| 5 Validate records | `validate.js` | no |
| 6 Match existing / 7 Calculate changes | `planner.js` | no |
| 8 Generate preview | `service.createPreview` | batch header only |
| 9 Confirm | `service.confirmImport` | — |
| 10 Apply transaction / 11 Audit | `commit.applyPlan` | **yes (atomic)** |
| 12 Import summary | `service` → batch counts | yes |

### Transaction safety
`confirmImport` runs `applyPlan` inside `BEGIN IMMEDIATE … COMMIT`. Any error
triggers `ROLLBACK` and the batch is marked `FAILED`, leaving the database
exactly as it was. Proven by the rollback test (an injected fault leaves zero
new rows and zero audit entries).

### Preview ≠ commit coupling
The uploaded file is copied into `data/uploads/<batchId>-<name>`. Confirm
**re-reads that file and re-plans against the current DB**, so a confirm is
correct even if the database changed between preview and confirm.

## Identity model

- `products.id` (autoincrement) is the **only** immutable identity. It is never
  derived from row order or barcode (verified by the identity test).
- `source_odoo_id` is the preferred external key **when a future export
  provides it**; it is unique when present.
- `barcode` is a mutable **business** identifier. Match precedence:
  `source_odoo_id` → `barcode`.

Because the current export exposes **no Odoo ID**, matching is barcode-based
today, and a barcode change is safely handled as *new product + inactivate old*
(nothing deleted). Once Odoo IDs are present, true barcode-change detection
(flag-for-review) activates automatically — already implemented and tested.

## Stock status
`domain/stock.computeStockStatus` derives IN_STOCK / LIMITED_STOCK /
OUT_OF_STOCK from `free_to_use` and the thresholds in `config.js`. It is
computed on read and **never stored**, so Phase 3 can expose it to customers
and tune thresholds without any migration.

## Deployment notes
- One Node process + one SQLite file. Copy the directory, `npm install`,
  `npm start`.
- WAL journal mode is enabled for better read/write concurrency.
- To move to Postgres later, only `db/` and the prepared statements change; the
  domain and import layers are SQL-light and portable.

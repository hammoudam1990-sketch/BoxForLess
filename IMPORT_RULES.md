# Import Rules

The import engine is **deterministic** and **non-destructive**. The preview and
the confirmed import run the same planning code; only confirm writes, and it
writes inside a single transaction.

## Matching precedence
1. `source_odoo_id` (when the row **and** an existing product both have one)
2. `barcode`
3. otherwise → **new product**

## Per-row outcomes

| Situation | Action | Audit |
|---|---|---|
| No match | **Create** product (active) | `PRODUCT_CREATED` |
| Match, Odoo fields differ (name/stock) | **Update** those fields | `PRODUCT_UPDATED` (one row per field, old→new) |
| Match, nothing differs | **Unchanged** — *no write at all* | none |
| Match, **UoM differs** | Flag only: set `uom_change_pending`, store `pending_uom`; **keep current UoM** | `UOM_CHANGE_DETECTED` (review PENDING) |
| Match by Odoo ID, **barcode differs** | Flag only: set `barcode_change_pending`, store `pending_barcode`; **keep current barcode** | `BARCODE_CHANGE_DETECTED` (review PENDING) |
| Matched product was inactive | **Reactivate** | `PRODUCT_REACTIVATED` |
| Existing active, import-sourced product absent from file | **Mark inactive** (never delete) | `PRODUCT_MARKED_INACTIVE` |

### Never overwritten by an import
- Product **images** (separate table; relationship preserved).
- Product **category** (`category_id`).
- Any future customer-facing or request/order data.
- Barcode and UoM values (change → review, not overwrite).

### Idempotency
Re-importing the same file produces **0 created / 0 updated / all unchanged** and
**no new change-log rows**. Unchanged rows are a true no-op (not even
`updated_at` moves). Verified on the real 3,879-row export and in tests.

## Validation

**Hard errors** (row is invalid → not created/updated, logged `VALIDATION_ERROR`):
- Missing barcode, name, or Box UoM.
- Non-numeric stock value (no silent repair).
- Duplicate barcode **within the file** (all colliding rows).
- Duplicate `source_odoo_id` within the file.

**Warnings** (row still imported, `data_quality_status = WARNING`):
- Negative stock value.
- Unusually short barcode (< 4 chars).
- Barcode containing non-alphanumeric characters.

**Workbook / column level:**
- Missing a **required column** (barcode / name / box_uom) → preview is `ok:false`,
  batch `FAILED`, nothing confirmable.
- **Unexpected columns are reported, never fatal, and never imported** (e.g. a
  stray price column cannot leak into the Product Master).

## Change review (application action, never an import)
Pending barcode/UoM changes appear in **Change Review**:
- **Accept** → apply `pending_*` value to the real column, clear the flag, mark
  the change `ACCEPTED`.
- **Reject** → discard `pending_*`, clear the flag, keep the current value, mark
  `REJECTED`.

The internal `id` is unchanged by either decision — identity is stable across a
barcode change.

## Column mapping
Headers are matched case/space-insensitively via aliases in
`src/domain/constants.js` (`COLUMN_ALIASES`). Current export headers map as:

| Source header | Canonical field |
|---|---|
| Barcode | barcode |
| Name | name |
| Box UoM | box_uom |
| On Hand (CTN, decimal) | on_hand |
| Free To Use (CTN) | free_to_use |
| Incoming (CTN) | incoming |
| Outgoing (CTN) | outgoing |
| Forecasted (CTN, decimal) | forecasted |
| *ID / External ID / Product ID* (future) | source_odoo_id |

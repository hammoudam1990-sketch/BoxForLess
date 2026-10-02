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
| Match, **category differs** | **Update** `odoo_category_path` + relink `category_id` | `CATEGORY_CHANGE_DETECTED` (old→new path) |
| Match, row has **no category value** | **Keep** the stored category — an absent column means *no information*, never "clear it" | none |
| Match, **UoM differs** | Flag only: set `uom_change_pending`, store `pending_uom`; **keep current UoM** | `UOM_CHANGE_DETECTED` (review PENDING) |
| Match by Odoo ID, **barcode differs** | Flag only: set `barcode_change_pending`, store `pending_barcode`; **keep current barcode** | `BARCODE_CHANGE_DETECTED` (review PENDING) |
| Matched product was inactive | **Reactivate** | `PRODUCT_REACTIVATED` |
| Existing active, import-sourced product absent from file | **Mark inactive** (never delete) | `PRODUCT_MARKED_INACTIVE` |

### Never touched by an import
- Product **images** — fully **application-controlled**. An import never creates,
  replaces, detaches or deletes an image, and never alters `primary_image_id` or
  any `product_images` row. Verified on the real export: the stored photo for
  barcode `5283013330912` survived the re-import unchanged.
- Any future customer-facing or request/order data.
- Barcode and UoM **values** (change → review, not overwrite — see below).

### Product category — Odoo is the source of truth (Stage 2.1, 2026-10-02)
This **narrowed an earlier rule** that said categories were application-controlled
and never written by an import. The narrowing is limited and deliberate:

- The export's **Product Category** column is the source of truth.
- The import stores the **complete path verbatim** in `products.odoo_category_path`
  (e.g. `FOOD / SPICES & SEASONINGS / GROUND SPICES`), so top level, parent and
  leaf stay distinguishable. The hierarchy is never flattened to Food/Non-Food.
- The import **may create and update** nodes in the `categories` table (keyed on
  `path`, linked by `parent_id`) and set `products.category_id` to the leaf. Node
  creation is idempotent — an already-materialised path performs no writes.
- Every category assignment or change is recorded in `import_changes` as
  **`CATEGORY_CHANGE_DETECTED`**, carrying the old and new path, so a previous
  category remains visible in history and is never silently overwritten.
- Category changes are **applied, not review-gated** (Odoo owns the field).
  Barcode and UoM remain review-gated.
- **Images are unaffected by this change** and remain fully application-controlled.

### Idempotency
Re-importing the same file produces **0 created / 0 updated / all unchanged** and
**no new change-log rows**. Unchanged rows are a true no-op (not even
`updated_at` moves). Verified on the real 3,883-row export and in tests.

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
| Internal Reference | **source_odoo_id** |
| Barcode | barcode |
| Name | name |
| Product Category | **category_path** |
| Box UoM | box_uom |
| On Hand (CTN, decimal) | on_hand |
| Free To Use (CTN) | free_to_use |
| Incoming (CTN) | incoming |
| Outgoing (CTN) | outgoing |
| Forecasted (CTN, decimal) | forecasted |
| *ID / External ID / Product ID* | source_odoo_id (alternative aliases) |

> **`Internal Reference` maps to `source_odoo_id`, NOT to `barcode`.** In Odoo it
> is `default_code` — the stable product reference, not the EAN. It was briefly
> listed as a barcode alias; with an export carrying *both* columns that captured
> Internal Reference as the barcode and discarded the real Barcode column as a
> duplicate target, which would have made every product look new. The import now
> **backfills** `source_odoo_id` onto products matched by barcode: it only ever
> fills a NULL and never overwrites an existing id. This is what makes
> barcode-change detection possible, since that check requires a stable-id match.

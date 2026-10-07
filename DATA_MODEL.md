# Data Model

SQLite. All timestamps are ISO-8601 UTC text. Full DDL: `src/db/schema.sql`.

## Phase 1 tables (active)

### `products` — the Product Master
| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | **Stable internal identity.** Never from row/barcode. |
| `source_odoo_id` | TEXT | Preferred external key; unique when present; **NULL today** (export has no ID). |
| `barcode` | TEXT NOT NULL | Business identifier; mutable; changes are reviewed. |
| `name` | TEXT NOT NULL | Odoo-controlled. |
| `box_uom` | TEXT | Odoo-controlled; change requires review. |
| `on_hand`, `free_to_use`, `incoming`, `outgoing`, `forecasted` | REAL | Odoo-controlled stock (informational). |
| `is_active` | INTEGER | 0 = not in latest Odoo export (never deleted). |
| `primary_image_id` | INTEGER FK → product_images | App-controlled; **never touched by import**. |
| `category_id` | INTEGER FK → categories | App-controlled; **never touched by import**. |
| `barcode_change_pending` / `uom_change_pending` | INTEGER | Review flags. |
| `pending_barcode` / `pending_uom` | TEXT | Incoming value awaiting review (not yet applied). |
| `data_quality_status` | TEXT | OK / WARNING / ERROR. |
| `data_quality_notes` | TEXT | Human-readable warnings. |
| `created_at` / `updated_at` | TEXT | |
| `last_import_id` | INTEGER FK → import_batches | Import that last updated Odoo data. |
| `last_seen_import_id` | INTEGER FK → import_batches | Import that last created/updated it. |

Indexes: unique partial on `source_odoo_id`, plus `barcode`, `name`, `is_active`.

### `product_images`
Separate relationship so images **never** live in a column an import overwrites.
`product_id`, `is_primary`, `filename`, `url_reference`, `uploaded_at`,
`is_active`, `sort_order`. Supports one primary + many additional images.
(Phase 2 populates this; Phase 1 only guarantees the relationship survives imports.)

### `categories`
Application-controlled taxonomy: `name` (unique), `parent_id` (hierarchy),
`is_active`. **Never derived from product names or populated by import.**

### `import_batches` — audit header (one per import)
`filename`, `file_hash`, `stored_path`, `imported_at`, `confirmed_at`,
`completed_at`, counts (`total_rows`, `valid_rows`, `invalid_rows`,
`created_count`, `updated_count`, `unchanged_count`, `inactive_count`,
`reactivated_count`, `barcode_change_count`, `uom_change_count`,
`warning_count`, `error_count`), `status` (PREVIEW / CONFIRMED / COMPLETED /
FAILED), `preview_json`, `notes`.

### `import_changes` — per-event change log
`import_batch_id`, `product_id`, `change_type`, `field`, `old_value`,
`new_value`, `row_number`, `barcode`, `review_status` (NA / PENDING / ACCEPTED /
REJECTED), `message`, `created_at`.

`change_type` ∈ { PRODUCT_CREATED, PRODUCT_UPDATED, BARCODE_CHANGE_DETECTED,
UOM_CHANGE_DETECTED, PRODUCT_MARKED_INACTIVE, PRODUCT_REACTIVATED,
VALIDATION_ERROR }.

## Forward-compatibility skeleton (created, unused in Phase 1)
`customers`, `sales_users`, `requests`, `request_items`, `quotations` exist so
later phases attach without restructuring the Product Master. `request_items`
references `products(id)` with `ON DELETE RESTRICT` — order/request history can
never be orphaned by a product change. No Phase 1 code reads or writes these.

## Relationship diagram
```
categories ─┐
            ├──< products >── product_images
            │        │  ^
            │        │  └── primary_image_id
import_batches ──< import_changes >── products
(future) customers ─< requests >─ request_items >── products
                     requests ─< quotations
```

# Stage 2 — Customer Digital Product Catalog

**Status:** implemented, server-verified against the real 3,883-product database.
**Not yet verified on a real iPhone** — see [Verification status](#verification-status).

---

## 1. Architecture

```
            ┌─────────────────────────────────────────┐
            │   product_master.db   (ONE database)    │
            │   products · product_images · …         │
            └───────────────┬─────────────────────────┘
                            │  read-only
        ┌───────────────────┴───────────────────┐
        │                                       │
┌───────▼─────────────────┐       ┌─────────────▼──────────────────┐
│  PRODUCT MASTER (admin) │       │  CUSTOMER CATALOG (Stage 2)    │
│  /  ·  /scan.html       │       │  /catalog                      │
│  /api/products          │       │  /api/catalog                  │
│  sees everything        │       │  customer-safe projection only │
└─────────────────────────┘       └────────────────────────────────┘
```

**Product Master = source of truth. Customer Catalog = customer-safe presentation layer.**

- **One database.** No second product table, no second image table, no second
  storage directory, no copy of the catalog data.
- **Read-only.** Nothing in the catalog path writes to the database.
- **Additive.** No Product Master route, query, template or test was modified.
  The only edit to an existing file is three router/page lines in
  `src/server/index.js`.

### Files

| File | Role |
|---|---|
| `src/domain/catalog.js` | Customer-safe serializer + all catalog queries |
| `src/server/routes/catalog.js` | `/api/catalog/*` — read-only REST |
| `src/public/catalog.html` | Customer page shell |
| `src/public/js/catalog.js` | Customer UI (list, search, filters, detail) |
| `src/public/css/catalog.css` | Customer styles — **separate** from admin `styles.css` |
| `test/catalog.test.js` | 30 tests |

---

## 2. Customer-safe data model

Every customer payload is built field-by-field by `toCatalogProduct()`. It never
spreads, copies or deletes from a Product Master row, so **a column added to
`products` later cannot leak by default** — it has to be added to the allow-list
deliberately.

```js
{
  id:   "5283013330912",        // PUBLIC id = barcode. NEVER products.id.
  name: "PLEIN SOLEIL CHICKEN STOCK 20G * 24",
  barcode: "5283013330912",
  pack: "CTN24",                // box_uom, renamed for customers
  category: null,               // category name, or null
  availability: { status: "IN_STOCK", label: "In Stock", tone: "in" },
  image: { url: "/api/catalog/products/5283013330912/image" }  // or null
}
```

`CUSTOMER_SAFE_FIELDS` in `src/domain/catalog.js` is the authoritative list; a
test asserts the serializer's output keys equal it exactly.

### Deliberately excluded

Price · cost · margin · `on_hand` · `free_to_use` · `incoming` · `outgoing` ·
`forecasted` · `products.id` · `primary_image_id` · `category_id` ·
`source_odoo_id` · `last_import_id` · `last_seen_import_id` · import batches ·
change history · review flags (`barcode_change_pending`, `uom_change_pending`,
`pending_barcode`, `pending_uom`) · `data_quality_status` / `_notes` ·
`is_active` · `created_at` / `updated_at` · image `filename` / `url_reference` ·
the raw `stock_status` enum string.

`FORBIDDEN_CUSTOMER_FIELDS` encodes this list, and a test walks every nested key
of every customer endpoint asserting none appears.

### Why the public id is the barcode

Requirement §12 forbids database implementation details in customer URLs and §13
forbids returning internal IDs. `products.id` is both. The barcode is explicitly
customer-safe (§2) and was verified **unique across all 3,879 rows**, so it is
the public key. Internal ids never leave the server; the image route resolves
barcode → internal id server-side only.

---

## 3. Availability rules

The catalog **reuses the Product Master's own classification** —
`computeStockStatus()` in `src/domain/stock.js` — and maps it 1:1:

| Product Master (`src/domain/stock.js`) | Condition on `free_to_use` | Customer sees |
|---|---|---|
| `IN_STOCK` | `> 5` | 🟢 **In Stock** |
| `LIMITED_STOCK` | `> 0` and `<= 5` | 🟡 **Limited Stock** |
| `OUT_OF_STOCK` | `<= 0` | 🔴 **Out of Stock** |

Thresholds come from `config.stock` (`outOfStockAtOrBelow: 0`,
`limitedAtOrBelow: 5`, `availabilityField: 'free_to_use'`) — the *same* config
object the admin side reads, so the two can never drift. No new classification
was invented.

**The quantity is consumed inside the serializer and never travels further.** A
test asserts the Product Master's `stock_status` and the catalog's
`availability.status` agree for every product in the database.

Availability *filtering* is done in SQL from those same thresholds, so paging
totals are correct rather than filtered after the fact.

Current real data: **428** In Stock · **522** Limited · **2,929** Out of Stock.

---

## 4. API routes

All read-only. All scoped to `is_active = 1`.

| Route | Returns |
|---|---|
| `GET /api/catalog/products` | `{ total, limit, offset, items[] }` |
| `GET /api/catalog/facets` | `{ all, in_stock, limited, out_of_stock, with_image }` |
| `GET /api/catalog/products/:id` | one customer-safe product, or `404` |
| `GET /api/catalog/products/:id/image` | the primary image bytes, or `404` |

`:id` is the **public id (barcode)**.

Query parameters on `/products`:

| Param | Values | Default |
|---|---|---|
| `search` | free text | — |
| `availability` | `in_stock` · `limited` · `out_of_stock` | all |
| `with_image` | `true` | false |
| `sort` | `name_asc` · `name_desc` | `name_asc` |
| `limit` | 1–60 (capped) | 24 |
| `offset` | ≥ 0 | 0 |

Unrecognised `sort` and `availability` values fall back to the safe default
rather than reaching SQL.

### Page routes

| URL | Serves |
|---|---|
| `/catalog` | catalog shell |
| `/catalog/product/:id` | same shell; the client renders the detail view |

Both are declared before `express.static`, so `/catalog` needs no `.html` and a
deep link survives a refresh. `catalog.html` references its assets by absolute
path (`/css/catalog.css`, `/js/catalog.js`) so the nested URL resolves them.

---

## 5. Search

- Matches **product name** and **barcode**.
- **Case-insensitive** (`UPPER(col) LIKE UPPER(?)` — explicit, not relying on a
  SQLite default).
- **Partial / substring** on both fields (`%term%`), so `soleil` matches
  `PLEIN SOLEIL …` mid-string.
- Always parameterised; the search term never reaches SQL as text.
- Debounced 220 ms in the UI.

Measured on the real 3,879-row database: **7–13 ms** per query.

No customer-safe SKU field exists in the data (`source_odoo_id` is NULL for all
3,879 products and is forbidden anyway), so barcode is the only identifier
searched besides name.

---

## 6. Filters and sorting

Chips: **All · In Stock · Limited Stock · Out of Stock**, each with a live count
from `/api/catalog/facets`. **With Image** appears only when at least one product
has an image (currently 1), so the UI never offers a filter that returns nothing.

Sorting is **Name A→Z / Z→A** only. Sort keys are looked up in a whitelist map;
stock quantities are never a sort key.

---

## 7. Image handling

Reuses the existing architecture unchanged:

```
products.primary_image_id → product_images → data/product-images/
```

- No second image table, no second storage system.
- Served through `GET /api/catalog/products/:id/image`, which resolves the public
  id to the internal id **server-side** and then calls the existing
  `readPrimaryImage()`.
- The storage **filename is never disclosed** in any payload.
- Missing image → `image: null` → the UI renders
  **"No product image available"**. With only 1 of 3,879 products carrying a
  photo, this is the normal path, not an edge case.
- A broken image load falls back to the same placeholder (no broken-image icon).
- `loading="lazy"` + `decoding="async"` on grid thumbnails; `Cache-Control:
  public, max-age=300` on the image response.

---

## 8. Mobile UX

Mobile-first: base CSS is the phone layout, media queries add width.

- 2-column grid on a phone → 3 at ≥560 px → 4 at ≥860 px.
- Touch targets ≥ 44 px (`--c-tap`); chips and buttons sized to it.
- Search input is **16 px**, which stops iOS Safari zooming on focus.
- `viewport-fit=cover` + `env(safe-area-inset-*)` for the iPhone notch.
- Horizontally scrollable filter chips with hidden scrollbars.
- Square `aspect-ratio` thumbnails with `object-fit: contain` — no layout shift
  as images load, and no cropping of product packaging.
- Lazy images, 24 per page, **12.6 KB of JSON for 60 products**.
- Client-side navigation between list and detail (no full page reload).

---

## 9. Security

The server enforces it; nothing relies on CSS or client-side hiding.

1. **Allow-list serializer.** `toCatalogProduct()` constructs a fresh object.
   There is no spread, no `delete`, no "omit these" list to forget to update.
2. **Narrow SELECTs.** Catalog queries select only the columns the serializer
   needs — a second, independent barrier.
3. **`is_active = 1` is the first clause of every catalog query**, not an
   optional filter the caller can turn off.
4. **Inactive = invisible, indistinguishably.** An inactive product returns the
   same `404` as a non-existent one, and the 404 body does not name it.
5. **No internal ids in URLs or payloads.**
6. **Whitelisted sort and filter values**; parameterised search.
7. The catalog API is **read-only** — no POST, PUT, PATCH or DELETE exists.

---

## 10. Testing

`test/catalog.test.js` — **30 tests**, covering all 18 required cases:

| # | Case | # | Case |
|---|---|---|---|
| 1 | Active product appears | 10 | Limited Stock status |
| 2 | Inactive product does not appear | 11 | Out of Stock status |
| 3 | Image appears when available | 12 | Customer product detail |
| 4 | Missing image → placeholder | 13 | Sensitive fields NOT returned |
| 5 | Product-name search | 14 | Internal IDs NOT returned |
| 6 | Partial-name search | 15 | Source Odoo ID NOT returned |
| 7 | Barcode search | 16 | Exact quantities NOT returned |
| 8 | Case-insensitive search | 17 | Inactive unreachable via catalog |
| 9 | In Stock status | 18 | Product Master intact |

Plus: catalog/master classification agreement across every product, availability
filter correctness, facets, sorting, page-size cap, pagination totals, page
routing, `with_image`, and the image endpoint.

Inactive products are produced **the real way** — a later import that omits the
product — so the tests prove catalog visibility derives from Product Master
lifecycle, not from a flag poked directly.

**Full suite: 107/107 pass** (77 pre-existing + 30 new). No existing test was
changed or removed.

### Mutation verification

Six deliberate defects were introduced and reverted; all are caught:

| Mutant | Caught by |
|---|---|
| Serializer spreads the raw row | 5 tests |
| `is_active` guard removed from search | 3 tests |
| `is_active` guard removed from detail | 1 test |
| Public id becomes `products.id` | 1 test (13d) |
| Availability carries the quantity | 1 test |
| Image route skips the inactive check | 1 test |

The public-id mutant initially **survived**: the queries do not `SELECT p.id`, so
the defence-in-depth masked it — and would have stopped masking it the moment
someone added `p.id` to a SELECT. Test 13d was added to bite on the serializer
directly, independent of which columns a query happens to select.

---

## 11. Known limitations

1. **~~Categories are empty~~ — RESOLVED in Stage 2.1.** All 3,883 products now
   carry a full Odoo category path and the filter UI is live. See section 14.
2. **Only 1 of 3,879 products has a photo.** "No product image available" is
   therefore the dominant state. This is a data-entry matter, not a code one.
3. **Public URLs key on the barcode, which is mutable.** Barcode changes go
   through Product Master review, and an approved change will change that
   product's catalog URL. Acceptable for a catalog; worth noting before any URL
   is printed or shared externally. Barcodes are currently unique across all
   3,879 rows.
4. **No `source_odoo_id` anywhere** — NULL for all products. Irrelevant to the
   catalog (the field is forbidden) but it means barcode is the only external
   identifier that exists.
5. **No image thumbnails.** Stored images are already ≤1280 px and
   JPEG-compressed at capture, and the grid lazy-loads them. If a future import
   brings large images, a server-side thumbnail step should be added.
6. **Offset pagination.** Fine at 3,879 products; revisit if the catalog grows
   by an order of magnitude.
7. **No access control.** The catalog is open to anyone who can reach the server
   — currently the LAN only. Customer accounts are explicitly a later stage.

---

## 12. Verification status

**Server-verified** against the real database: page routes 200, facets match a
direct SQL count exactly (428 / 522 / 2,929), search returns 111 matches for
`soleil` case-insensitively, detail and image endpoints work, and a 17-field leak
probe over a 60-product page came back clean.

**✅ Verified on a real iPhone (2026-10-02)** at `https://192.168.100.8:3443/catalog`:
Odoo categories, product search and detail, customer-safe fields, availability,
the preserved product image for barcode 5283013330912, and correct image
orientation all confirmed on the device.

---

## 13. Out of scope (Stage 3+)

Not implemented, by instruction: request cart · quotations · pricing · discounts
· ordering · Odoo quotation export · sales dashboard · customer accounts ·
payment · checkout · "Add to request" · customer registration · salesperson
assignment · WhatsApp automation.

---

---

## 14. Odoo categories (Stage 2.1)

**Odoo is the source of truth for the product category.** The complete path is
stored verbatim and never reduced to Food/Non-Food.

### Hierarchy as it really is

| Top level | Products |
|---|---|
| FOOD | 2,581 |
| NON-FOOD | 701 |
| DRINKS & BEVERAGES | 598 |
| PETS | 3 |

143 nodes: 4 top level, 33 second level, 106 leaves. 107 distinct paths; 3,744
products sit at depth 3 and 139 at depth 2. **Every product is categorised.**

```
FOOD / SPICES & SEASONINGS / GROUND SPICES
 └ top level = FOOD   parent = SPICES & SEASONINGS   name = GROUND SPICES
```

A 2-level path reports `parent: null` rather than inventing one.

### Storage

- `products.odoo_category_path` — complete path, verbatim. Source of truth.
- `categories` — the same paths materialised as a tree (`path` UNIQUE, `level`,
  `parent_id`); `products.category_id` points at the leaf. A derived index over
  Odoo's truth, **not** a second source of it.
- `categories.name` is deliberately NOT unique: real data contains
  `DRINKS & BEVERAGES / JUICES & NECTARS / JUICES & NECTARS`.

### Change handling

Category changes are **applied** (Odoo owns the field) and recorded as
`CATEGORY_CHANGE_DETECTED` in `import_changes` with the old and new path, so
history is never silently overwritten. An export with **no** category column
leaves stored categories untouched — an absent column means "no information",
never "clear it".

### Identity

Internal Reference → `source_odoo_id` (the field the schema already reserved for
it). Backfilled on barcode match; it only ever fills a NULL and never overwrites.
All 3,883 products now carry a unique stable id, which activates barcode-change
detection for the first time — a barcode change is still review-gated and never
auto-applied.

### Customer API

```json
"category": { "top_level": "FOOD", "parent": "SPICES & SEASONINGS",
              "name": "STOCK & BOUILLON",
              "path": "FOOD / SPICES & SEASONINGS / GROUND SPICES" }
```

`GET /api/catalog/categories` returns the tree with rolled-up counts. Filters:
`top_level` and `category_path` (both match that node and its descendants).
**Names and paths only** — no `category_id`, no `parent_id`, no Odoo id. The
category is derived from the path, never from the categories table, so no
database id can reach a customer by any route.

### The four top-level categories are NOT merged

FOOD, NON-FOOD, DRINKS & BEVERAGES and PETS are preserved exactly as Odoo
defines them. Whether DRINKS & BEVERAGES and PETS should fold into FOOD for
customer navigation is **deliberately left open**.

### Real import result

4 created · 3,879 updated · **0 inactivated** · 0 invalid rows · 54 data-quality
warnings · 1 UoM change flagged for review · 0 barcode changes. Photo on
5283013330912 preserved. A repeat import reports 3,883 unchanged and writes
nothing.

---

## Open the catalog

| Where | URL |
|---|---|
| This computer | `http://localhost:3000/catalog` |
| iPhone / LAN | `http://192.168.100.8:3000/catalog` |
| iPhone over HTTPS | `https://192.168.100.8:3443/catalog` |

The Product Master is unchanged at `http://localhost:3000/`.

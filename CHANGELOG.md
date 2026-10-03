# Changelog

All notable changes to this project are documented here.

## [0.3.0-rc.1] — 2026-10-03 — Stage 3: customer request cart & submission (CTN only)

**Release candidate — NOT yet verified on a real iPhone**, so Stage 3 is not
declared complete. Full detail: `STAGE_3_REQUESTS.md`.

### Added
- **Request cart and submission.** A customer builds a request from the catalog and
  submits it. Quantities are **CTN only** — no PCS, no conversion, no `CTN24`
  string parsing. A request is **not an order and not a reservation**; Stage 3
  holds no stock, which is stated to the customer.
- **Available Now / Full Catalogue.** Available Now (the default) = active products
  with stock on hand (951); Full Catalogue = all active products (3,883).
- **Stock freshness is a gate, not a warning.** Browsing always works, but
  submission is **blocked** when stock data is older than
  `config.stock.freshnessHours` (default 24) or missing entirely.
- **Customer identity from Odoo's customer master**, keyed on the stable
  `res.partner` id, backfilled onto name-matched records, never overwritten.
  Phone is never an identity. Search is **search-only**: min 3 characters, capped,
  no browse-all. Results carry an **opaque handle**, never the Odoo customer id.
- **"My company is not listed"** path storing an unlinked request for staff to
  reconcile — no accounts, no login, and no customer master record is ever created.
- **Staff Requests screen** (read-only) with the last stock-import timestamp.
- `scripts/checkpoint.js` — repeatable, verified data checkpoints.
- `test/migration.test.js` — the schema UPGRADE path finally has coverage. Every
  other test builds a fresh database, so a migration could be wholly broken with
  the suite green; that trap had already bitten twice.

### Security / data boundary
- The customer API never returns exact stock, `free_to_use`, Odoo ids, internal
  ids, import history, pricing/pricelist, or customer phone/email/country.
- Rejection messages disclose **no figure** — which deliberately rules out a
  "reduce to maximum available" button.
- Products holding less than one whole carton keep their Limited Stock badge but
  are **not requestable**; the payload carries a boolean, never a count.

### Changed
- `products` table **unchanged** — no new columns, so the Product Master and
  catalog cannot regress. All migration is additive on the previously unused
  `customers` / `requests` / `request_items` skeleton.

### Not done
- The 355-row contact export is **not imported**: it has no stable Customer ID.
  The customer master ships empty by design.
- Live Odoo API stock lookup: designed behind one interface, unimplemented.
- Quotations, pricing, reservations, PCS: out of scope.

### Tests
- **188/188 pass.** Nine mutants introduced and all caught; two initially survived
  and were killed by adding tests that exercise each guard in isolation.
- Write path verified against a **copy** of the real database; production verified
  byte-identical to the `v0.3.0-pre-stage3` checkpoint.

## [0.2.1] — 2026-10-02 — Odoo product categories + stable identity

**✅ STAGE 2.1 COMPLETE — mobile-verified on a real iPhone, checkpoint `v0.2.1`.**
Confirmed at `https://192.168.100.8:3443/catalog`: Odoo categories, search,
product detail, customer-safe fields, availability, the preserved image for
barcode 5283013330912, and correct image orientation.

Imported the categorized Odoo export (3,883 rows). **Odoo is now the source of
truth for the product category.** Full detail: `STAGE_2_CATALOG.md`.

### Fixed — CRITICAL
- `COLUMN_ALIASES` listed `internalreference`/`reference` as **barcode**
  aliases. In Odoo "Internal Reference" is `default_code`, not the EAN. With an
  export carrying BOTH columns it captured Internal Reference as the barcode and
  dropped the real Barcode column as a duplicate target, while "Product Category"
  was silently discarded as unexpected. A dry run proved this would have
  **created 3,883 products and deactivated all 3,879 existing ones — including
  the one holding a product photo — while reporting zero errors.** The aliases
  now belong to `source_odoo_id`.

### Added
- `src/domain/categories.js` — pure path parsing (`topLevel`/`parent`/`name`/
  `path`) plus idempotent hierarchy materialisation.
- `products.odoo_category_path` — the complete Odoo path, verbatim.
- `ChangeType.CATEGORY_CHANGE_DETECTED` — every category change is written to
  `import_changes`, so the previous category stays visible in history.
- Customer API: `GET /api/catalog/categories` (tree + counts, names only) and
  `top_level` / `category_path` filters on `/api/catalog/products`.
- Catalog UI: top-level and second-level category chips; category on card + detail.
- `test/categories.test.js` — 32 tests covering all 19 required cases.

### Changed — schema
- `categories` rekeyed on `path` (UNIQUE) with `level` and `parent_id`. The old
  `UNIQUE(name)` was incompatible with real Odoo data, which contains a child
  repeating its parent's name ("… / JUICES & NECTARS / JUICES & NECTARS").
  Rebuilt only while empty; a populated table raises instead.
- `connection.js` gained `rebuildIncompatibleTables()` + `applyMigrations()`,
  ordered so shape changes precede `applySchema` and additive ALTERs follow it.
- Identity: Internal Reference is stored as `source_odoo_id` and **backfilled**
  on barcode match. It only ever fills a NULL, never overwrites. This activates
  barcode-change detection, which previously could never fire.

### Rule change (approved)
- Categories were documented as "never populated by import". Narrowed: the
  import may now write the Odoo category. **Images remain fully
  application-controlled and are never touched by an import.**

### Real import result (3,883 rows)
- 4 created · 3,879 updated · 0 inactivated · 0 invalid · 54 data-quality warnings
- 3,883 categories assigned · 143 category nodes (4 / 33 / 106)
- FOOD 2,581 · NON-FOOD 701 · DRINKS & BEVERAGES 598 · PETS 3
- 1 UoM change flagged for review (not applied) · 0 barcode changes
- **Photo on 5283013330912 preserved**; re-import is idempotent (3,883 unchanged).

### Tests
- Full suite **139/139 pass**. Five mutants of the new logic all caught.

## [0.2.0] — 2026-10-02 — Stage 2: Customer Digital Product Catalog

Customer-facing catalog at `/catalog`, a read-only customer-safe presentation
layer over the existing Product Master. **Product Master = source of truth.**
Full documentation: `STAGE_2_CATALOG.md`.

### Added
- `src/domain/catalog.js` — customer-safe serializer + catalog queries. Builds
  every payload from an allow-list (`CUSTOMER_SAFE_FIELDS`), so a column added
  to `products` later cannot leak by default.
- `src/server/routes/catalog.js` — read-only `/api/catalog` endpoints.
- `src/public/catalog.html`, `src/public/js/catalog.js`,
  `src/public/css/catalog.css` — mobile-first customer UI, in files of its own
  so the Product Master UI is untouched.
- `test/catalog.test.js` — 30 tests covering all 18 required cases.
- `STAGE_2_CATALOG.md`.

### API
- `GET /api/catalog/products` — search, availability filter, with-image filter,
  name sorting, pagination (24/page, capped at 60).
- `GET /api/catalog/facets`, `GET /api/catalog/products/:id`,
  `GET /api/catalog/products/:id/image`.
- Pages `/catalog` and `/catalog/product/:id`. `:id` is the **barcode**, the
  public identifier — `products.id` never appears in a URL or a payload.

### Security
- Price, cost, margin, all five stock quantities, internal ids, Odoo ids, import
  and change history, review flags and data-quality fields are absent from the
  response bodies — not hidden in the UI.
- `is_active = 1` is the first clause of every catalog query; an inactive
  product returns the same 404 as a non-existent one.
- Whitelisted sort/filter values; parameterised search; no write endpoints.

### Availability
- Reuses `computeStockStatus()` and `config.stock` unchanged. 1:1 mapping to
  In Stock / Limited Stock / Out of Stock. Quantities never leave the server.

### Changed
- `src/server/index.js` — mounts the catalog router and the two page routes.
  This is the only existing file modified; no Product Master route, query,
  template or test was changed.

### Tests
- Full suite **107/107 pass** (77 pre-existing + 30 new). Six mutants of the
  catalog's safety guarantees introduced and all caught.

### Not verified
- Real-iPhone mobile testing is pending.

## [0.1.6] — 2026-10-02 — iPhone capture orientation: device-measured root cause

### Status
**Awaiting on-device verification.** The root cause is now measured rather than
assumed, but no real-device capture has confirmed the correction yet. This entry
is deliberately NOT headed "Fixed".

### Root cause (from a real iPhone diagnostic)
`diag: frame 480x640, screen 0deg, rotation 0deg` on a capture that saved
sideways. iOS Safari reports the rear-camera frame dimensions of the **current UI
orientation**, while `drawImage(video,…)` copies pixels in the **sensor's own
fixed frame**. The reported shape is therefore already corrected and the pixels
are not — so v0.1.5's "frame shape vs device shape mismatch" rule saw no mismatch
and returned 0. The shape comparison is structurally blind to this device.

### Changed
- `src/public/js/orientation.js` — rewritten. The iOS rear-camera correction is
  `(90 - screenAngle) mod 360`, gated by `isIOSDevice(navigator)`. The +90 at
  angle 0 is the device-measured fact; the subtraction follows from the sensor
  being fixed to the phone body. Direction confirmed twice against the bad photo
  (text reads bottom-to-top; the package's sun logo sits at the image bottom
  where the real package has it on the left) — both restored by a 90° CW turn.
- `src/public/js/photo.js` — capture pipeline reads the track's `facingMode` and
  the platform, then rotates raw pixels before resize/compress. Rotation and
  downscale are now small pure canvas helpers.
- New **Rotate ↻** control on the capture preview: re-encodes from the
  pre-compression canvas, so a manual turn costs no image quality and the user is
  never stuck with a wrong automatic guess.
- Richer capture diagnostic (frame, track settings, screen angle, platform,
  facing mode, automatic + manual rotation, saved size).

### Fixed (separate regression found while investigating)
- v0.1.5 rotated **desktop webcam** captures by 90°: a 1280×720 frame at angle 0
  is exactly the "mismatch" the rule fired on, and its test asserted that as
  correct under an iPhone label. Non-iOS now always returns 0.

### Preserved — unchanged
- ≤1280px resize, JPEG compression, server validation, replacement protection,
  save/persistence workflow, product-image association, storage layout, database
  schema, and both barcode decoder paths (native BarcodeDetector + ZXing).
- No reliance on EXIF orientation metadata; the stored JPEG's pixels carry the
  orientation.

### Tests
- `test/orientation.test.js` expanded 10 → 19, including the real device's exact
  numbers as a named regression, a desktop-webcam regression test, the iOS front
  camera exclusion, and the platform gate wired end to end.
- Full suite: **77/77 pass**. Four mutants of the new branch all caught: wrong
  rotation direction (3 failures), platform gate removed (4), front-camera
  exclusion removed (1), iPadOS detection removed (1).

## [0.1.5] — 2026-10-02 — iPhone photo orientation normalization

### Fixed
- Newly captured iPhone photos saved rotated ~90°. The capture pipeline drew the
  raw MediaStream frame to canvas; on iOS Safari the rear-camera frame is the
  sensor's native LANDSCAPE even when the phone is held portrait, so the stored
  JPEG was sideways. Capture now **physically rotates the canvas pixels** to
  upright before resize/compress (no reliance on EXIF).

### Added
- `src/public/js/orientation.js` — pure, tested `computeCaptureRotation()` +
  `rotatedDimensions()`. Rotates ONLY when the frame's shape doesn't match how the
  device is held (so already-correct Android/desktop/iOS frames are untouched);
  direction from `screen.orientation.angle`.
- 10 tests (`test/orientation.test.js`): portrait iPhone, landscape, 0/90/180/270,
  angle normalization, correct-device preservation. Mutation-verified that a
  blanket 90° rotation fails (it would break correct devices).
- Temporary on-screen capture diagnostic (frame dims / screen angle / rotation /
  saved dims) to confirm direction on-device; to be removed after verification.

### Preserved
- ≤1280px resize, JPEG compression, server-side validation, persistence,
  replacement protection. No schema change. Existing stored images untouched.
- Full suite: 68/68 pass.

## [0.1.4] — 2026-10-02 — Fix: detail page shows the actual image

### Fixed
- The Product Master **product-detail page** rendered the primary image's
  *filename as text* instead of the image. It now displays the actual image via
  the existing `GET /api/products/:id/image` endpoint, with:
  a clean "No product image" placeholder when none exists, a graceful
  "Image unavailable" state on load failure (no broken-image icon), an `alt`
  built from the product name, responsive sizing, and the filename kept only as
  small secondary technical text.

### Added
- `src/public/js/product-image.js` — pure `primaryImageSrc(product)` helper
  (shared by the view and tests).
- 4 tests (`test/product-image.test.js`): image URL when `primary_image_id`
  present, null/placeholder when absent, detail-API exposes the data, and the
  image endpoint fails gracefully (404 not 500) when the file is missing.
  Mutation-verified.

### Notes
- No schema change; no new image system; no duplicate files. The product
  **list** has no image/filename column, so it was not affected.
- Full suite: 58/58 pass.

## [0.1.3] — 2026-10-02 — Product photo save (persistent)

### Added
- **Real persistent product-photo workflow** on the scan page, built on the
  EXISTING image architecture (`product_images` + `products.primary_image_id`).
  Dedicated rear camera → capture → Retake/Save; client-side resize (≤1280px)
  + JPEG compression; server-side validation (type + magic bytes + ≤5MB).
  Images stored on disk (`data/product-images/`), DB keeps only the filename.
- Image domain layer `src/domain/images.js` (validate / save / read / primary row).
- API: `POST /api/products/:id/image` (upload; `?replace=true` to confirm overwrite,
  else `409 REPLACE_CONFIRM_REQUIRED`) and `GET /api/products/:id/image` (serve).
- `src/public/js/photo.js` — capture/retake/save/reload UI controller.
- 7 image tests (`test/images.test.js`): validation, association to stable id,
  save success, save failure, replacement protection, survives DB reload.
  Mutation-verified (identity link + replacement guard).

### Changed
- `scan.js`: releases the barcode camera before opening the photo camera (only one
  camera active at a time); removed the "Phase 2" label and the disabled Save.
- Central error handler now returns the error `code` for client handling.

### Identity / safety
- Images are associated with the stable `products.id`, never the barcode.
- Existing photos are preserved unless replacement is explicitly confirmed
  (enforced client AND server side).

### Unchanged
- Product Master import logic untouched. No schema change (existing tables used).
  Full suite: 54/54 pass. No prices; no ordering/quotations.

## [0.1.2] — 2026-10-02 — Barcode decoder fallback (iPhone Safari)

### Added
- **ZXing fallback decoder** for browsers without native `BarcodeDetector`
  (e.g. iPhone Safari). Native path stays preferred; ZXing is selected
  automatically. Both decode the same live camera; EAN-13 + common 1D retail
  formats. Vendored locally (`src/public/vendor/zxing.min.js`) — **no CDN**.
- `src/public/js/scan-core.js` — pure, DOM-free scanner logic (decoder
  selection, barcode normalization, EAN-13 checksum, exact-match lookup,
  duplicate/debounce) shared by the browser and tests.
- `scripts/vendor-zxing.js` (+ `npm`-free `node` script) to refresh the bundle.
- 11 scanner tests (`test/scan-core.test.js`, `test/scan-lookup.test.js`):
  native/fallback selection, EAN-13 handling, normalization, product lookup,
  unknown barcode, debounce. Mutation-verified.

### Changed
- `scan.js` rewritten to use both decoder paths + the shared core; exact-match
  lookup (shows "Barcode not found" when none); camera stays live after a scan;
  rescan resumes without re-acquiring the camera.
- `scan.html` loads the vendored ZXing bundle before the module.

### New dependency
- `@zxing/library@^0.21.3` (vendored to public for the browser; no runtime CDN).

### Unchanged
- Product Master database and import logic untouched. Full suite: 47/47 pass.

## [0.1.1] — 2026-10-01 — Phase 1: Mobile / LAN access

### Added
- Explicit, configurable server bind (`BFL_HOST`, default `0.0.0.0`) so phones on
  the same LAN can reach the app; localhost still works. Startup now prints the
  exact LAN URLs.
- Optional HTTPS server (auto-starts when `certs/` exist) on port 3443 — required
  for the phone camera/barcode scanner (secure-context requirement).
- `npm run gen-cert` — generates a self-signed dev certificate whose SAN includes
  the detected LAN IP(s).
- Responsive layout for phone screens (stacked top bar, horizontally scrollable
  wide tables, larger touch targets).
- `scan.html` + `js/scan.js`: real camera + `BarcodeDetector` barcode workflow
  scaffold (Scan → Find → Show → Photo → Preview). No fake input. Photo **Save**
  is disabled pending Phase 2 (Image Library).
- `MOBILE_ACCESS.md` with diagnosis, firewall command, and phone URLs.

### Unchanged
- Product Master database and import logic untouched (requirement). Tests remain 36/36.

## [0.1.0] — 2026-10-01 — Phase 1: Product Master

### Added
- Project scaffold, isolation rules (`CLAUDE.md`), and documentation set.
- SQLite schema (`node:sqlite`): `products`, `product_images`, `categories`,
  `import_batches`, `import_changes`, plus a forward-compatibility skeleton
  (`customers`, `sales_users`, `requests`, `request_items`, `quotations`).
- Deterministic import engine: reader → header mapping → normalize → validate →
  planner (match + diff, no writes) → transactional commit + audit.
- Two-step import flow: preview (no DB writes) → **Confirm Import** (atomic).
- Repeatable-import rules: create / update / unchanged / inactivate (never
  delete) / reactivate; barcode & UoM changes flagged for review.
- Data validation: required columns/fields, duplicate barcodes & Odoo IDs,
  non-numeric stock (errors); negative stock & unusual barcodes (warnings);
  unexpected columns reported, never fatal.
- Computed stock status (IN / LIMITED / OUT) — not stored.
- Express REST API: `/api/products`, `/api/imports`, `/api/reviews`.
- Admin UI (static HTML/CSS/JS modules): Product Master, Imports, Change Review.
- CLI tools: `import-cli.js`, `data-quality-report.js`, `make-fixtures.js`.
- 36 automated tests covering the 18 required scenarios + edge cases;
  mutation-verified that tests guard the core safety rules.
- Fixture `fixtures/sample-products.xlsx` derived from the real export
  (original source file never modified).

### Verified
- Imported the supplied 3,879-row Odoo export: 3,879 created, 0 errors,
  56 data-quality warnings; re-import fully idempotent.

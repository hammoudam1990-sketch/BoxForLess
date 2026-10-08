# Changelog

All notable changes to this project are documented here.

## [Unreleased] — Front end rewritten in React

The whole front end — customer catalogue, staff screens, staff sign-in and the
barcode scanner — is now React. Behaviour, URLs, API calls and CSS are unchanged.

### Added
- **Staff Product Master improved.** Products now page 50 at a time (it used to stop at 200 with no way to see more). New filters: stock level (in, limited, out) and sorting (name, most or least free stock, barcode). An **Export CSV** button downloads the current filtered list as a spreadsheet, read-only, with the spreadsheet-formula guard and Excel-friendly encoding. Nothing is changed in the database by any of this.

- **A front door at `/`.** One public page (`home.html`) linking to the customer catalogue, the staff app and the scanner. The staff app moved from `/` to `/index.html` (still private); signing in now lands there.

### Added
- **`design-system/box-for-less/MASTER.md`** — the written design system for the customer catalogue (style, tokens with measured contrast, type, layout, components, states, motion, accessibility, anti-patterns), produced with the UI UX Pro Max skill.

### Added
- **Dark mode** (toggle bottom-right on wide screens, in the menu on phones; remembers the choice, follows the device setting at first), a **cookie notice**, **site search** (a header button and the "/" key jump to the product search), a **scroll-to-top button**, a **phone menu** (catalogue header and staff screens), a **loading bar** while anything loads plus a spinner on staff "Loading…", **hover states**, a **scroll-progress bar**, and a **print stylesheet**. Shared code: `js/theme-init.js`, `js/ui-extras.js`, `css/extras.css`, `css/dark.css`, `css/print.css`.

### Changed
- **New background: a doodle wallpaper, and drawings for the products.** The amber photograph is replaced by a black line-art doodle pattern behind every page (veiled in white so text stays readable; mirrored into two halves on wide screens; a very slow drift). The palette goes back to white, near-black ink and burnt orange. Products that have no photograph — nearly all of them — now show a small line drawing of what kind of thing they are (a sack for rice and flour, a bottle for a drink, a jar for spices, a spray bottle for cleaners, and so on), chosen from the product's category; the four category tiles and the product page use them too. No product data is changed.

- **(Earlier today, now replaced above) Whole site redesigned on a "grains and honey" background.** One photograph (oats, seeds and honey on amber) sits behind every page — catalogue, staff screens, sign-in, scanner and front door — with a slow drift animation, veiled so text stays readable and mirrored into two halves on wide screens. Surfaces are cream, ink is deep brown, burnt orange is the single hot colour, and the big words are set in a system serif. Small text never sits on the picture; it goes on cream pills. Cards arrive in a staggered rise and lift on hover. The owner's earlier decisions (orange outline and shadow on product boxes; the Add to request button) are kept.

### Added
- **Experience pass on the customer catalogue.** The carton count is now a number you can tap and type, so a large order is one entry instead of dozens of taps (in the card, the product page and the request drawer). The header slips away while scrolling down and returns when scrolling up. The big product count counts up. Moving between the list and a product fades and rises into place. Adding to the request pops the stepper in and bumps the count badge. Photos fade in as they load, and loading tiles are shaped like real ones. A "Clear filters" link shows whenever anything narrows the list, and the empty state offers it as a button. Motion is off for anyone who asks their device for reduced motion.

### Added
- **Bottom tab bar and a how-it-works banner in the catalogue,** after a set of mobile shopping-app references. The tab bar (Home, Categories, My request with a count badge) replaces the floating cart pill; Home and Categories clear the filters and scroll to the top or to the category tiles. The orange banner under the big number says how a request is made in three steps and goes as soon as a filter, category or search narrows the list.
- **Smooth scrolling and gentle motion across the site.** Pages scroll smoothly (and leave room under the sticky header); product frames fade and rise into place as they scroll into view; category tiles and the front-door tiles rise in one after another; the cart bar and request drawer slide in; chip rows scroll and snap sideways; a staff page settles in once. Everything is opacity/transform only, 150-300ms, and is off for anyone who asks their device for reduced motion. Nothing is hidden unless JavaScript runs.

### Changed
- **Customer catalogue restyled again, after the humbleteam "Content" reference:** a huge light "896 products available now" numeral, big headline tabs, a pill search with a magnifier, orange/black/grey category tiles with a ↗ arrow, black pill chips with an orange count badge, tiles whose name is set large under a pack-size label, a floating black cart pill, and a rounded sheet drawer. The orange product-box outline and the orange/blue "Add to request" button are kept. The staff screens and the front door still use the previous look.
- **The same design across the whole site:** the front door, staff sign-in, staff screens and scanner now use the catalogue's palette and rules (white page, ink text, blue actions, 10px buttons, yellow logo, a thin orange line under the top bar, 12px minimum text, visible focus ring, 44px touch targets on touch screens, reduced motion respected). The front door uses the three coloured tiles. Layouts of the staff screens are unchanged.
- **Accessibility pass against the skill checklist:** muted text and the search placeholder darkened to pass 4.5:1; every control is now at least 44px; nothing readable is under 12px; a visible keyboard focus ring; reduced-motion respected; the request drawer is a proper dialog (focus moves in, Esc closes, focus returns); the whole page is no longer one live region (result and cart counts are); focus moves to the content when you open or leave a product.
- **Ideas borrowed from the Box for Less app on the App Store:** a yellow logo, a "Shop by Category" grid of big coloured tiles (yellow, magenta, orange, green) in place of the top-level category chips, round blue +/− buttons, and blue primary actions. The tiles give way to the usual chips once a category is chosen or a search is typed.
- **Customer catalogue restyled as a wall of framed posters** (after the BALMUDA toaster series): warm off-white background, white frames, a pale canvas with the subject centred and a quiet caption under it, ink instead of blue for actions, and availability as a dot and a word instead of a coloured pill. Because 8,932 of 8,933 products have no photo, a card without one shows its pack size, large and light, as the poster's subject on a shorter canvas rather than an empty box. Layout, behaviour and API calls are unchanged.
- **React 18 with htm tagged templates, no build step.** Pages load `vendor/react.min.js`,
  `react-dom.min.js` and `htm.min.js` with plain script tags, then a module entry point.
  They are vendored (`npm run vendor-react`), not fetched from a CDN, so a phone on an
  unfamiliar network still gets a working app.
- Entry points keep their paths (`js/catalog.js`, `js/app.js`, `js/scan.js`,
  `js/staff-login.js`); the screens now live in `js/catalog/`, `js/staff/`, `js/scan/`,
  with shared helpers in `js/lib/`. The pure modules the tests import (`cart.js`,
  `scan-core.js`, `orientation.js`, `product-image.js`) are untouched.
- `js/api.js` is now the staff client only and gained the request endpoints that
  `requests.js` used to call by hand. The catalogue has its own tiny `catalog/http.js`
  and still imports nothing from `api.js` or `staff/`.
- Removed `request-ui.js`, `products.js`, `imports.js`, `changes.js`, `requests.js`,
  `access.js`, `photo.js` (replaced by components).

### Fixed (as a side effect of not rebuilding the DOM with innerHTML)
- Editing the delivery address or notes in the request drawer, then pressing +/−, no
  longer throws the edit away.
- "Back to camera" on the manual barcode panel now resumes scanning; it used to leave
  the camera on screen with the decoder paused.

### Known, unchanged
- After asking for an access code the drawer says "Thank you. Thank you. …": the
  server's message already begins with "Thank you." (present before this change).

## [0.4.2] — 2026-10-06 — Stage 4 closed: one code per order, and the documentation to match

Everything here came out of real customer sessions on a phone, or from reading the
documentation back and finding it no longer true.

### Added
- **The session ends at submission.** A salesman carries one phone between several
  customers in a day; a session that outlived the order would file the next
  customer's request under the previous one. Enforced server-side by a
  `session_epoch` on the customer — clearing the cookie alone would only have been
  a request to the browser. "Not you?" bumps it too, so that genuinely revokes.
- **`BFL_PUBLIC_URL`.** The catalogue link staff send over WhatsApp was built from
  the machine's own network address. Correct on the LAN; on a hosted server it
  would have been an internal address no customer could open. **Required once
  deployed.**
- **`scripts/import-customers-cli.js`** and **`scripts/daily-update.js`** — the
  daily routine in one command. It names the files it chose and how old they are,
  previews both, and writes nothing without `--confirm`.
- **`STAGE_4_ACCESS.md`** — Stage 4 documented to the standard of Stages 2 and 3.

### Fixed
- **Clearing a request left every product still marked in the catalogue.** Clear,
  the per-line ×, and the +/− steppers all changed the cart from inside the drawer
  without telling the grid behind it; only submitting refreshed it. Closing the
  drawer now re-renders the catalogue, but only when the cart actually changed, so
  closing it to carry on browsing does not lose your place.
- **The customer name was shown but not seen** — 14px body text in a small bar. It
  is the only confirmation that the right code was used, and with the session now
  ending each order a salesman reads it before every submission. It is now the
  largest element in the drawer.

### Documentation
- `STAGE_3_REQUESTS.md` stated four things Stage 4 had made false — an empty
  customer master, a refused import, a customer-search endpoint, a read-only staff
  router. Each is marked `SUPERSEDED IN STAGE 4` in place, with the original kept
  beneath: the reasoning still explains why things are as they are.
- `PHASE_STATUS.md` gains a Stage 4 section and the D1–D5 table. The old "Future
  phases" table is removed — it used a second numbering in which "Phase 4" was what
  shipped as Stage 3.
- `IMPORT_RULES.md` records that Odoo data is never edited, merged or
  de-duplicated here, and corrects an earlier claim that two TATA records were a
  renamed-company pair. They are three different accounts; the duplicate the import
  reported was two identical rows inside the file.

### Verified on a real phone (2026-10-06)
Delivery address required · session ending per order · the customer name ·
withdraw and restore · access code entry and Submit turning blue.

### Tests
280/280 (279 → 280; 269 at v0.4.0).


## [0.4.1] — 2026-10-06 — Access-code polish, delivery addresses, and the open decisions closed

Everything reported from real customer sessions on a phone, plus the four
decisions Stage 4 had left open.

### Added
- **Delivery address is required to ask for access.** A company that cannot be
  delivered to cannot be supplied, so it is collected before access is granted
  rather than chased later. Approving writes it onto the customer record
  (`customers.delivery_address`), filling a missing address and never overwriting
  one already held.
- **The address follows the customer.** Pre-filled on their request and editable
  for a one-off delivery, which is stored on THAT request and does not rewrite
  their record. The 504 imported customers have no address and are deliberately
  **not blocked** — they are asked, not stopped.
- **Access codes are issued automatically on a customer import** (D1), reported as
  `codesIssued`. A code already held is never regenerated, so re-importing cannot
  invalidate a code already sent.
- **Withdrawn requests** (D4). Deleting marks a request `DELETED` with a
  `deleted_at` stamp instead of destroying it; reference, customer, lines,
  quantities and snapshots are kept. A Withdrawn tab lists them with the customer
  and full order, and `POST /api/requests/:id/restore` brings one back.
- The access code now **checks itself on the eighth character** — typing it is
  entering it. Continue remains for pasting and retrying.

### Fixed
- **Cart lines jumped to the bottom on every +/−.** `setQuantity()` filtered the
  line out and pushed it back on, so the row moved out from under the customer's
  finger and the next press hit whatever had shifted up. Lines now update in
  place. `test/cart.test.js` covers it.
- **Searching the access-code list destroyed the search box mid-typing.** Its
  debounce rebuilt the whole view, including the input. "ali" survived; everything
  after the pause was lost. Only the table body is replaced now.
- **A disabled button was faded blue, not grey**, so Submit never visibly turned
  blue when a code was accepted — reported twice as a broken button when the logic
  was correct all along.
- `requests.delivery_address` had become dead: it only filled on the "unlisted"
  path the access codes replaced, so every request since had stored NULL.
- `customerSummary()` returned a null address for existing customers, hiding the
  destination from the staff packing the order.
- `resolveAccessCode()` did not select the address, so a sign-in reply came back
  without one even when stored.
- The access-code field survives a drawer re-render, keeping its value, caret and
  focus.

### Decisions closed
- **D1** — Odoo has no customer identity, so the code is the identity; new
  customers are coded automatically on import.
- **D2** — `pricelist` stores a price-TIER NAME, never an amount, and no price is
  displayed pending CEO approval. Amendment recorded in `CLAUDE.md`.
- **D3** — absence on a customer import still does **not** deactivate; a contact
  export is often a filtered view. Documented in `IMPORT_RULES.md`.
- **D4** — the hard delete is gone; see Withdrawn requests above.

### Verified on a real phone (2026-10-06)
Code entry, auto-validation on the eighth character, and Submit turning grey → blue.

### Tests
279/279 (277 → 279 this release; 269 at v0.4.0).


## [0.4.0] — 2026-10-05 — Stage 4: customer access codes

**Closes the customer-master exposure.** Before this change the catalog was public
AND carried a customer-search endpoint, so anyone holding the link could type
letters and read back real company names — all 355 of them. The search endpoint is
**gone**. A customer now proves who they are with a code instead of finding
themselves in a list, so there is nothing left to enumerate.

### Added
- **Access codes.** 8 characters from a 31-symbol alphabet with `0/O/1/I/L`
  removed, shown as `7K2M-9XQR`. Generated with rejection sampling so no symbol is
  favoured. Stored in plain text **on purpose** — staff must read a code back to
  send it, which a one-way hash would prevent.
- **Customer sessions.** Entering a code sets a signed, HttpOnly cookie
  (`BFL_CUSTOMER_SESSION_DAYS`, default 30). Separate cookie and secret from the
  staff session, so neither can forge the other. The customer is re-read from the
  database on every request, so deactivating one revokes access at once.
- **Rate limiting** — 10 attempts per IP per 15 minutes on code entry.
- **"I don't have a code"** — a company submits its details, which land in a new
  `access_requests` table as PENDING. It creates no customer and places no request.
- **Staff screens** — *Access Codes* (search, copy, issue/reissue) and
  *Access Requests* (approve, which creates the customer and issues the code, or
  reject). A nav badge counts anyone waiting.
- `scripts/issue-access-codes.js` — previews by default, `--confirm` to issue.

### Changed
- **`GET /api/catalog/customers` REMOVED.** This was the enumeration hole.
- **Request identity now comes from the session, never the request body.** A
  customer cannot submit in another company's name even by crafting the payload;
  `customerId`, `customerHandle`, `customerRef` and `unlisted` in the body are all
  ignored.
- The cart's company-search box is replaced by code entry; Submit stays disabled
  until the customer is identified.
- The old self-serve "unlisted customer" submission is replaced by the
  staff-approved access-request path.

### Data
- `customers` += `access_code`, `access_code_issued_at` (unique index on the code).
- New table `access_requests`.
- `requests.delivery_address` is unchanged but no longer written by the customer
  path; an address is captured when asking for access.
- **355 codes issued** to the imported customers. Checkpoint
  `v0.4.0-pre-access-codes` taken first.

### Tests
- `test/access-codes.test.js` — 24 tests covering alphabet safety, modulo-bias
  coverage, forgiving input without substitution, revocation on reissue and on
  deactivation, submitting without a code, **submitting in another customer's
  name**, four kinds of forged cookie, rate limiting, code non-disclosure on every
  customer endpoint, and the approve/reject flow.
- `DA4b` asserts the removed search endpoint stays removed and leaks no name.
- Four Stage 3/4 tests updated to the new contract — none weakened or skipped.
- **269/269 pass** (245 → 269).

### Not done yet
- Not verified on a real iPhone.
- `/catalog` browsing remains public by design; the code gates requesting only.


## [0.3.1] — 2026-10-03 — Scanner: higher capture resolution + manual barcode fallback

**✅ Verified on a real iPhone (2026-10-03).** Camera scan of the previously
unreadable barcode, manual entry of the same barcode, unknown-barcode handling,
Enter-key submission, and the onward product/photo workflow all pass.

Internal Product Master scan page only. The customer catalog, cart, requests,
customer architecture, stock logic, schema and product data are untouched.

### Fixed
- **Small EAN-13 barcodes could not be scanned.** The scanner requested no camera
  resolution, so iOS Safari supplied its default 640×480. An EAN-13 symbol is 95
  modules wide and needs roughly 2px per module to decode; a barcode filling a
  fifth of the view yielded about 1.3px per module and was unreadable however
  clear the print. Measured against the project's own ZXing decoder:
  2.02px/module decoded, 1.35px/module failed. The scanner now asks for
  `width/height: { ideal: 1920 × 1080 }` — about 3× the pixels for the same
  physical barcode. `ideal` is a hint, so a device that cannot supply it falls
  back to its own default rather than failing.
  Real-device result: barcode `6281003101428`, previously unreadable at any
  distance, now scans.

### Added
- **Manual barcode entry** on the scan page, for a label the camera cannot read
  (damaged, tiny, awkwardly placed). Hidden behind "Can't scan the barcode?" so
  camera scanning remains the primary method.
  - Performs **no lookup of its own**: it calls `onDetected()`, the same function
    a camera detection calls, so the server lookup, exact-match rule, product card
    and photo workflow are one code path that cannot drift.
  - Exact matching only — no fuzzy or partial match resolves a product.
  - Never creates a product, never alters a barcode, never mutates anything.
  - Enter/Return submits; 16px input and 44px targets for iPhone.
- `prepareManualBarcode()` in `scan-core.js` — pure and unit-tested. Deliberately
  gentler than `normalizeBarcode()`, which strips ALL whitespace: that is right
  for a scanned 1D code but would make four real products untypeable, since their
  barcodes contain spaces (e.g. `SIP CAKE 47*60*11`). Manual entry drops control
  characters and trims the ends only, preserving internal characters and leading
  zeros.

### Tests
- `test/manual-entry.test.js` — 16 tests: leading zeros preserved, whitespace
  trimmed, internal characters kept, empty input rejected, unknown barcode
  controlled, fuzzy/partial refused, no database mutation, no mutation via other
  HTTP verbs, no customer/pricing exposure, and the manual path returning a record
  identical to the scanned path.
- **204/204 pass** (188 → 204). Four mutants of the new logic all caught. No
  existing test weakened, skipped or removed.

## [0.3.0] — 2026-10-03 — Stage 3: customer request cart & submission (CTN only)

**✅ STAGE 3 COMPLETE — verified on a real iPhone (2026-10-03).** All ten device
checks passed: Available Now and Full Catalogue tabs, add-to-request, CTN
increment/decrement, cart bar counts, cart drawer, customer search, the
"not listed" path, submission with a returned reference, and no exposure of stock
figures, Odoo ids, pricing or internal data. Full detail: `STAGE_3_REQUESTS.md`.

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

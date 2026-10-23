# Warehouse: Expiry — build notes

Source: the technical specification's *Warehouse: Expiry* document (W1 warehouse bands and
clearance, W2 customer-shelf alerts and shop visits, W3 customer minimum shelf life, W4
returns) and the *Front-end plan* (screens S03, S04, R01, R02, C03/C04).

**Status:** built **ahead of Phase 0**, with the Operations & Development lead's approval
(stated by the owner, 2026-10-21), **against sample data only**. Nothing here connects to
Odoo, writes to Odoo, or is visible to customers yet. Go-live still follows the phase gates
(Phase 7) and the acceptance checklist in the specification.

## Build order (one slice at a time)

| # | Slice | Status |
|---|---|---|
| 1 | **Expiry rules** — pure, tested logic: `src/domain/expiry.js`, `test/expiry.test.js` | **Done** |
| 2 | **Staff expiry list (S03)**, on sample data: `src/domain/expiry-list.js`, `expiry-actions.js`, `expiry-sample.js`, `src/server/routes/expiry.js`, `js/expiry.js`, `test/expiry-list.test.js` | **Done** |
| 3 | **Rep screens R01 My visits, R02 Visit form, and the Sales Manager Approvals screen**, on sample data: `src/domain/shelf.js`, `src/server/routes/shelf.js`, `src/public/rep.html`, `js/rep.js`, `js/approvals.js`, `test/shelf.test.js` | **Done** |
| 5 | **Returns to classify (S04, W4)** and returned cartons off the shelf records: see `SALES_MANAGEMENT.md` slice 12 | **Done** |
| 4 | **Customer shelf-life warning (C04 / request cart)**, on sample data: `src/domain/shelf-life.js`, the request drawer (`js/catalog/request.js`), a staff panel on the Expiry screen to set each customer's minimum, `test/shelf-life.test.js` | **Done** |

## Slice 1 — what the rules do

All pure functions: no database, no Odoo, no clock. "Today" is always an argument.

| Rule | Spec | Where |
|---|---|---|
| Days left, in whole calendar days (Odoo datetimes read as their date) | W1 | `daysLeft`, `toDay` |
| Bands per category: long 90/60/30 days, short 60/30/14, then expired | W1 | `classifyLot`, `categoryRules` |
| Settings Operations can change; validated (`early > warning > critical > 0`) | W1 | `withSettings` |
| Categories matched by Odoo path, whole segments, most specific wins per field | W1 | `categoryRules` |
| Expired lots are never sellable | W1 | `isSellable` |
| "Check these entries": past on receipt, over 5 years ahead, far from the category's usual shelf life | W1 | `checkEntry` |
| One list row, sorting (expired first), counts per band | W1 | `buildExpiryRow`, `sortExpiryRows`, `countByBand` |
| Clearance discount is a percentage above 0 and below 100 | W1 | `validateDiscountPercent` |
| Shelf alerts: long 60 and 30 days before; short one alert at 30 | W2 | `shelfAlertDates`, `shelfAlertStatus` |
| A shop not checked is due again in 7 days | W2 | `nextCheckDate` |
| Minimum shelf life: enough qualifying stock, otherwise warn with the date of the best shorter-dated lot; must be accepted | W3 | `checkMinimumShelfLife` |
| Daily exceptions: a lot delivered below the customer's minimum with no recorded acceptance | W3 | `deliveryBelowMinimum`, `findShelfLifeExceptions` |

38 tests cover every boundary (30, 31, 60, 61, 90, 91 days; the expiry day; exactly 5 years;
exactly the minimum). They were mutation-checked: seven deliberate bugs, each caught.

## Choices I had to make where the specification is silent

Each is a one-line change in `expiry.js`; please confirm or correct.

1. **The expiry date itself is the last day a lot may be sold.** 0 days left is still sellable and
   in the Critical band; -1 is Expired. The specification says "past expiry". **Confirmed by the owner, 2026-10-21.**
2. **Which categories are "short shelf life" is not decided** (open decision W-1). Everything defaults
   to long until `categories` in the settings says otherwise.
3. **"Expiry far from the product's usual shelf life"** needs a usual shelf life per category. None
   is configured, so that check stays silent until one is. When set, a lot is flagged if it has more
   than **2x** or less than **0.2x** the usual life left at receipt. The 2x and 0.2x are my proposal.
4. **"More than 5 years ahead"** is measured in whole calendar years from the receipt date.
5. **The shortfall date in the warning** ("Available stock expires on …") is the best (latest) of the
   shorter-dated lots, because that is what the warehouse would load.
6. **A lot with no expiry date** is treated as not perishable: not expired, not warned, meets any
   minimum. A date that is present but unreadable is *not* sold until fixed.

## Decided: value at risk is measured at the selling price (W-5)

The specification asked for "value at risk in GHS at cost"; the project rule is that cost data is
never read. **Decision (owner, 2026-10-21): value at risk uses the selling price, not cost.**
So `valueAtRisk` is cartons x selling price per carton, summed per band by `valueByBand`.

- The price is an *input* (`pricePerCarton` on the lot); the rules only multiply. Where it comes
  from (the product's price in Odoo) is decided when the Odoo sync exists.
- It is a **staff-only** figure. It must never appear on a customer-facing page, and the leak tests
  must keep covering that when it is wired up.
- A lot with no price is shown as "no price", never as 0, and the total says how many lots were not
  valued (`unpriced`).
- `expiry.js` still reads no cost, valuation or purchase figure; a test enforces it.

## Still open (from the specification)

W-1 warning bands and short-shelf-life categories · W-3 clearance pricing as a quotation line
discount or separate "short-dated" products · W-4 a return-reason field in Odoo · W-6 how long
visit photos are kept. (W-2, W-5 and W-7 are decided.)

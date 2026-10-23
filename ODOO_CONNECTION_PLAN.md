# Odoo connection plan

Written 2026-10-21 against the technical specification (the main tab, sections 3–7 and 12, and the Readiness Checklist) and against what is built in this repository. When this file and the specification disagree, the specification wins.

**The short version.** Everything in BFL already works against a *stand-in* for Odoo. Connecting Odoo means replacing the stand-in with real reads and one outbox worker, without touching the screens. The stand-in is marked `SAMPLE` on every screen and is switched off by `BFL_ODOO_CONNECTED=1`.

You can make this plan, and start the Odoo administrator's one-off jobs, **before** testing the sample screens. Neither depends on the other. Testing first would only change a few field requests (below); the people-and-access work has the longest lead time, so it should start now.

---

## 1. What the real Odoo replaces

| BFL today (stand-in) | Where | Becomes, from Odoo |
|---|---|---|
| Customer list import from an Excel export | `src/domain/customers.js` | `res.partner`: `id` (the **Odoo ID** customers sign in with), `ref`, `name`, `phone`, `email`, `property_product_pricelist`, `user_id` (salesperson), `credit_limit`, `credit`, `active` |
| Product import from an Excel export | `src/import/*` | `product.product` (`id`, `default_code`, `barcode`, `name`, `categ_id`, `uom_id`, `active`), `product.category`, brand field |
| Stock from the same export | `products.on_hand`, `free_to_use` | `product.product` with the warehouse context: `qty_available`, `free_qty`, `incoming_qty`, `outgoing_qty` |
| Made-up carton prices per price class | `src/domain/prices.js`, `fixtures/price-classes-sample.json` | `product.pricelist` + `product.pricelist.item` (method below) |
| Sample reps | `fixtures/shelf-sample.json` | `res.users` (salespeople) |
| Sample lots and deliveries | `fixtures/expiry-sample.json`, `fixtures/shelf-sample.json` | `stock.lot` + `stock.quant` (lots, expiry dates, location); done deliveries `stock.picking` / `stock.move.line` (customer, lot, cartons) |
| **Sample Odoo screen** (confirm, deliver, invoice, pay, return, credit note) | `src/domain/sample-odoo.js`, `sample-history.js` | Real reads of `sale.order`, `account.move` (posted `out_invoice` / `out_refund`), `account.payment`, return deliveries; **the screen is deleted** |
| Outbox rows that stay `PENDING` | `src/domain/outbox.js` | The outbox **worker** sends them (below) |

The tables BFL fills (`odoo_orders`, `odoo_invoices`, `odoo_invoice_lines`, `odoo_payments`, `odoo_credit_notes`, `odoo_returns`, `odoo_customer_finance`) were designed as the read copy, so the screens and reports do not change.

## 2. The things that block the start (the Odoo administrator and the lead)

These are the Readiness Checklist's group A and the specification's section 14, items 1–3. Nothing below needs code.

**Ask the Odoo administrator, in writing:**
1. Odoo **version and edition**, and **hosting** (Odoo Online, Odoo.sh or self-hosted). *Some Odoo Online plans do not allow external API access — check this first.*
2. Which **API** the version offers: the JSON API with bearer API keys (newer) or XML-RPC/JSON-RPC `execute_kw` (older). All calls go through one module, so a later change is one file.
3. Which **company** is Box for Less (Double A is separate and must stay so) and whether everything is in **GHS**.
4. Which **warehouse / stock location** the customer-facing stock comes from, and the names of the **clearance** and **quarantine** locations.
5. A **staging copy** of Odoo, who maintains it, and what it costs (A2), and a paid **user seat** for the integration user (A3).
6. The integration user **`bfl-integration`**: an internal user, no Settings or Technical menus, a dedicated security group with **exactly** these rights — and no delete rights anywhere:

| Model | Access |
|---|---|
| `product.product`, `product.template`, `product.category` | Read |
| `stock.quant` (or the product quantity fields), `stock.lot`, `stock.picking`, `stock.move.line` | Read |
| `res.partner` | Read, **Create** (only after approval) |
| `product.pricelist`, `product.pricelist.item` | Read |
| `sale.order`, `sale.order.line` | Read, **Create (draft only)** |
| `account.move` (customer invoices and credit notes) and lines, `account.payment` | Read |
| `res.users` | Read |

   Confirm it **cannot** delete, confirm or cancel anything, nor write accounting, stock, pricelists or products. The rights must make that impossible, not just the code. One integration user and API key per environment; a key from one never works in another.
7. **One-off fields** in Odoo (A4): a **Brand** field on products (e.g. `x_brand`), and a **minimum shelf life** field on customers (e.g. `x_min_shelf_life_days`). Lots need **expiry tracking** switched on (`stock.lot` expiration date).

**Decide (lead + Odoo administrator), blocking Phase 1:** *how BFL gets each customer's price* (decision 3). My recommendation, to be settled by a test on staging in week 1:
- First try asking Odoo for the price (the public pricelist price method through the API, per price class and product, cached hourly). It reuses Odoo's own rules, so BFL can never disagree with a quotation.
- If that method is not callable on our version, **read the pricelist items** and calculate fixed prices, percentage discounts and formulas ourselves.
- An Odoo **add-on** only if neither is acceptable (it needs Odoo.sh or self-hosting).
- The test is the specification's own: **50 sampled products across all price classes; the BFL price must equal the price Odoo puts on a quotation.** Whatever BFL shows, the quotation price is always set by Odoo.

**Also before Phase 0 can start:** A5 (lift the "do not deploy" hold; choose host and domain; HTTPS), A6 (`CLAUDE.md` already matches the plan), A8 (developers), A9 (company GitHub organisation), A10–A11 (budget and sign-off).

## 3. The data clean-up (group B) — BFL can measure it now

The API copies whatever is in Odoo, mistakes included. These can be checked against the data BFL already holds, so the Sales Manager has a list to fix **in Odoo** before Phase 1 goes live: duplicate customers (B1), customers without a **salesperson** (B2), **price class** (B3), **credit limit** (B4), **phone or email** (B5), products without a **barcode or category** (B6), without a **brand** (B7), and perishable lots without an **expiry date** (B8). *I can build this as a staff "data quality" screen from the current import (it needs no Odoo).*

## 4. How it is built (back end)

Follows section 7 of the specification. All Odoo calls go through **one module**, `src/odoo/client.js`.

1. **Client** — protocol-agnostic `search_read`, `create`, `call`; at most 4 calls per second, batches of 200, timeouts; logs every call (time, model, operation, record ids, duration, result) and **never the API key**. The key lives only in the server's secret configuration (`.env.local` locally; never read, printed or committed).
2. **Fake Odoo** for automated tests: a small server that answers like Odoo, can time out, fail and return duplicates. The outbox, retries and duplicate checks are tested against it.
3. **Sync framework** — a job per data type with its interval (products every 15 min, stock and customers every 5 min, categories and pricelists hourly, invoices/payments 15 min, orders 5 min, salespeople daily). Each job asks for records with `write_date` later than the last good run minus 2 minutes, applies them **in one transaction** (all or nothing), and records the run in `sync_state`. A nightly **full read** compares everything and logs differences to `sync_changes` (the same idea as `import_changes`).
4. **Per-type loaders** into the existing tables; every record keeps its Odoo ID and `write_date`. Archived or vanished in Odoo → **inactive in BFL, never deleted**. Customers are matched by **Odoo ID only** (name matching is removed). Prices are never stored in a BFL price table.
5. **The outbox worker** (the only write path, two kinds only):
   - *Draft quotation* — build `sale.order` with `partner_id` from the session's customer (cash buyers: the shared cash account, buyer details in the note), `client_order_ref` = the BFL reference, `user_id`, `origin` = "BFL Platform", lines with product and cartons and **no price**. Before creating, **search for a quotation with that `client_order_ref`**; found → link it, not found → create, read back the Odoo number (S00456) and total. Retries after 1, 5, 15, 60 minutes, then hourly; failed after 24 hours or any rejection (e.g. an archived product), with a dashboard and email alert.
   - *New customer* — `res.partner` with `ref` = the registration reference (duplicate check), the price class and salesperson chosen at approval, **no credit limit** (the Sales Manager sets it in Odoo). Company + child contact.
   - Never: confirm, send or cancel orders; edit an existing customer; touch prices, credit limits, products, stock, invoices or payments.
6. **Status read-back** — map `sale.order` state, delivery and invoice status onto the six steps customers already see: draft → *Waiting for approval*; confirmed (`sale`) → *Approved*; delivery done → *Dispatched*; invoice posted → *Invoiced*; payment state paid → *Paid*; cancelled → *Cancelled*. Odoo wins: a quotation changed in Odoo after sending shows the Odoo version and keeps the customer's original submission.
7. **Live checks at checkout** — re-read the customer's `credit_limit` and `credit` and the stock of the products ordered, rather than trusting the copy. **To confirm with the Odoo administrator:** does Odoo's own figure already include open sales orders? (If it does, BFL must not subtract them twice.)
8. **Sync health screen (S05)** — last good sync per data type, outbox pending / sent / failed with **Retry**, time since Odoo last answered, and the kill-switch note. **Alerts**: Odoo silent 10 min; stock or customer sync failing 20 min; an outbox entry failed (at once) or pending 2 hours; reconciliation not empty; backup missed.
9. **Daily reconciliation** (each morning, to Sales and Operations): quotations missing on either side, pending/failed outbox entries, customers whose balance or limit differs, products whose stock differs, last good sync per type. It should be empty on a normal day.
10. **Kill switch** — disable the `bfl-integration` user in Odoo; orders queue and send themselves when it returns. A suspected leaked key: revoke it, issue a new one, update the server secret. The key rotates every 6 months and on any staff change.

## 5. Order of work and what each step proves

| Step | Needs Odoo? | Done when |
|---|---|---|
| **0. Foundations** | Yes (Odoo administrator) | Version/API confirmed in writing; staging copy; integration user with exactly the rights above, confirmed unable to delete or confirm; host, domain, HTTPS, daily backup and monthly restore test; price method decided |
| **0b. Offline groundwork** | **No** | Client module and **fake Odoo**; `sync_state` / `sync_changes`; the sync framework and outbox worker passing the required tests (a retry after a timeout creates no second quotation; a failed sync leaves the database unchanged); the data-quality screen; the S05 health screen; the reconciliation report. All against the fake |
| **1. Read from Odoo** | Staging | Products, categories, stock, customers sync on schedule (changes in BFL within 5 min); invoices, credit notes, payments and sales orders sync read-only (unlocks most of the monthly reports); every customer carries their Odoo ID; archived → inactive; a sync failure changes nothing and alerts; the nightly full read and reconciliation run empty; **the Excel import is switched off** |
| **2. Accounts and visibility** | Staging | Existing customers invited and signed in; reps see only their own customers (from Odoo's salesperson); visibility rules match the preview; leak tests pass *(the BFL side is built)* |
| **3. Prices** | Staging | Each approved customer sees their own price class per carton in GHS (tax display decided, decision 2); 50-product price match; visitors see none *(BFL side built)* |
| **4. Orders to Odoo** | Staging | A submitted order is a correct draft quotation with Odoo-calculated prices; the customer sees the Odoo number, which stays the same on confirmation; Odoo switched off → orders queue and send without duplicates; history shows platform and Odoo-entered orders *(BFL side built)* |
| **5. Credit and balance** | Staging | Credit check uses live Odoo figures and open quotations; balance matches Odoo's customer statement to the cedi for 20 sampled customers *(BFL side built)* |
| **6. Notifications** | Staging | Emails and payment reminders go out from a real email service (D1); reminders stop when Odoo shows paid *(BFL side built; delivery missing)* |
| **7. Warehouse expiry and monthly reports** | Staging | Lots, deliveries and returns read from Odoo; the acceptance checklists on the Warehouse and Monthly Reports tabs pass *(BFL side built)* |

Each phase goes live only when its acceptance checklist is **signed off on staging by the Sales Manager and the Operations & Development lead**. Production Odoo is connected only after that. Do not deploy to a public host until A5 is Done.

## 6. When we flip from stand-in to real

1. Build and test against the **fake Odoo** (step 0b).
2. Point at **staging Odoo** (a staging environment file with its own key). Run the loaders; compare with the Excel exports the team already has.
3. **Shadow period**: sync and compare for a week with the stand-in still the screens' source of truth; the reconciliation report must be empty.
4. Switch the screens to the synced tables: set `BFL_ODOO_CONNECTED=1` (turns the **Sample Odoo** routes off, so the stand-in can never act beside the real thing), drop the sample fixtures from the screens, delete `sample-odoo.js`, `sample-history.js` and the Sample Odoo screen, retire the Excel import and `BFL_ALLOW_CODE_SIGNIN` (set to `0` at go-live).
5. Production Odoo only after the phase checklist is signed off.

## 7. Things that will change in BFL, so nobody is surprised

- **Customer sign-in** uses the Odoo ID, which the sync fills in; the "phone number instead" fallback goes.
- **Reps** come from `res.users` and "their customers" from the customer's `user_id`.
- **Imported customers** are credit accounts today (`customer_type` CREDIT); the real flag should come from Odoo (cash buyers use the shared cash account).
- **Prices** shown to customers lose the "sample" label; the carton price comes from Odoo's price class.
- **Reports**: *Orders through BFL* becomes available once every Odoo sales order is read; brand reports use the Brand field instead of the first word of the name; fill rate is read from the real delivered quantities.
- **Credit limit** is never set by BFL; new customers are created without one.
- **The return reason stays in BFL** (no Odoo change needed).

## 8. What I need from you

1. **Who is the Odoo administrator**, and has anyone confirmed the version, edition, hosting and whether our plan allows API access (decision 1)? Everything else waits on this.
2. **Who owns the staging copy and its cost** (A2/A3)?
3. **Should I start step 0b now** (client, fake Odoo, sync framework, outbox worker, S05, data-quality screen, reconciliation)? None of it needs Odoo, all of it is tested against the fake, and it is the biggest piece of the back end. Building it ahead of Phase 0 is covered by the approval already given for building on sample data, but say so if you want it held.
4. Decisions with a recommendation above: the **price method** (test on staging), **VAT display** (decision 2), the **default price class for new customers** (decision 8).

---

## 9. Status (2026-10-21)

**Step 0b, offline groundwork: built and tested against a fake Odoo (554 tests passing).** Client, fake Odoo, sync framework (customers, stock), outbox worker, jobs, and the Sync health screen (S05) are in `src/odoo/`, `src/server/routes/odoo.js` and `src/public/js/health.js`. Checked end to end on a scratch copy against the demo fake Odoo: customers and stock synced, a quotation went out as a draft with no price, a rejected quotation showed Odoo's reason and Retry put it back in the queue. No real Odoo has been contacted.

**Still to build (needs the staging copy to confirm field names):** loaders for products, categories, price classes, invoices and their lines, credit notes, payments, sales orders, lots, deliveries and returns; the data-quality screen (B1–B8); the daily reconciliation report; the live credit and stock check at checkout; status read-back from the real `sale.order`; email alerts; the price method (decision 3).

**Blocked on you:** the answers in section 8.

# Sales management — build notes

Built ahead of Phase 0, on sample data, with the Operations & Development lead's approval. No Odoo connection exists yet: every
Odoo-side fact (price classes, prices, reps) is a clearly labelled **SAMPLE**, and every write to Odoo waits in the outbox.

Source: `BFL-Frontend-Plan.pdf` (screens C01–C09, S01, S02, S07; journeys 1 and 2).

## Build order

| # | Slice | Status |
|---|---|---|
| 5 | **Registration (C02), the Sales Manager's decision (S01), prices from the customer's price class (C03/C04/C05)** | **Done** |
| 6 | **Orders to Odoo as draft quotations, status and history (C05/C06), and the balance (C07)** — on a stand-in for Odoo | **Done** |
| 7 | **Credit check before an order is sent (C05)** (see slice 8 below) | **Done** |
| 8 | **Visibility rules (S02)** (see slice 10 below) | **Done** |
| 10 | **Monthly reports (S06)** (see slice 11 below) | **Done** (email delivery not built) |
| 11 | **Returns to classify (S04, W4)** (see slice 12 below) | **Done** |
| 8a | **Sign-in, per-person staff accounts and roles** (see slice 7 below) | **Done** |
| 9 | **Payments due and reminders (S07)** (see slice 9 below) | **Done** |

## Slice 5 — what it does

**Registration.** `/signup` (and "I don't have a code" in the request drawer) collects company (optional), name, phone, email
(optional) and delivery address. The customer gets a reference (`REG-2026-0004`) and "waiting for approval". Nothing else
happens: no customer, no code, no prices. The acknowledgement has the same shape whether or not the company is already a customer.

**The decision (S01), staff screen "Registrations".** *Review* opens a panel:

1. **Do we already have them?** Matches on name, phone (any format, last nine digits; junk such as `0` or `Office` never matches)
   and email, plus other registrations that look alike. If anything matches the Sales Manager must say *"this is customer X"*
   (their Odoo details are kept; only blanks are filled) or *"none of these — new customer"*. The server enforces this; the
   client cannot switch it off.
2. **Credit or cash.** Credit = a company with its own Odoo account. Cash = the shared cash account; always priced from the
   cash-account class; **nothing is created in Odoo**.
3. **Price class and sales rep.** A rep is required for a credit customer; the class defaults to `CLASS A (GHS)`.

Approving issues the access code in one transaction with the customer. A **new credit** customer is also queued in the outbox
(`odoo_outbox`, `CREATE_PARTNER`, the registration reference in `ref`, deduplicated by `partner:<reference>`); it stays PENDING
until the Odoo connection exists. An existing customer is never edited in Odoo. The panel shows what is waiting to go to Odoo.

**Prices.** The only route that returns a price is `GET /api/catalog/prices?barcodes=…`. It needs a customer session (401
otherwise), answers for the session's customer only (nothing in the query can name a customer), and returns numbers for the
barcodes asked about — not the price class name. Product lists, product pages and facets carry no price for anyone; this is tested.
The catalogue shows a strip under the header: visitors get "Prices are shown to approved customers" and a sign-in field with their
access code; a signed-in customer sees "Prices for X, per carton in GHS — sample prices, not real", a price on each card and
product page, a price and total in the request drawer, and Sign out. A customer whose account has no known price class sees no prices
(never a guess).

## Where the sample ends and Odoo begins

| Sample now | Real later |
|---|---|
| `fixtures/price-classes-sample.json`: class names (real, from the customer list) with made-up multipliers | Odoo pricelists |
| `cartonPriceFor()` in `src/domain/prices.js`: a made-up base price per barcode × the class multiplier | Pricelist items read by the sync |
| Reps from `fixtures/shelf-sample.json` | Odoo salespeople (and "reps see only their own customers") |
| Outbox rows wait as PENDING | The outbox worker sends them (retry-safe, duplicate-checked) |

Only `prices.js` knows prices are made up; replacing `cartonPriceFor` changes nothing else.

## Not done yet / choices to confirm

- **Sign-in** is still the access code (C01 in the plan is phone/email + password with a one-time code on a new phone). Not changed.
- **Status check for a registrant.** A customer cannot look up their registration status; they are told "waiting for approval" and
  given the reference. A lookup needs a safe design (reference + phone) — not built.
- **The Sales Manager role.** Staff sign-in is one shared login today, so "Sales Manager only" cannot yet be enforced per person.
- **Existing real customers** carry the price class from the customer list; with sample prices they now see made-up prices when
  signed in. The strip says so. Do not read these as real.

## Slice 6 — an order from submit to paid, and the balance

**The journey** (owner's description, 2026-10-21): the customer's order becomes a **quotation in Odoo**; the **Sales Manager approves it
in Odoo**; the **warehouse prepares it**, and after loading **validates the delivery**; when the customer's **financial account changes
in Odoo** (invoice posted, payment recorded) it shows on the platform.

| Customer sees | What happens | Who, where |
|---|---|---|
| Received | BFL saved the request and queued a **draft quotation** in the outbox: customer, `client_order_ref` = the BFL reference, product and cartons per line, delivery address, notes, **no price**. A cash buyer goes on the shared cash account with their name, phone and address in the note. | BFL (the only write) |
| Waiting for approval | The quotation reached Odoo and has a number, e.g. S00012. | Outbox worker |
| Approved | The quotation was confirmed. | Sales Manager, in Odoo |
| Dispatched | The delivery was validated after loading. | Warehouse, in Odoo |
| Invoiced | An invoice was posted: the balance goes up. | Finance, in Odoo |
| Paid | A payment was recorded: the balance goes down. | Finance, in Odoo |

BFL never confirms, sends or cancels an order and never writes an invoice or payment; it only reads. Until the Odoo sync exists the
staff screen **Sample Odoo** plays those people (one button per step, labelled with who does it in Odoo) so the whole journey can be
tested. It writes the same tables the real sync will fill (`odoo_orders`, `odoo_invoices`, `odoo_payments`, `odoo_customer_finance`),
is staff-only, and the server answers 404 for it as soon as `BFL_ODOO_CONNECTED=1`. Delete it when the sync is accepted.

**Customer screens** (catalogue, signed in): the strip under the header has **My orders** (each order with BFL's reference, Odoo's
number, a six-step bar, what happens next, the lines, and the invoiced amount once Odoo has invoiced it) and **My balance** (amount
owed, overdue, credit limit, available credit, open invoices, recent payments). They refresh every 15 seconds. A **cash customer has no
balance**: the shared cash account's balance, invoices and history are never shown to anyone, and a cash buyer sees only the orders
placed on BFL. After submitting, the session ends (shared-phone rule), so "Follow my order" asks them to sign in again.

**Not in this slice:** the credit check that blocks a submit over the limit (next); available credit does not yet subtract orders still
waiting to be invoiced; lots recorded at loading do not yet feed the shelf-expiry records; real Odoo status is not read.

## Decisions recorded from the owner (2026-10-21)

- **Sign-in is tied to the customer's Odoo identity.** The customer record in BFL is the Odoo customer (`odoo_customer_ref`); the price
  list, rep, credit limit and balance all come from that Odoo customer. *Open question:* an Odoo ID alone is a guessable number, so the
  customer needs a second thing only they know (today the access code). Not changed yet.
- **Staff roles:** one shared staff login today, so "Sales Manager only" cannot be enforced per person. Per-person accounts and roles
  are needed (slice 8a).

## Slice 7 — sign-in, accounts and roles

**The front page `/` is the sign-in page** (Customer and Staff tabs, plus "Browse the catalogue" and "Register a new customer").

**Customers** sign in with their **Odoo customer ID and a password** (`POST /api/auth/customer/login`).
- **First time:** "Activate your account" — the ID plus the access code staff sent them proves it is them; they choose their own
  password (8+ characters, not their ID, phone, email or name). After that the access code alone no longer signs them in.
- **The ID** is `customers.odoo_customer_ref`. Until the Odoo sync fills it (none of the imported customers have one yet), staff can set
  it on the Access Codes screen ("Odoo ID"), and a customer with no Odoo ID can use the phone number or email they registered with —
  only if it matches exactly one customer without an Odoo ID. A shared or junk number ("0") signs nobody in.
- **Reset:** staff "Reset password" clears the password, ends their sessions and issues a new access code to activate again.
- A password session belongs to the customer's own device and lasts until they sign out (the session no longer ends with each order;
  a code-only session still does).

**Staff** sign in with an **email address or a phone number** and a password. Accounts live in `staff_users`; the **administrator** is the
one account set in the server's environment (it creates the others).

| Role | Reaches | Lands on |
|---|---|---|
| Administrator | everything, including Team | staff app |
| Sales Manager | Registrations, Access Codes, Requests, Approvals, Expiry (rw), Sample Odoo, Product Master (read only), Shop visits (any rep), Team (sales reps only) | Registrations |
| Sales rep | their own phone screens only; the rep comes from the login, not the request | Shop visits |
| Warehouse | Product Master, Imports, Change Review, Expiry, Scan | Product Master |

Enforced **on the server** for every API route and page (`requireRole`, `privatePageFor`), not just hidden in the menu. The role is read from
the database on every request, so switching an account off, or changing its role, takes effect at once. A new account gets a one-time
password shown once on the Team screen; until the person chooses their own, the only thing they can do is choose it.

**Safety:** passwords are scrypt hashes (salted); unknown ID and wrong password are indistinguishable in the reply and the time taken;
sign-in is throttled per address and per account; cookies are signed, HttpOnly and SameSite=Strict; no password, hash, code or internal id
appears in any response a browser can read (tested).

**Go-live switch:** set `BFL_ALLOW_CODE_SIGNIN=0` and the access code alone never signs anyone in (activation with ID + code still works).
Until then, a customer who has not set a password can still use the code in the old way.

**Not done:** a customer or staff member cannot yet recover a forgotten password by themselves (staff reset it); no one-time code to a new
phone (the plan's C01); the administrator's password is changed on the server, not on screen.

## Slice 8 — the credit check

**The rule** (from the plan): available credit = credit limit − amount owed − open orders not yet invoiced. Example: limit 10,000, owed
6,000, an earlier order of 2,500 waiting for approval leaves **1,500, not 4,000**. A new request is refused only if it comes to **more than**
that (exactly equal is allowed). **Only the limit blocks.** An overdue invoice or a missed payment day triggers reminders (a later slice),
never a block.

- **Where:** inside the request's own transaction (`assertCredit` in `onInsert`), so two requests cannot both spend the same credit; a
  refused request leaves nothing behind (no request, no order, no queued quotation). The drawer also asks `POST /api/catalog/requests/credit-check`
  as the cart changes, shows the reason in red and disables Submit; the server re-checks at submission regardless.
- **What counts as open:** orders that are Received, Waiting for approval, Approved or Dispatched. Invoiced orders move into "owed"; paid or
  cancelled orders give the credit back. An order's open value is Odoo's quotation total once the sync reads it, and the customer's
  price-list figure until then (`odoo_orders.amount_open`).
- **When nothing is checked (fail open, on purpose):** a cash customer (no credit), a credit customer whose limit Odoo has not given us, or a
  customer with no price class (we cannot value the request). A gap in our data must not stop anyone ordering; the Sales Manager still
  approves every quotation in Odoo. A limit of **0** is a limit.
- **What the customer sees:** only their own figures, in plain words ("This request comes to about GHS 270.90, which is more than your
  available credit of GHS 166.38"). My balance now shows available credit net of open orders and says how much that is.
- **Sample Odoo:** the Customer accounts table lists every credit customer with an order, with open orders and available credit, so a limit
  can be set before the first invoice. Until a limit is set the customer is not checked.
- **Still to confirm:** whether Odoo's credit limit already includes open sales orders (the plan says BFL subtracts them; if Odoo's own
  "available credit" does, we must not subtract twice when the real figure is read).

## Slice 9 — payment reminders (S07 "Payments due")

The platform **reminds; it does not collect**. Customers pay as they do today and Finance records the payment in Odoo; when Odoo shows the
invoice paid, the reminders stop. Staff screen **Payments due** (Sales Manager and administrator).

- **Schedule per credit customer** (set by the Sales Manager): *each invoice's due date* (default), *every week on a weekday*, or *every month
  on a date* (a month shorter than the date uses its last day). The **payment day** of an invoice is its due date, or the first scheduled
  weekday/date on or after the invoice date.
- **When:** the day before the payment day, on it, then every 7 days while unpaid. Checked at server start and then hourly
  (`BFL_REMINDERS=off` turns it off), and by the "Check for reminders now" button. One reminder per customer per day at most. A server that was off
  on the day still sends **one** reminder when it comes back (within 6 days), never a backlog.
- **Who:** credit customers with open invoices only. A cash customer is never reminded. Each message lists **only that customer's own open
  invoices** (number, amount, pay-by day or how overdue), the total, and no credit figures. The wording follows how things stand now.
- **Logged:** every reminder is kept in `payment_reminders` (the day it was for, who it went to, the full text, status). **No email, SMS or
  WhatsApp provider is connected yet**, so a reminder is *ready to send*: staff copy the message, send it themselves, and tap **Mark sent**
  (who and when are recorded). Address = email, else phone, else logged as "no contact on file".
- **Never a block:** only going over the credit limit blocks an order (tested).
- **Customers** see their own "pay by" day on each open invoice and their payment day under My balance.
- Screen: tiles (overdue, due this week, later, reminders ready), every open invoice with where it stands, the reminder log with preview, and the
  schedule editor.
- **Still to decide:** the email/SMS/WhatsApp provider (then "Mark sent" becomes automatic); who is told when a customer has no contact.

## Slice 10 — product visibility rules (S02)

The Sales Manager can **hide** products from **one customer, a price class, or everyone (including visitors)**, by **category** (and everything
under it), **brand** or **one product**. Staff screen **Product visibility**: add a rule, rules in force, a **preview** (how many products a
customer sees and which are hidden — it uses the very same filter the catalogue uses), and a change log.

- **Enforced on the server, from one function** (`hiddenClause`): the product list and search, the facet counts and category chips, a product's
  page, its image, its **price**, and any **request or order line** naming it are all affected. A hidden product answers "not found" exactly like
  one that does not exist, so a customer cannot tell a rule is there. A customer whose old cart holds a hidden product is refused at submission.
- **Rules only hide.** Removing one ("Show again") switches it off and is logged; nothing is deleted. A product with no category is never hidden by a
  category rule by accident.
- **Brand:** Odoo's Brand field is not filled yet (it is on the data clean-up list), so a brand rule matches the product **name** as a whole word
  ("ABIDO" hides "ABIDO ALL SPICE" but not "ABIDONIA"). It becomes an exact match once the Brand field is filled in Odoo.
- Answers that depend on who is asking now carry `Vary: Cookie`, and product images are cached privately.
- **Still to decide:** whether rules should also apply to sales reps ordering on a customer's behalf (not built yet), and named customer groups beyond
  price classes.

## Slice 11 — monthly reports (S06)

Three reports, built from what BFL has read from Odoo plus BFL's own records, for any calendar month (the month in progress is **month-to-date**,
updated every time it is opened). Staff screen **Monthly reports**.

| Report | For | What |
|---|---|---|
| CEO monthly summary | Sales Manager, administrator | The twelve measures, each with **this month, last month, the same month last year and the target**, and a green/amber/red mark against the target (against last year where there is no target) |
| Sales Manager report | Sales Manager, administrator | Sales by rep (vs target), top 20 customers, dormant customers (30/60/90 days), top/bottom products, category, brand, ABC, price classes, BFL quotations, lost demand, money owed by age, customers over their limit, orders blocked by the credit check, returns and credit notes by reason/customer/rep |
| Warehouse report | Warehouse, Sales Manager, administrator | Stock by category (month end vs last month), days of stock, out-of-stock lines, slow and dead stock, expiry bands and decisions, clearance, customer-shelf expiry by rep, shelf-life exceptions, fulfilment, returns received |

- **Definitions** are the specification's, exactly: *sales* = invoiced sales minus credit notes, before tax, in GHS (never orders placed); quantities
  in cartons; "month end" = 23:59 on the last day; the shared cash account is cash sales, not a customer; lapsed = invoiced in the 3 months before last
  month with none in the last 2; DSO = money owed at month end ÷ average daily net sales of the last 90 days; money owed is worked out **as it stood at
  month end** (payments and credit notes after that day do not count).
- **Marks.** Up-is-good measures: ≥100% of the reference green, ≥90% amber, else red. Down-is-good (money owed, DSO, lapsed customers, expiry loss): at or
  below the reference green, within 10% amber, else red. With nothing to compare against there is no mark. A **month still in progress has no marks**
  (comparing a part month with whole months would paint everything red).
- **Targets** are entered by the Sales Manager on the screen: for the company (net sales, active/new customers, collections, average order value, fill
  rate) and per rep (net sales, collections, active customers); for one month or "every month" (the month's own wins). Without one, "vs target" is blank.
- **The three lines** (what happened, why, what we will do) are written by the report owner on the screen — the Sales Manager for the CEO and Sales
  reports, the warehouse for the Warehouse report — saved per report and month, and printed with the report.
- **Delivery.** Every section downloads as **CSV**; "Print or save as PDF" uses the browser. **Not built:** the automatic PDF by email on working day 3 (no email
  provider is connected yet), and the daily "month so far" dashboard beyond the screen itself.
- **Reps** see only their own customers and figures: a **My month** card at the top of their phone page (net sales vs target, active customers, collections,
  customers to call). The rep comes from their login, never from the request. Company-wide reports are refused to a rep (403).
- **Never in a report:** a cost, margin or stock value; a phone number or an address (tested). Money appears in the warehouse report only as a sales value.
- **Extra data BFL now keeps for the reports:** invoice lines, credit notes, the order-check log (orders refused for low stock — *lost demand* — and by the credit
  check), a daily stock snapshot by category (so month-end stock can be read back; taken at start and hourly), and cartons ordered/delivered per order.
- **Sample data.** Until Odoo is connected the figures come from the Sample Odoo stand-in. Its new button **Load fourteen months of sample history** fills made-up but
  consistent orders, invoices (with lines), payments, credit notes, lost demand and month-end stock for your first credit customers, so every number has something to
  compare with. Imported Odoo customers are now treated as credit customers (`customer_type` CREDIT) unless they registered as cash.
- **Not available until the real Odoo is read:** *Orders through BFL* (needs every Odoo sales order, not just BFL's), clearance results (cartons sold and discount need
  clearance selling on BFL), exact Brand (the report uses the first word of the product name), and real fill rate (the stand-in always delivers in full).

## Slice 12 — returns to classify (S04, W4)

Returns are handled in **Odoo**: the return delivery goes to a quarantine location, never back into sellable stock, and Finance issues the credit note. BFL reads them.
Odoo has no field for the **reason**, so the warehouse records it here: **damaged, expired or other** (other needs a note), within **3 days** — after that a return shows
on the dashboard, the Returns menu badge and the bell. Staff screen **Returns**.

- **Returned cartons are subtracted from the customer's shelf record and the matching shop alert closes as Returned** (a lot refused at a visit, "return expected", closes when
  it arrives; a part return leaves the rest of the lot alerting). The screen also lists **returns expected** from shop visits so the warehouse can prepare.
- **Agreements broken:** an **expiry** return on a lot where the customer had **agreed a discount** (approved by the Sales Manager) is flagged, with the agreement record
  (percentage, who agreed, when) and the credit note already given.
- **Roles:** the warehouse and administrator decide the reason; a Sales Manager can read the screen (and sees the broken agreements); a rep cannot open it.
- A shelf discount's credit note (recorded on the Approvals screen) now also becomes an Odoo credit note (kind DISCOUNT) with its value, so the expiry-loss and returns
  figures include it; a credit-note number cannot be recorded twice.
- **Sample Odoo** plays Odoo's part: *Receive return into quarantine* (from the shelf deliveries and the BFL orders that were delivered, net of what already came back) and
  *Issue credit note* (the goods at the customer's price; for a BFL order it lowers what the customer owes).
- **Still open:** W-4 (a return-reason field in Odoo is not needed — BFL keeps the reason), the real Odoo return/credit-note sync, and photo evidence on returns.

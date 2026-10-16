# AGENTS.md — Box for Less Sales Catalog

_Same rules as `CLAUDE.md`; keep the two files in step._

## PROJECT IDENTITY

**Project:** Box for Less — customer sales platform connected to Odoo
(catalogue, ordering, balances, warehouse expiry, monthly reports).
**This directory:** `C:\Users\lenovo\ClaudeProjects\BoxForLess_SalesCatalog`
**Released so far:** `v0.4.2` — catalogue, request cart, access codes, staff admin,
Excel imports (see `CONTINUE_HERE.md`).
**Next:** the Odoo integration plan, Phases 0–7 (2026-10-16 onward).

**The plan of record is the technical specification:**
https://claude.ai/code/artifact/a5a9c2c6-142f-4e9f-9a00-2b34f6130277
Its four tabs: the main specification (Odoo connection and Sales Management),
Warehouse: Expiry, Monthly Reports, and the Readiness Checklist. When this file
and the specification disagree, the specification wins; update this file.

---

## CRITICAL PROJECT ISOLATION RULE

This is a **COMPLETELY SEPARATE PROJECT**. It must never touch any other
project under `C:\Users\lenovo\ClaudeProjects` or elsewhere.

**DO NOT:**
- modify `Shipment_Manager.html`
- modify `Shipment_Manager_v2.html`
- modify any Shipment Manager project
- import Shipment Manager code
- copy Shipment Manager logic
- delete or overwrite files belonging to another project
- modify any other ClaudeProjects project
- reuse another project's database
- reuse another project's configuration
- create dependencies on another project

**Double A** is a separate business and must be a separate project: its own
repository, database, Odoo user and API key. Never mix the two companies' data
or code paths.

All source, tests, fixtures, documentation, databases and generated files
live **inside this project directory only**.

---

## DATA SOURCE

**Odoo is the master of all business data.** BFL reads it through the Odoo
external API, as one dedicated integration user, and keeps a local read copy.

- **Allowed reads only:** the models listed in section 4.2 of the main
  specification and in the Warehouse tab (products, categories, stock, lots,
  customers, price classes, sales orders and lines, invoices and their lines,
  credit notes, payments, deliveries and returns, salespeople). Nothing else.
- **Never read cost data:** no cost prices, stock valuation, purchase orders,
  supplier prices, inventory adjustments or scrap records. Reports work without
  them.
- **The Excel import is retired** once the Phase 1 sync is accepted. Until then,
  the Odoo Excel export supplied by the user stays read-only input: it is copied,
  never edited.
- **Develop and test against a staging copy of Odoo,** never the live database.
  Production Odoo is connected only after the phase's acceptance checklist is
  signed off.
- **The API key lives only in the server's secret configuration.** Never in Git,
  logs, error messages, the browser or chat. `.env.local` holds the local
  secrets: never read it, never print it.

---

## ODOO WRITE RULES (non-negotiable)

BFL writes exactly two things to Odoo, both through the outbox
(retry-safe, duplicate-checked):

1. **Draft quotations** (`sale.order` in `draft`): customer from the signed-in
   session, BFL reference in `client_order_ref`, product and carton quantity per
   line, no price (Odoo calculates it). A clearance line may carry a discount and
   name its lot.
2. **New customers** (`res.partner`), only after the Sales Manager approves the
   registration, with the BFL registration reference in `ref`.

BFL **never** confirms, sends or cancels orders, and never writes invoices,
payments, journal entries, stock moves, pricelists, credit limits, product data,
or edits to existing customers. A person approves every order in Odoo.

---

## DATA SAFETY RULE (non-negotiable)

Neither the sync nor an import may **ever** delete, in BFL or in Odoo:
- products, images or categories
- history
- requests or orders
- customer information

Instead:
- Missing or archived records become **inactive**, never deleted.
- Barcode and UoM changes are **flagged for human review**, never applied silently.
- **Images** are **application-controlled** and are NEVER touched by a sync or import.
- **Categories:** Odoo is the source of truth. Every change is logged
  (`CATEGORY_CHANGE_DETECTED`); nothing is overwritten silently.
- Every sync run and import is **transactional**: a failed run leaves the
  database unchanged.
- **Odoo wins** on any conflict. BFL keeps the customer's original submission
  beside the Odoo version.

---

## CUSTOMER-FACING DATA RULES

- **Prices** may be shown from Phase 3, per carton in GHS, from the customer's
  own Odoo price class, **only to signed-in, approved customers.** Never to
  visitors or pending customers. (CEO approval, 2026-10.)
- A customer response must never contain: another customer's data, cost prices,
  internal IDs, blocked products, or company-wide figures. The leak tests assert
  this and must keep passing.
- **Identity always comes from the session, never from the request body.**
- **Product visibility rules** are enforced on the server for every list, search,
  count, product page and order line — never only hidden on screen.
- **Reps** see only the customers assigned to them as salesperson in Odoo.
- Company-wide reports go to managers only.

---

## STACK (chosen for this environment)

- **Runtime:** Node.js (>= 22) — `node:sqlite` built-in (no native build needed).
- **Backend:** Express REST API. All Odoo calls go through one client module
  (`src/odoo/client.js`).
- **Database:** SQLite file (`data/*.db`) via the built-in `node:sqlite` module.
  Move to PostgreSQL only if more than one server is needed.
- **Excel import:** SheetJS (`xlsx`), until it is retired after Phase 1.
- **Frontend:** plain HTML, CSS and JavaScript (ES modules under `src/public/js`, no framework, no build step, nothing from a CDN). Pages are built with small DOM helpers (`js/lib/dom.js`); a field someone types into is built once and never rebuilt. Pure logic (`cart.js`, `scan-core.js`, `orientation.js`, `product-image.js`) stays DOM-free and is covered by the Node tests.
- **Tests:** Node built-in test runner (`node --test`). Odoo is replaced in tests by
  a fake Odoo server that can time out, fail and return duplicates.

---

## PHASES AND GATES

| Phase | Scope |
| --- | --- |
| 0 | Foundations: Odoo access, staging Odoo, integration user, hosting, team |
| 1 | Read from Odoo: products, stock, customers, invoices, payments, sales orders |
| 2 | Accounts, sales reps, visibility rules |
| 3 | Prices from Odoo price classes |
| 4 | Orders to Odoo as draft quotations, status and history |
| 5 | Credit check and balance page |
| 6 | Notifications |
| 7 | Warehouse expiry (W1–W4) and monthly reports |

- **Phase 0 starts** only when every item in group A of the Readiness Checklist
  is Done.
- **Each phase goes live** only after its acceptance checklist is signed off on
  staging by the Sales Manager and the Operations & Development lead.
- **Do not build ahead of the current phase** without the Operations &
  Development lead's approval.
- **Do not deploy** to a public host until Readiness item A5 (lifting the
  deployment hold, host and domain) is Done.
- Never modify Shipment Manager or any other project.

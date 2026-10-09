# CLAUDE.md — Box for Less Sales Catalog

## PROJECT IDENTITY

**Project:** Box for Less — Digital Product Catalog & Sales Request Application
**This directory:** `C:\Users\lenovo\ClaudeProjects\BoxForLess_SalesCatalog`
**Current phase:** Phase 1 — Product Master (see `PHASE_STATUS.md`).

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

**The ONLY external business source allowed is the Box for Less Odoo
Product Variant export supplied by the user.** The original Excel file must
never be modified (it is read-only input; it is copied, never edited).

All source, tests, fixtures, documentation, databases and generated files
live **inside this project directory only**.

---

## DATA SAFETY RULE (non-negotiable)

An Odoo import must **never**:
- delete products
- delete images
- delete categories
- delete history
- delete requests / orders
- delete customer information

Instead:
- Missing products become **inactive** (never deleted).
- Barcode and UoM changes are **flagged for human review**, never applied silently.
- **Images** are **application-controlled** and are NEVER touched by an import.
- **Categories**: as of Stage 2.1 (2026-10-02) Odoo IS the source of truth, so an
  import DOES write `products.odoo_category_path`, the `categories` hierarchy and
  `products.category_id`. Every change is logged to `import_changes` as
  `CATEGORY_CHANGE_DETECTED`; nothing is overwritten silently. An export with no
  category column leaves stored categories untouched.
- Imports are **transactional** — a failed import leaves the database unchanged.

---

## STACK (chosen for this environment)

- **Runtime:** Node.js (>= 22) — `node:sqlite` built-in (no native build needed).
- **Backend:** Express REST API.
- **Database:** SQLite file (`data/*.db`) via the built-in `node:sqlite` module.
- **Excel import:** SheetJS (`xlsx`).
- **Frontend:** plain HTML, CSS and JavaScript (ES modules under `src/public/js`, no framework, no build step, nothing from a CDN). Pages are built with small DOM helpers (`js/lib/dom.js`); a field someone types into is built once and never rebuilt. Pure logic (`cart.js`, `scan-core.js`, `orientation.js`, `product-image.js`) stays DOM-free and is covered by the Node tests.
- **Tests:** Node built-in test runner (`node --test`).

---

## PHASE 1 STOP CONDITIONS

Do **not**, in Phase 1:
- build customer ordering, a request cart, or a sales dashboard
- implement or display **any pricing**
  - **Amendment (2026-10-06):** the customer import stores each customer's
    price-TIER NAME (`customers.pricelist`, e.g. `CLASS A (GHS)`). It is a label,
    not a price: no amount is imported, stored or calculated, and it never reaches
    a customer-facing payload — the leak tests assert this. It is held so that the
    tier is already known if the CEO approves showing prices. **Displaying any
    price, to staff or to customers, remains out of scope until that approval.**
- build quotation creation / Odoo quotation export
- connect directly to production Odoo
- modify Shipment Manager or any other project

Phase 1 is complete only when the Product Master and the safe, repeatable,
tested import workflow work end to end.

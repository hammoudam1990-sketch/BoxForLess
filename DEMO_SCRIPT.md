# Box for Less — team demo script

A 15–20 minute walk through one order, from the customer's phone to the monthly report. Everything is **sample
data**: Odoo is not connected, and the **Sample Odoo** screen plays Odoo's part (approving, delivering, invoicing,
paying). The same journey runs as an automatic check, `test/journey.test.js` (19 steps), so what you show here is
what the tests prove.

## Before the demo (2 minutes)

1. In the project folder run `npm run demo`. It rebuilds the demo data from scratch (the real product catalogue, three
   demo customers, a rep, fourteen months of sample history) and starts the demo on **port 3001**, beside the live
   one on 3000. Rerun it before every presentation so it starts clean.
2. The sign-ins are in **`data/demo-accounts.txt`** (never committed). Open the demo at `http://localhost:3001`, or on
   a phone on the same Wi-Fi at the LAN address the script prints.
3. Use two browser windows: **A** for staff, **B** (a private window, or a phone) for the customer. Cookies are
   shared between ports on one computer, so do not mix the live system (3000) and the demo (3001) in one window.

| Who | Sign in | Where |
| --- | --- | --- |
| Sales Manager | email + password, **Staff** tab | `/` then Staff |
| Warehouse | email + password, **Staff** tab | `/` then Staff |
| Sales rep (Rita) | email + password, **Staff** tab (lands on the phone page) | `/` then Staff |
| Customer (Demo Mini Mart) | **Odoo ID 7001** + password, **Customer** tab | `/` or `/catalog` |

## The story

### 1. The team is set up (Sales Manager)
- Sign in as the **Sales Manager**. **Team**: Rita Rep, the warehouse person. A manager can add reps, not other managers.
- **Rep customers**: Demo Mini Mart and three shops belong to Rita; each rep sees only their own.
- *Say:* every role sees only its own screens, and the server enforces it, not just the menu.

### 2. The warehouse flags stock close to expiry; the Sales Manager puts a discount on it
- Sign in as **Warehouse**: **Expiry**. Lots by band (expired, critical, warning, early); value at risk; decisions.
  The warehouse can see a **Customer discount** column but cannot change it.
- Back as the **Sales Manager**: on **Expiry**, find **UNICCA CHOCOLAT DARK 18G*24**, lot SAMPLE-0022, type **30** and
  press **Set**. (Only the Sales Manager can; the limit is 90%.)

### 3. The customer sees it and orders (window B)
- Sign in as **Demo Mini Mart** (Odoo ID 7001). The catalogue now has a **"Discounted — near expiry"** section: 30% off,
  best-before date, the customer's own price struck through, how many cartons are on offer.
- Visitors and customers who are not signed in see **no prices and no offers**.
- Add **12 cartons** of the chocolate, and 2 cartons of anything else. Open **My request**: 12 cartons at the discounted
  price (+ the rest at the normal price) and a total. **Submit**.
- **My orders**: the reference (REQ-…) and the first step, "Received".
- *Credit check (optional):* a very large order is refused: "over your available credit". It is counted for the report.

### 4. "Odoo" handles the order (Sales Manager — **Sample Odoo**)
- The order is waiting. Step through it: **Send quotation** (Odoo gives it a number S0…, as a *draft* with no price) →
  **Confirm** (the Sales Manager approves it in Odoo) → **Deliver** (the warehouse validates the delivery after loading)
  → **Invoice** (Finance) → later **Pay**.
- After each step show the customer's **My orders**: the status moves and Odoo's number appears. After **Invoice**,
  **My balance** shows what they owe and the invoice carries the **discount** (the sample invoice mirrors what Odoo does
  for the discounted line).
- **Payments due**: the reminder for this invoice is composed the day before the due date; it lists only this customer's
  own invoices.

### 5. A rep visits a shop that holds near-expiry stock (Sales Manager, then Rita on a phone)
- As the **Sales Manager**: **Approvals** → *Set a discount for customer shelves* → lot **SAMPLE-0022** (the chocolate on
  the Baah & Sons Provisions shelf) → **20%**.
- Sign in as **Rita** (phone page): **My visits** shows only her three shops. Open **Baah & Sons Provisions**: the
  lot shows *"20% offered by the Sales Manager"*, pre-filled. Choose **A discount was agreed**, contact name, tick the
  confirmation, **Save visit**.
- It is **approved at once** (within the Sales Manager's discount). As the **Sales Manager**: **Approvals** → *For Finance*
  shows the credit note to issue → enter a number (for example CN/DEMO/1) → the alert closes.
- *If the rep types more than 20%*, it waits for the Sales Manager to approve or turn down, with a reason.

### 6. Goods come back (Sample Odoo → Warehouse)
- **Sample Odoo → Returns**: receive 1 carton back from the order; Finance issues the credit note.
- As **Warehouse**: **Returns** → give the reason (**Damaged**). It must be done within 3 days or the menu badge shows it.
- *Discounted cartons are not returnable* (the offer says so). Return **more** cartons than were not on the discount and the
  return appears under **Agreements broken** for the Sales Manager, with the discount, the lot and the credit note given.

### 7. The reports agree with all of it
- **Monthly reports** (Sales Manager). The month selector opens on last month: choose **this month**.
  - **CEO summary**: net sales = invoices − credit notes; collections; expiry loss = clearance discount + the shelf
    discount credit note (a damaged return is *not* an expiry loss).
  - **Sales Manager report**: *Sales by rep* (Rita), *Top customers*, *Products*, *Price classes* (discounts given),
    *Quotations* (created / approved), *Orders blocked by the credit check*, *Returns by reason*.
  - **Warehouse report**: *Clearance results* (the discounted lot: offered, cartons sold at the discount, discount given),
    *Customer-shelf expiry* (Rita's visit), *Returns received*, *Fulfilment*.
- Sign in as **Rita**: **My month** shows her own figures and nothing company-wide; the company reports are refused.
- *Say:* one order, five roles, and the numbers match everywhere. That is what the automatic journey test checks.

## What is real and what is not
- **Real:** sign-in and roles, the catalogue, prices by price class (sample prices), offers, the request cart, the credit
  check, the order and its draft quotation, visibility rules, payment reminders, shop visits and discounts, returns,
  every report.
- **Stand-in until Odoo is connected:** the stock, prices and customers come from sample data and the Sample Odoo screen
  plays Odoo. Nothing is sent to any Odoo, and nothing is emailed or texted (reminders are copied and marked sent by hand).
- **Not built yet:** automatic report email, self-service password recovery, reps ordering on a customer's behalf, cash
  customer pages, and the live Odoo connection itself (see `ODOO_CONNECTION_PLAN.md`).

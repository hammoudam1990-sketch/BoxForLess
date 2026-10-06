# Stage 4 — Customer Access, Customer Master & Staff Sign-in

**Status:** ✅ **COMPLETE** — implemented, server-verified, and **verified on a real
phone (2026-10-05 and 2026-10-06)**. Released as `v0.4.1`.

Stage 4 answers one question Stage 3 left open: *how does a customer prove who they
are?* Stage 3 let them pick their company from a list. That list was the problem.

---

## 1. The exposure this closed

The catalogue is public, so a customer can browse without signing in. Stage 3 also
gave it `GET /api/catalog/customers?q=` so a customer could find their own company.

Together those meant **anyone holding the catalogue link could enumerate the entire
customer book** by typing letters:

```
GET /api/catalog/customers?q=lim
→ Akil Company Limited · AVI - MELCOM LIMITED · Daddy Ash Limited ·
  DAL - MELCOM LIMITED · Don Costillo Limited · …
```

It was flagged in `STAGE_3_REQUESTS.md` as a known limitation and was theoretical
while the customer master was empty. It stopped being theoretical on 2026-10-05,
when 504 real customers were imported.

**The endpoint is gone.** A per-customer **access code** replaced it: the customer
*proves* who they are rather than *finding* themselves in a list, so there is
nothing left to search. Browsing stays public; sending a request does not.

> Do not reintroduce a customer lookup on the customer-facing router. `DA4b` in
> `test/customer-import.test.js` asserts it stays removed and leaks no name.

---

## 2. Access codes

Eight characters, shown as `7K2M-9XQR`.

| Property | Value | Why |
|---|---|---|
| Alphabet | `23456789ABCDEFGHJKMNPQRSTUVWXYZ` | `0 O 1 I L` removed — the characters people misread copying a code off a phone screen |
| Length | 8 | 31⁸ ≈ 8.5 × 10¹¹ combinations |
| Generation | rejection sampling | 256 mod 31 ≠ 0, so plain modulo would favour the first few symbols |
| Storage | **plain text** | staff must read a code back to send it; a one-way hash makes the feature impossible |
| Uniqueness | unique index | two customers sharing a code would let one order as the other |

**Typing is forgiving but never substituting.** Case, spaces and dashes are
ignored, so `7k2m-9xqr`, `7K2M 9XQR` and `7K2M9XQR` are one code. A character
outside the alphabet is *dropped*, never mapped onto another — a mistyped `O` must
not silently become a different valid code.

**The code checks itself on the eighth character.** There is nothing to wait for
once a fixed-length code is complete. Customers typed their code and saw nothing
happen because they had not pressed Continue, and had no reason to think they
needed to. Continue remains for pasting and for retrying a refused code.

### Threat model

A code is a shared secret sent to one company over WhatsApp. It is not a password:
not per-person, not secret from that company's staff, and it protects ordering, not
money. Guessing is defeated by the keyspace plus **10 attempts per IP per 15
minutes**. Forwarding is the real risk, which is why a code can be reissued — and
reissuing invalidates the previous one immediately.

Deactivating a customer also revokes their access at once.

---

## 3. Sessions end with the order

Entering a code sets a signed, `HttpOnly`, `SameSite=Strict` cookie. It is separate
from the staff cookie and signed with a separate secret, so neither can forge the
other. The customer is re-read from the database on every request, so a
deactivation takes effect immediately rather than when a cookie happens to expire.

**A submission ends the session.** A salesman carries ONE phone between several
customers in a day. A session that outlived the order would file the next
customer's request under the previous one — on a shared device that is not an edge
case, it is the normal working pattern.

Clearing the cookie alone was not enough: the token is self-contained, so a browser
ignoring the clear would keep a working session. Customers carry a
**`session_epoch`**, bumped whenever their sessions end, and a token names the epoch
it was issued under. A token from before the bump is refused whoever sends it. That
makes it a guarantee rather than a request to the browser.

"Not you?" bumps the epoch too, so it genuinely revokes.

---

## 4. "I don't have a code"

Asking for access and placing an order are **separate acts**. A stranger can only
ask.

```
customer fills the form  →  access_requests row, status PENDING
staff approve            →  customer created (or matched) + code issued
staff send the code      →  customer orders
```

The form requires a **contact name, a phone number and a delivery address**.
Company is optional — an individual buyer may not have one. A company that cannot
be delivered to cannot be supplied, so the address is collected before access is
granted rather than chased afterwards.

The acknowledgement is identical whether the company is already a customer or not,
so submitting the form reveals nothing about who is on the list.

Approving creates the customer, writes the address onto the record (filling a
missing one, never overwriting), and issues the code — all in one transaction.
Approving a company already in the master **reuses** that record rather than
duplicating it. An approval cannot be applied twice.

---

## 5. Delivery addresses

| | |
|---|---|
| New company asking for access | **required** |
| The 504 imported customers | **not blocked** — asked, never stopped |
| On each request | pre-filled from the customer record, editable |
| Editing it | applies to **that request only** — a redirected delivery is not a move |

`customers.delivery_address` holds the standing address;
`requests.delivery_address` holds where that particular order went. Staff see the
address on the request, because the people packing it need to know where it goes.

---

## 6. Customer master import

Separate from the product importer, auditing to its own `customer_imports` table,
so nothing it does can alter product import history or what `/api/imports` returns.
Preview writes nothing; nothing lands until an explicit confirm.

Full rules in `IMPORT_RULES.md`. The three that matter most:

- **Identity is the display name** (decision **D1**). Odoo supplies no stable
  customer id. `odoo_customer_ref` is matched first when present and stays
  nullable, so real ids can be adopted later without a migration — today none of
  the 504 has one.
- **Absence does not deactivate** (decision **D3**). A contact export is often a
  filtered view, and a deactivated customer's code stops working at once.
  `deactivate_missing=true` is opt-in.
- **Codes are issued automatically** on confirm, reported as `codesIssued`. A code
  already held is never regenerated, so re-importing cannot invalidate a code
  already sent.

**Odoo data is never edited, merged or de-duplicated here.** If the same company
arrives twice under different names, both records are kept and both get a code.
Corrections belong in Odoo.

---

## 7. Staff sign-in

`/`, `/index.html` and `/scan.html` redirect to a sign-in. `/api/products`,
`/api/imports`, `/api/reviews`, `/api/requests` and `/api/customer-imports` sit
behind `requireStaff`. **`/catalog` and `/api/catalog/*` stay public by design.**

An eight-hour signed session; 8 attempts per IP per 15 minutes; a same-origin check
on every write. It **fails closed** — if `BFL_STAFF_USERNAME`,
`BFL_STAFF_PASSWORD` (≥12 bytes) or `BFL_SESSION_SECRET` (≥32 bytes) is missing or
too short, staff endpoints return 503 rather than opening up.

Two staff screens were added: **Access Codes** (search, copy a code, copy a
ready-to-send message, issue/reissue) and **Access Requests** (approve or reject,
with a badge counting those waiting).

Copying falls back to a hidden textarea, because `navigator.clipboard` does not
exist over plain http on the LAN — which is how the staff shell is normally opened.

---

## 8. Request actions

| Action | Effect |
|---|---|
| Accept | `SUBMITTED` → `ACCEPTED`. Holds no stock. |
| Export | Two-sheet `.xlsx` — the request, and its lines. |
| **Withdraw** | `status = DELETED` + `deleted_at`. **Nothing is destroyed.** |
| Restore | Brings a withdrawn request back to `SUBMITTED`. |

Withdrawing replaced a hard `DELETE` (decision **D4**). Nothing else in this
project destroys data — products go inactive, imports never delete, request items
keep snapshots so an order still reads correctly months later. The hard delete was
the one exception, and it had already cost information: two requests disappeared on
2026-10-04 with nothing left to show who removed them.

A withdrawn request keeps its reference, customer, lines, quantities and snapshots.
It leaves the active list and appears under a **Withdrawn** tab with the customer
and the full order.

---

## 9. Data model (additive only)

**`products` — unchanged. No new columns.** The Product Master cannot regress.

| Table | Added |
|---|---|
| `customers` | `access_code` (unique when present) · `access_code_issued_at` · `email` · `pricelist` · `delivery_address` · `session_epoch` |
| `requests` | `delivery_address` · `deleted_at` |
| `customer_imports` | new — audit for the customer list import |
| `access_requests` | new — companies asking for a code |

`customers.pricelist` holds a price-**TIER NAME** (e.g. `CLASS A (GHS)`), never an
amount. It never reaches a customer-facing payload, and no price is displayed
anywhere pending a CEO decision (**D2**). See `CLAUDE.md`.

---

## 10. API

| Route | Audience |
|---|---|
| `GET / POST /api/catalog/access` | customer — session status / enter a code |
| `POST /api/catalog/access/exit` | customer — "Not you?" |
| `POST /api/catalog/access-requests` | **open** — asking for a code |
| `POST /api/catalog/requests` | customer — identity from the SESSION, never the body |
| `GET /api/requests/customers/codes` | staff — the live codes |
| `POST /api/requests/customers/:id/code` | staff — issue / reissue |
| `GET /api/requests/access-requests` | staff — who is waiting |
| `POST /api/requests/access-requests/:id/approve` \| `/reject` | staff |
| `POST /api/requests/:id/accept` \| `/restore` · `DELETE /api/requests/:id` | staff |
| `GET /api/requests/:id/export.xlsx` | staff |
| `POST /api/customer-imports` · `/:id/confirm` | staff |
| ~~`GET /api/catalog/customers`~~ | **REMOVED** — see §1 |

**Submission identity comes from the signed session, never the request body.**
`customerId`, `customerHandle`, `customerRef` and `unlisted` in the body are all
ignored, so a customer cannot submit in another company's name even by crafting the
payload.

---

## 11. Files

**New:** `src/domain/access-codes.js` · `src/domain/access-requests.js` ·
`src/server/customer-access.js` · `src/server/staff-auth.js` ·
`src/server/routes/customer-imports.js` · `src/import/customer-service.js` ·
`src/public/js/access.js` · `src/public/js/staff-login.js` ·
`src/public/staff-login.html` · `scripts/issue-access-codes.js` ·
`scripts/import-customers-cli.js` · `scripts/daily-update.js` ·
`test/access-codes.test.js` · `test/customer-import.test.js` · `test/cart.test.js`

---

## 12. Running it day to day

```bash
node scripts/daily-update.js            # preview both imports, write nothing
node scripts/daily-update.js --confirm  # apply
```

Finds the newest Product Variant and Contact exports in Downloads, prints which
files it chose and how old they are, and finishes by stating whether customers can
submit requests.

**Submissions are blocked 24 hours after each import.** Browsing is never blocked.
The clock starts at the confirm, not at the Odoo export.

---

## 13. Verification

**Automated: 280/280.** `test/access-codes.test.js` covers alphabet safety,
modulo-bias coverage, forgiving input without substitution, revocation on reissue
and on deactivation, submitting without a code, **submitting in another customer's
name**, four kinds of forged cookie, rate limiting, the session ending at
submission, code non-disclosure on every customer endpoint, the approve/reject
flow, and automatic code issuance on import.

**Write paths exercised against a COPY of the production database**, never
production — the convention Stage 3 established. Customer journey 29/29, staff
journey 25/25.

### ✅ Real-device verification — PASSED

| Check | Date |
|---|---|
| Access code entry, auto-validation, Submit turning grey → blue | 2026-10-06 |
| Placing an order; over-stock correctly refused | 2026-10-05 |
| Cart quantities and line order | 2026-10-06 |
| Delivery address required when asking for access | 2026-10-06 |
| Session ending at submission | 2026-10-06 |
| Customer name shown prominently | 2026-10-06 |
| Withdraw and restore | 2026-10-06 |

**Live data at release:** 3,883 active products · 504 customers, all holding a code.

---

## 14. Explicitly NOT in Stage 4

- ❌ No pricing displayed. A price **tier name** is stored; no amount is imported,
  stored or calculated (**D2**).
- ❌ No customer accounts, logins or passwords. An access code is not an account.
- ❌ No quotations or Odoo quotation export.
- ❌ No stock reservation — a request still holds nothing.
- ❌ No direct Odoo connection. Everything arrives as a file you export.
- ❌ No PCS; quantities remain CTN only.

---

## 15. Known limits

- **A renamed company in Odoo becomes a second record with a new code**, while the
  old record keeps the code already sent (**D1**). Not yet observed — the master
  holds 504 names with no near-duplicates.
- **`/catalog` browsing is public.** The code gates *requesting*. Product names and
  stock bands are visible to anyone with the link (**D5**).
- **Stock figures are a copy** taken at the last import, not live Odoo. This is why
  a request is explicitly not a reservation.
- **`BFL_PUBLIC_URL` must be set once deployed**, or the catalogue link staff send
  to customers is built from the server's internal address.

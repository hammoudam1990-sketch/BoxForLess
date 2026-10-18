# BoxForLess Demo Setup

Quick-start guide to run BoxForLess with demo data locally.

## Prerequisites

- **Node.js ≥ 22** (includes `node:sqlite`)
- 5 minutes of setup time

## 1. Install & Initialize

```bash
npm install
npm run migrate
```

This creates `data/product_master.db` with the schema.

## 2. Seed Demo Data

```bash
node scripts/import-cli.js fixtures/sample-products.xlsx --confirm   # 50 sample products
node scripts/demo-seed.js             # preview: what would be added
node scripts/demo-seed.js --confirm   # add it
```

This adds **6 fictional demo customers** (names end in "(Demo)"), each with an access code,
and **12 requests** spread over the last ten days (pending, accepted and one withdrawn), so the
staff dashboard has something to show. The script prints the access codes. It refuses to run
against a database with more than 50 real customers, and running it twice adds nothing.

## 3. Start the Server

**Demo mode** (LAN only, no HTTPS):
```bash
BFL_STAFF_USERNAME=admin \
BFL_STAFF_PASSWORD=DemoPass123456 \
BFL_SESSION_SECRET=demo-secret-1234567890123456789012 \
npm start
```

The server runs on `http://localhost:3000`.

## 4. Explore the App

### 👥 **Customer View** (Public)
- Visit `http://localhost:3000/catalog`
- Browse demo products by category
- Add items to cart (CTN-only)
- Enter one of the access codes printed by `demo-seed.js` to submit a request
  (codes are random, eight characters, shown as `XXXX-XXXX`).

### 🔐 **Staff View** (Requires Login)
- Staff credentials and server-side authorization remain configured as above.
- Staff sign in at `/staff/login` with the username and password above; opening
  any staff page while signed out goes there first.
- The customer `/login.html` page keeps accounts in the browser's localStorage only
  (demo accounts are listed under the form) until Phase 2 server accounts exist.
- **Dashboard** – orders, customers, pending approvals, order lines, system status
- **Products** – search, filter, review stock status
- **Imports** – preview / confirm product updates (try uploading `fixtures/sample-products.xlsx`)
- **Requests** – view customer orders, approve, or export to Excel
- **Changes** – review flagged import changes (barcode/UoM updates)

## Demo Walkthrough

### Scenario 1: Browse & Order (Customer)
1. Open `/catalog` in a browser (or phone)
2. Search for "cases" or scroll categories
3. Add a few products to cart
4. Click **Request**
5. Enter one of the codes printed by `demo-seed.js`
6. Submit

### Scenario 2: Approve Requests (Staff)
1. Open the staff area at `/index.html` with an existing staff session
2. Go to **Requests**
3. See the customer request you just made
4. Click **Approve** or **Export to Excel**

### Scenario 3: Import Products (Staff)
1. Sign in
2. Go to **Imports**
3. Drop `fixtures/sample-products.xlsx` (or use the UI file picker)
4. Preview changes (see added, updated, flagged rows)
5. Click **Confirm Import** to apply

## Files Created by Demo

After running `demo-seed.js`:

- `data/product_master.db` — SQLite database (persists across restarts)
- `data/product_master-demo.backup.db` — backup before seeding (optional, shows original)

To reset:
```bash
rm data/product_master.db
npm run migrate
node scripts/demo-seed.js
```

## Environment Variables Reference

| Variable | Demo Value | Purpose |
|---|---|---|
| `BFL_STAFF_USERNAME` | `admin` | Staff sign-in name |
| `BFL_STAFF_PASSWORD` | `DemoPass123456` | Staff password (≥12 chars) |
| `BFL_SESSION_SECRET` | `demo-secret-1234567890123456789012` | Session cookie secret (≥32 chars) |
| `NODE_ENV` | `development` | Skip HTTPS checks on LAN |
| `BFL_PUBLIC_URL` | *(optional)* | Public catalog URL (defaults to `http://localhost:3000`) |

## Troubleshooting

### Port 3000 already in use
```bash
# Use a different port
PORT=3001 npm start
```

### "Cannot find module 'node:sqlite'"
```bash
# Node version too old; upgrade to ≥22
node --version
```

### "Access code not found" on request submit
- Make sure you used one of the 5 demo codes above
- Check that `demo-seed.js` ran successfully (it prints the codes)

### Database locked error
- Close all other connections to `data/product_master.db`
- Stop other instances of the server

## Next Steps

- Read `ARCHITECTURE.md` for the system design
- Check `IMPORT_RULES.md` to understand the import validation logic
- See `STAGE_*` docs for feature details
- Run `npm test` (269 tests) to verify everything works

---

**Need live data?** Replace `data/product_master.db` with a copy from production, then just run the server. No re-seeding needed.

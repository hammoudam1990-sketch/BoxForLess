// Data Quality Audit Engine — Group B Readiness Checklist (ODOO_CONNECTION_PLAN.md Section 3).
// Measures data readiness in BFL so the Sales Manager can fix discrepancies in Odoo before Phase 1 sync goes live.
// Checks:
//   B1: Duplicate customers (name, phone, or email)
//   B2: Customers without a salesperson
//   B3: Customers without a price class
//   B4: Credit customers without a credit limit
//   B5: Customers without phone or email
//   B6: Products without a barcode or category
//   B7: Products without an identifiable brand
//   B8: Perishable lots without an expiry date

/**
 * Run all Group B data quality audits over the database.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {object} Comprehensive data quality report
 */
export function runDataQualityAudit(db) {
  const ts = new Date().toISOString();

  // 1. Total counts
  const totalCustomers = db.prepare('SELECT COUNT(*) AS n FROM customers WHERE is_active = 1').get()?.n || 0;
  const totalProducts = db.prepare('SELECT COUNT(*) AS n FROM products WHERE is_active = 1').get()?.n || 0;
  const totalLots = db.prepare('SELECT COUNT(*) AS n FROM delivery_lots').get()?.n || 0;

  // B1: Duplicate customers (same name normalized, or duplicate non-empty phone/email)
  const duplicateNames = db.prepare(`
    SELECT lower(trim(name)) AS norm_name, COUNT(*) AS count, GROUP_CONCAT(name, ' | ') AS original_names, GROUP_CONCAT(id) AS ids
      FROM customers
     WHERE is_active = 1 AND trim(name) != ''
     GROUP BY norm_name
    HAVING count > 1
  `).all();

  const duplicatePhones = db.prepare(`
    SELECT trim(phone) AS phone, COUNT(*) AS count, GROUP_CONCAT(name, ' | ') AS customers, GROUP_CONCAT(id) AS ids
      FROM customers
     WHERE is_active = 1 AND phone IS NOT NULL AND trim(phone) != ''
     GROUP BY trim(phone)
    HAVING count > 1
  `).all();

  const duplicateEmails = db.prepare(`
    SELECT lower(trim(email)) AS email, COUNT(*) AS count, GROUP_CONCAT(name, ' | ') AS customers, GROUP_CONCAT(id) AS ids
      FROM customers
     WHERE is_active = 1 AND email IS NOT NULL AND trim(email) != ''
     GROUP BY lower(trim(email))
    HAVING count > 1
  `).all();

  const b1Items = [
    ...duplicateNames.map((r) => ({ type: 'NAME', key: r.norm_name, details: r.original_names, count: r.count, ids: r.ids })),
    ...duplicatePhones.map((r) => ({ type: 'PHONE', key: r.phone, details: r.customers, count: r.count, ids: r.ids })),
    ...duplicateEmails.map((r) => ({ type: 'EMAIL', key: r.email, details: r.customers, count: r.count, ids: r.ids })),
  ];

  // B2: Customers without a salesperson
  const b2Items = db.prepare(`
    SELECT id, name, odoo_customer_ref AS odooRef, phone, email
      FROM customers
     WHERE is_active = 1
       AND (salesperson IS NULL OR trim(salesperson) = '' OR salesperson = 'false')
     ORDER BY name
  `).all();

  // B3: Customers without a price class
  const b3Items = db.prepare(`
    SELECT id, name, odoo_customer_ref AS odooRef, customer_type AS customerType
      FROM customers
     WHERE is_active = 1
       AND (pricelist IS NULL OR trim(pricelist) = '' OR pricelist = 'false')
     ORDER BY name
  `).all();

  // B4: Credit customers without a credit limit
  const b4Items = db.prepare(`
    SELECT c.id, c.name, c.odoo_customer_ref AS odooRef, c.salesperson,
           COALESCE(f.credit_limit, 0) AS creditLimit
      FROM customers c
      LEFT JOIN odoo_customer_finance f ON f.customer_id = c.id
     WHERE c.is_active = 1
       AND (c.customer_type IS NULL OR c.customer_type = 'CREDIT')
       AND (f.credit_limit IS NULL OR f.credit_limit <= 0)
     ORDER BY c.name
  `).all();

  // B5: Customers without phone or email
  const b5Items = db.prepare(`
    SELECT id, name, odoo_customer_ref AS odooRef, salesperson
      FROM customers
     WHERE is_active = 1
       AND (phone IS NULL OR trim(phone) = '' OR phone = 'false')
       AND (email IS NULL OR trim(email) = '' OR email = 'false')
     ORDER BY name
  `).all();

  // B6: Products without a barcode or category
  const b6Items = db.prepare(`
    SELECT id, name, barcode, odoo_category_path AS categoryPath, box_uom AS boxUom
      FROM products
     WHERE is_active = 1
       AND (
            barcode IS NULL OR trim(barcode) = '' OR
            odoo_category_path IS NULL OR trim(odoo_category_path) = '' OR
            category_id IS NULL
           )
     ORDER BY name
  `).all();

  // B7: Products without an identifiable brand
  // A brand is considered missing if the name has fewer than 2 characters or starts with generic filler
  const activeProducts = db.prepare(`
    SELECT id, name, barcode, odoo_category_path AS categoryPath
      FROM products
     WHERE is_active = 1
     ORDER BY name
  `).all();

  const b7Items = activeProducts.filter((p) => {
    const trimmed = String(p.name || '').trim();
    if (trimmed.length < 3) return true;
    const firstWord = trimmed.split(/[\s/_-]+/)[0].toUpperCase();
    return !firstWord || /^(ITEM|PRODUCT|BOX|GOODS|SAMPLE)$/.test(firstWord);
  });

  // B8: Perishable lots without an expiry date
  const b8Items = db.prepare(`
    SELECT l.id, l.lot_code AS lotCode, l.delivered_ctn AS cartons, p.name AS product, p.barcode, c.name AS customer
      FROM delivery_lots l
      JOIN products p ON p.id = l.product_id
      JOIN customers c ON c.id = l.customer_id
     WHERE (l.expiry_date IS NULL OR trim(l.expiry_date) = '' OR l.expiry_date = '0000-00-00')
     ORDER BY l.id
  `).all();

  const summary = {
    B1: { count: b1Items.length, name: 'Duplicate Customers', code: 'B1' },
    B2: { count: b2Items.length, name: 'Missing Salesperson', code: 'B2' },
    B3: { count: b3Items.length, name: 'Missing Price Class', code: 'B3' },
    B4: { count: b4Items.length, name: 'Credit Customer Without Limit', code: 'B4' },
    B5: { count: b5Items.length, name: 'Missing Phone & Email', code: 'B5' },
    B6: { count: b6Items.length, name: 'Missing Barcode or Category', code: 'B6' },
    B7: { count: b7Items.length, name: 'Missing Brand', code: 'B7' },
    B8: { count: b8Items.length, name: 'Lots Without Expiry Date', code: 'B8' },
  };

  const totalIssues = Object.values(summary).reduce((acc, curr) => acc + curr.count, 0);
  const status = totalIssues === 0 ? 'READY_FOR_SYNC' : 'ACTION_REQUIRED_IN_ODOO';

  return {
    auditedAt: ts,
    status,
    totalIssues,
    totals: {
      customers: totalCustomers,
      products: totalProducts,
      lots: totalLots,
    },
    summary,
    details: {
      B1_duplicate_customers: b1Items,
      B2_customers_without_salesperson: b2Items,
      B3_customers_without_price_class: b3Items,
      B4_customers_without_credit_limit: b4Items,
      B5_customers_without_contact: b5Items,
      B6_products_without_barcode_or_category: b6Items,
      B7_products_without_brand: b7Items,
      B8_lots_without_expiry: b8Items,
    },
  };
}

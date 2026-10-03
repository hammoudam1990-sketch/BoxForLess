// Central configuration. Override via environment variables.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

export const config = {
  root: ROOT,
  // Database file. Tests override this with an in-memory / temp path.
  dbPath: process.env.BFL_DB_PATH || path.join(ROOT, 'data', 'product_master.db'),
  uploadsDir: process.env.BFL_UPLOADS_DIR || path.join(ROOT, 'data', 'uploads'),
  // Product image storage (filesystem; DB keeps only the filename/reference).
  productImagesDir: process.env.BFL_PRODUCT_IMAGES_DIR || path.join(ROOT, 'data', 'product-images'),
  maxImageBytes: Number(process.env.BFL_MAX_IMAGE_BYTES || 5 * 1024 * 1024), // 5MB server cap

  // Network binding. Default 0.0.0.0 so the dev server is reachable from other
  // devices on the SAME LAN (e.g. a phone). localhost keeps working because
  // 0.0.0.0 includes the loopback interface. Set BFL_HOST=127.0.0.1 to restrict
  // back to local-only. This never exposes anything to the public internet on
  // its own — that is governed by your router/NAT and Windows Firewall.
  host: process.env.BFL_HOST || '0.0.0.0',
  port: Number(process.env.PORT || 3000),

  // Optional HTTPS (required for the phone CAMERA / barcode scanner, because
  // getUserMedia only works in a secure context: https:// or http://localhost).
  // HTTPS starts automatically when both cert files exist (run `npm run gen-cert`).
  httpsPort: Number(process.env.BFL_HTTPS_PORT || 3443),
  tlsKeyPath: process.env.BFL_TLS_KEY || path.join(ROOT, 'certs', 'key.pem'),
  tlsCertPath: process.env.BFL_TLS_CERT || path.join(ROOT, 'certs', 'cert.pem'),

  // Stock-status thresholds (Phase-1-ready; status is COMPUTED, never stored,
  // so later phases can tune these without any schema change).
  stock: {
    // field used to decide availability for the customer catalog later
    availabilityField: 'free_to_use',
    outOfStockAtOrBelow: 0,   // <= 0  => OUT_OF_STOCK
    limitedAtOrBelow: 5,      // <= 5  => LIMITED_STOCK  (else IN_STOCK)

    // How old the last successful stock import may be before customer REQUEST
    // SUBMISSION is blocked (browsing is never blocked). Odoo is the operational
    // truth and this catalog holds a copy, so a stale copy must not be used to
    // accept requests. Configurable, never hard-coded.
    freshnessHours: Number(process.env.BFL_STOCK_FRESHNESS_HOURS || 24),
  },

  // Customer-facing search over the customer master. Search-only by design: there
  // is no browse-all list, so the full customer list is never enumerable in one go.
  customerSearch: {
    minQueryLength: Number(process.env.BFL_CUSTOMER_SEARCH_MIN || 3),
    maxResults: Number(process.env.BFL_CUSTOMER_SEARCH_MAX || 20),
    // Keys the opaque customer handle sent to browsers, so the Odoo customer id
    // never leaves the server. Set BFL_CUSTOMER_HANDLE_SECRET in any deployment
    // where handles should not be reproducible from the source code.
    handleSecret: process.env.BFL_CUSTOMER_HANDLE_SECRET || 'bfl-customer-handle-v1',
  },
};

export default config;

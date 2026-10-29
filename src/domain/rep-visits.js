// Sales rep app: which shops to visit (nearest expiry first) and the shelf check recorded at a
// visit. Quantities and dates only — no price, amount or discount is read or stored here.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import config from '../config.js';
import { validateImage } from './images.js';

export const OUTCOMES = ['OK', 'SOLD_OUT', 'RETURN', 'NOT_CHECKED'];
export const WINDOW_DAYS = 60;      // lots expiring further out than this are not shown
export const EXPIRING_DAYS = 30;    // counted in the "lots expiring" tile
export const OVERDUE_AFTER_DAYS = 14;
const DAY = 86400000;

export class VisitError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const today = (now) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
const daysUntil = (iso, now) => Math.round((Date.parse(`${iso}T00:00:00Z`) - today(now).getTime()) / DAY);

// A lot stays open until a visit marks it sold out or returned.
const OPEN_LOT = `NOT EXISTS (SELECT 1 FROM rep_visit_lines v WHERE v.lot_id = l.id AND v.outcome IN ('SOLD_OUT','RETURN'))`;

function openLots(db, now, customerId = null) {
  const limit = new Date(today(now).getTime() + WINDOW_DAYS * DAY).toISOString().slice(0, 10);
  const rows = db.prepare(`
    SELECT l.id, l.customer_id, l.product_id, l.lot_code, l.delivered_ctn, l.expiry_date,
           p.name AS product_name, p.box_uom, p.primary_image_id,
           (SELECT v.shelf_ctn FROM rep_visit_lines v WHERE v.lot_id = l.id AND v.shelf_ctn IS NOT NULL
              ORDER BY v.id DESC LIMIT 1) AS last_shelf_ctn
      FROM delivery_lots l JOIN products p ON p.id = l.product_id
     WHERE l.expiry_date <= ? AND ${OPEN_LOT} ${customerId ? 'AND l.customer_id = ?' : ''}
     ORDER BY l.expiry_date, l.id`).all(...(customerId ? [limit, customerId] : [limit]));
  return rows.map((r) => ({
    id: r.id,
    customerId: r.customer_id,
    productId: r.product_id,
    productName: r.product_name,
    packSize: r.box_uom || null,
    hasImage: !!r.primary_image_id,
    lotCode: r.lot_code,
    deliveredCtn: r.delivered_ctn,
    shelfCtn: r.last_shelf_ctn ?? r.delivered_ctn,
    expiryDate: r.expiry_date,
    daysLeft: daysUntil(r.expiry_date, now),
  }));
}

/** Shops with open lots, nearest expiry first, plus the three summary tiles. */
export function repShops(db, { q = '', now = new Date() } = {}) {
  const lots = openLots(db, now);
  const byCustomer = new Map();
  for (const lot of lots) {
    if (!byCustomer.has(lot.customerId)) byCustomer.set(lot.customerId, []);
    byCustomer.get(lot.customerId).push(lot);
  }
  const ids = [...byCustomer.keys()];
  if (!ids.length) return { summary: { shopsToVisit: 0, overdue: 0, lotsExpiring: 0 }, shops: [] };

  const ph = ids.map(() => '?').join(',');
  const customers = db.prepare(`SELECT id, name, odoo_customer_ref, country FROM customers WHERE is_active = 1 AND id IN (${ph})`).all(...ids);
  const lastVisit = new Map(db.prepare(`SELECT customer_id, MAX(visited_at) AS at FROM rep_visits WHERE customer_id IN (${ph}) GROUP BY customer_id`)
    .all(...ids).map((r) => [r.customer_id, r.at]));

  const needle = String(q).trim().toLowerCase();
  let shops = customers.map((c) => {
    const own = byCustomer.get(c.id);
    const nearest = own[0].daysLeft;
    const last = lastVisit.get(c.id) || null;
    const sinceVisit = last ? Math.floor((now.getTime() - Date.parse(last)) / DAY) : null;
    return {
      id: c.id,
      name: c.name,
      ref: c.odoo_customer_ref || String(c.id),
      area: c.country || null,
      lots: own.length,
      nearestDays: nearest,
      lastVisitAt: last,
      overdue: nearest <= OVERDUE_AFTER_DAYS && (sinceVisit === null || sinceVisit > OVERDUE_AFTER_DAYS),
    };
  }).sort((a, b) => a.nearestDays - b.nearestDays || a.name.localeCompare(b.name));

  const summary = {
    shopsToVisit: shops.length,
    overdue: shops.filter((s) => s.overdue).length,
    lotsExpiring: lots.filter((l) => l.daysLeft <= EXPIRING_DAYS).length,
  };
  if (needle) shops = shops.filter((s) => s.name.toLowerCase().includes(needle) || s.ref.toLowerCase().includes(needle));
  return { summary, shops };
}

/** One shop's open lots (the visit form), nearest expiry first. */
export function shopLots(db, customerId, { now = new Date() } = {}) {
  const customer = db.prepare('SELECT id, name, odoo_customer_ref, country FROM customers WHERE id = ? AND is_active = 1').get(customerId);
  if (!customer) throw new VisitError('Shop not found.', 404);
  return {
    shop: { id: customer.id, name: customer.name, ref: customer.odoo_customer_ref || String(customer.id), area: customer.country || null },
    lots: openLots(db, now, customerId),
  };
}

function savePhoto(visitLineId, photo) {
  const { ext } = validateImage(photo.buffer, photo.mimetype);
  const dir = path.join(config.uploadsDir, 'visit-photos');
  fs.mkdirSync(dir, { recursive: true });
  const file = `${visitLineId}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(dir, file), photo.buffer);
  return file;
}

/**
 * Record a visit. `lines` is [{ lotId, shelfCtn, outcome }]; `photos` maps lotId -> { buffer, mimetype }.
 * All-or-nothing: a bad line saves nothing and leaves no photo files behind.
 */
export function saveVisit(db, { customerId, repName, contactName, noReturnAgreed = false, lines, photos = new Map() }, { now = new Date() } = {}) {
  const contact = String(contactName || '').trim();
  if (!contact) throw new VisitError('Enter the customer contact name.');
  if (!Array.isArray(lines) || !lines.length) throw new VisitError('Record at least one lot.');
  const customer = db.prepare('SELECT id FROM customers WHERE id = ? AND is_active = 1').get(customerId);
  if (!customer) throw new VisitError('Shop not found.', 404);

  const lotStmt = db.prepare(`SELECT l.id, l.delivered_ctn FROM delivery_lots l WHERE l.id = ? AND l.customer_id = ? AND ${OPEN_LOT}`);
  const clean = [];
  const seen = new Set();
  for (const line of lines) {
    const lot = lotStmt.get(Number(line.lotId), customerId);
    if (!lot) throw new VisitError('A lot does not belong to this shop or is already closed.');
    if (seen.has(lot.id)) throw new VisitError('A lot appears twice.');
    seen.add(lot.id);
    const outcome = line.outcome || 'OK';
    if (!OUTCOMES.includes(outcome)) throw new VisitError('Unknown outcome.');
    let shelf = null;
    if (outcome !== 'NOT_CHECKED') {
      shelf = outcome === 'SOLD_OUT' ? 0 : Number(line.shelfCtn);
      if (!Number.isInteger(shelf) || shelf < 0 || shelf > lot.delivered_ctn) {
        throw new VisitError(`Cartons on the shelf must be a whole number from 0 to ${lot.delivered_ctn}.`);
      }
    }
    let returnReason = null;
    let returnNote = null;
    if (outcome === 'RETURN') {
      if (line.returnReason !== undefined) {
        const rr = String(line.returnReason || '').trim().toUpperCase();
        if (!['DAMAGED', 'EXPIRED', 'OTHER'].includes(rr)) {
          throw new VisitError('Choose a reason for the return (damaged, expired, or other).');
        }
        const rn = String(line.returnNote ?? '').trim().slice(0, 300) || null;
        if (rr === 'OTHER' && !rn) {
          throw new VisitError('Enter a note explaining the other return reason.');
        }
        returnReason = rr;
        returnNote = rn;
      } else {
        returnReason = 'EXPIRED';
      }
    }
    clean.push({ lotId: lot.id, shelf, outcome, returnReason, returnNote });
  }

  const written = [];
  try {
    db.exec('BEGIN');
    const visitId = Number(db.prepare(`INSERT INTO rep_visits (customer_id, rep_name, contact_name, no_return_agreed, visited_at)
      VALUES (?, ?, ?, ?, ?)`).run(customerId, repName, contact, noReturnAgreed ? 1 : 0, now.toISOString()).lastInsertRowid);
    const ins = db.prepare('INSERT INTO rep_visit_lines (visit_id, lot_id, shelf_ctn, outcome, return_reason, return_note, photo_file) VALUES (?, ?, ?, ?, ?, ?, NULL)');
    const setPhoto = db.prepare('UPDATE rep_visit_lines SET photo_file = ? WHERE id = ?');
    for (const c of clean) {
      const lineId = Number(ins.run(visitId, c.lotId, c.shelf, c.outcome, c.returnReason, c.returnNote).lastInsertRowid);
      const photo = photos.get(c.lotId);
      if (photo) {
        const file = savePhoto(lineId, photo);
        written.push(file);
        setPhoto.run(file, lineId);
      }
    }
    db.exec('COMMIT');
    return { visitId, lots: clean.length };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* no open transaction */ }
    for (const f of written) fs.rmSync(path.join(config.uploadsDir, 'visit-photos', f), { force: true });
    throw e;
  }
}

export function visitPhotoPath(db, lineId) {
  const row = db.prepare('SELECT photo_file FROM rep_visit_lines WHERE id = ?').get(lineId);
  if (!row?.photo_file) return null;
  return path.join(config.uploadsDir, 'visit-photos', path.basename(row.photo_file));
}

export default { repShops, shopLots, saveVisit, visitPhotoPath, OUTCOMES };

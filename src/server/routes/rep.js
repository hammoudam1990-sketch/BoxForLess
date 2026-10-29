// API for the sales rep phone app. Mounted behind requireRep. Quantities and dates only.
import express from 'express';
import multer from 'multer';
import config from '../../config.js';
import { readPrimaryImage } from '../../domain/images.js';
import { repShops, shopLots, saveVisit, VisitError } from '../../domain/rep-visits.js';
import { repMonth, monthOf } from '../../domain/reports.js';
import { todayString } from '../../domain/expiry-list.js';
import { listReps } from '../../domain/shelf.js';

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxImageBytes + 1024 * 1024, files: 40, fields: 5 },
});

const repName = (req) => req?.staff?.name || process.env.BFL_REP_NAME || process.env.BFL_REP_USERNAME || 'Sales rep';

router.get('/me', (req, res) => {
  const name = repName(req);
  let monthSummary = null;
  try {
    const today = todayString();
    const reps = listReps(today, req.db);
    const matched = reps.find((r) => r.id === req.staff?.repId || r.name === name) || reps[0];
    if (matched) monthSummary = repMonth(req.db, matched.name, monthOf(today), today);
  } catch { /* ignore */ }
  res.json({
    name,
    role: req.staff?.role || 'SALES_REP',
    roleLabel: 'Sales Representative',
    monthSummary,
  });
});

router.get('/shops', (req, res, next) => {
  try { res.json(repShops(req.db, { q: req.query.q })); } catch (e) { next(e); }
});

router.get('/shops/:id/lots', (req, res, next) => {
  try { res.json(shopLots(req.db, Number(req.params.id))); } catch (e) { next(e); }
});

router.get('/products/:id/image', (req, res, next) => {
  try {
    const img = readPrimaryImage(req.db, Number(req.params.id));
    if (!img) return res.status(404).json({ error: 'No image' });
    res.set('Content-Type', img.contentType);
    res.set('Cache-Control', 'private, max-age=300');
    res.send(img.buffer);
  } catch (e) { next(e); }
});

// multipart: `visit` = JSON { customerId, contactName, noReturnAgreed, lines:[{lotId,shelfCtn,outcome}] },
// plus optional files named `photo_<lotId>`.
router.post('/visits', upload.any(), (req, res, next) => {
  try {
    let body;
    try { body = JSON.parse(req.body?.visit || ''); } catch { throw new VisitError('The visit could not be read.'); }
    const photos = new Map();
    for (const f of req.files || []) {
      const m = /^photo_(\d+)$/.exec(f.fieldname);
      if (m) photos.set(Number(m[1]), { buffer: f.buffer, mimetype: f.mimetype });
    }
    const result = saveVisit(req.db, {
      customerId: Number(body.customerId),
      repName: repName(req),
      contactName: body.contactName,
      noReturnAgreed: !!body.noReturnAgreed,
      lines: body.lines,
      photos,
    });
    res.status(201).json(result);
  } catch (e) { next(e); }
});

export default router;

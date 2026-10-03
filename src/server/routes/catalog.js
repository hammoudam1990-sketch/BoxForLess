// Customer-facing catalog API. READ-ONLY.
//
// Every response body is produced by domain/catalog.js's allow-list serializer.
// No handler here ever touches a Product Master row directly, so there is one
// place — and only one — where a field could become customer-visible.
import express from 'express';
import {
  searchCatalog, getCatalogProduct, resolveInternalId, catalogFacets, categoryFacets,
  DEFAULT_SORT, DEFAULT_PAGE_SIZE,
} from '../../domain/catalog.js';
import { readPrimaryImage } from '../../domain/images.js';
import { StockStatus } from '../../domain/constants.js';

const router = express.Router();

// Query-string availability value -> internal status. Anything else = no filter.
const AVAILABILITY_PARAM = Object.freeze({
  in_stock: StockStatus.IN_STOCK,
  limited: StockStatus.LIMITED_STOCK,
  out_of_stock: StockStatus.OUT_OF_STOCK,
});
const SORT_PARAM = Object.freeze({ name_asc: 'name_asc', name_desc: 'name_desc' });

// GET /api/catalog/products?search=&availability=&with_image=&sort=&limit=&offset=
router.get('/products', (req, res, next) => {
  try {
    const { search = '', availability, with_image: withImage, view, top_level: topLevel, category_path: categoryPath, sort, limit, offset } = req.query;
    res.json(searchCatalog(req.db, {
      search,
      availability: AVAILABILITY_PARAM[String(availability || '').toLowerCase()] || 'ALL',
      withImage: String(withImage) === 'true',
      // view=full shows every active product; anything else is "Available Now"
      availableOnly: String(view || '').toLowerCase() !== 'full',
      topLevel: topLevel || null,
      categoryPath: categoryPath || null,
      sort: SORT_PARAM[String(sort || '').toLowerCase()] || DEFAULT_SORT,
      limit: limit || DEFAULT_PAGE_SIZE,
      offset,
    }));
  } catch (e) { next(e); }
});

// GET /api/catalog/facets — counts for the filter chips (no quantities).
router.get('/facets', (req, res, next) => {
  try { res.json(catalogFacets(req.db)); } catch (e) { next(e); }
});

// GET /api/catalog/categories — the Odoo category tree with counts (names only).
router.get('/categories', (req, res, next) => {
  try { res.json({ items: categoryFacets(req.db) }); } catch (e) { next(e); }
});

// GET /api/catalog/products/:id — :id is the PUBLIC id (barcode), never products.id.
router.get('/products/:id', (req, res, next) => {
  try {
    const product = getCatalogProduct(req.db, req.params.id);
    // An inactive product and an unknown product are deliberately the same 404:
    // the catalog must not confirm that a hidden product exists.
    if (!product) return res.status(404).json({ error: 'Product not found' });
    res.json(product);
  } catch (e) { next(e); }
});

// GET /api/catalog/products/:id/image — reuses the EXISTING image store.
// No new image table, no new storage, and the filename is never disclosed.
router.get('/products/:id/image', (req, res, next) => {
  try {
    const internalId = resolveInternalId(req.db, req.params.id);
    if (!internalId) return res.status(404).json({ error: 'No image' });
    const img = readPrimaryImage(req.db, internalId);
    if (!img) return res.status(404).json({ error: 'No image' });
    res.set('Content-Type', img.contentType);
    // Let phones cache briefly so scrolling the grid does not re-download, but
    // keep it short: the URL has no version token, so a replaced photo must be
    // allowed to appear without the customer clearing their cache.
    res.set('Cache-Control', 'public, max-age=300');
    res.send(img.buffer);
  } catch (e) { next(e); }
});

export default router;

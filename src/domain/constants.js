// Domain enums & canonical column mapping. Single source of truth.

export const ImportStatus = Object.freeze({
  PREVIEW: 'PREVIEW',
  CONFIRMED: 'CONFIRMED',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
});

export const ChangeType = Object.freeze({
  PRODUCT_CREATED: 'PRODUCT_CREATED',
  PRODUCT_UPDATED: 'PRODUCT_UPDATED',
  BARCODE_CHANGE_DETECTED: 'BARCODE_CHANGE_DETECTED',
  UOM_CHANGE_DETECTED: 'UOM_CHANGE_DETECTED',
  PRODUCT_MARKED_INACTIVE: 'PRODUCT_MARKED_INACTIVE',
  PRODUCT_REACTIVATED: 'PRODUCT_REACTIVATED',
  CATEGORY_CHANGE_DETECTED: 'CATEGORY_CHANGE_DETECTED',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
});

/** Separator between segments of an Odoo category path. */
export const CATEGORY_SEPARATOR = ' / ';

export const ReviewStatus = Object.freeze({
  NA: 'NA',
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED',
});

export const DataQuality = Object.freeze({
  OK: 'OK',
  WARNING: 'WARNING',
  ERROR: 'ERROR',
});

export const StockStatus = Object.freeze({
  IN_STOCK: 'IN_STOCK',
  LIMITED_STOCK: 'LIMITED_STOCK',
  OUT_OF_STOCK: 'OUT_OF_STOCK',
});

// Canonical internal field <- accepted source header aliases (case/space-insensitive).
// Matching is done on a normalized header key (lowercased, non-alphanumerics stripped).
// NOTE on `internalreference`/`reference`: these were previously listed as
// BARCODE aliases. That is wrong — in Odoo "Internal Reference" is default_code,
// the stable product reference, not the EAN. An export carrying BOTH columns
// therefore had its Internal Reference silently captured as the barcode while
// the real Barcode column was dropped as a duplicate target, which made every
// product look new. They belong to source_odoo_id.
export const COLUMN_ALIASES = Object.freeze({
  source_odoo_id: ['id', 'odooid', 'externalid', 'productid', 'variantid',
    'internalreference', 'internalref', 'reference', 'defaultcode'],
  barcode: ['barcode', 'ean', 'ean13'],
  name: ['name', 'productname', 'description'],
  box_uom: ['boxuom', 'uom', 'unitofmeasure', 'uomname'],
  category_path: ['productcategory', 'category', 'odoocategory', 'categ', 'productcategorypath'],
  on_hand: ['onhand', 'onhandctndecimal', 'onhandctn', 'qtyonhand'],
  free_to_use: ['freetouse', 'freetousectn', 'available', 'qtyavailable'],
  incoming: ['incoming', 'incomingctn', 'incomingqty'],
  outgoing: ['outgoing', 'outgoingctn', 'outgoingqty'],
  forecasted: ['forecasted', 'forecastedctndecimal', 'forecastedctn', 'virtualavailable'],
});

// Fields that MUST be present (as columns) for an import to proceed.
export const REQUIRED_COLUMNS = Object.freeze(['barcode', 'name', 'box_uom']);

// Odoo-controlled stock fields (numeric).
export const STOCK_FIELDS = Object.freeze([
  'on_hand', 'free_to_use', 'incoming', 'outgoing', 'forecasted',
]);

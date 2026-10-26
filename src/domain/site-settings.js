/**
 * Site Settings & Builder Domain
 * Provides configurable settings for:
 * 1. Customer Storefront (branding, hero section, announcement ticker, display policies)
 * 2. Sales Rep Portal (branding, feature toggles, broadcast banner, discount presets, expiry policy)
 * 3. Operations & Stock (stock thresholds, warehouse notices)
 */

export const DEFAULT_SITE_SETTINGS = Object.freeze({
  storefront: {
    storeName: 'Box for Less',
    tagline: 'Wholesale Confectionery & Beverage Distribution',
    supportPhone: '+233 24 456 7890',
    whatsappNumber: '+233 24 456 7890',
    currencySymbol: 'GH₵',
    announcement: {
      enabled: true,
      text: 'Real-time inventory sync active. Guaranteed next-day delivery across Greater Accra.',
      tone: 'brand', // brand | info | warn | ok
    },
    hero: {
      headline: 'Direct Wholesale Ordering Platform',
      subtitle: 'Premium confectionery, beverages, biscuits, and daily FMCG lines at transparent bulk rates.',
      ctaText: 'Explore Catalog',
      ctaLink: '#catalog',
    },
    policies: {
      allowGuestBrowsing: true,
      requireAccessCodeToOrder: true,
      hideOutOfStock: false,
      showExactStock: true,
      enableBulkReorder: true,
    },
  },
  salesRep: {
    portalTitle: 'Sales Rep Field Hub',
    portalSubtitle: 'Route navigation, customer balance checks & shelf expiry audits',
    features: {
      enableWhatsApp: true,
      enableMaps: true,
      enableCall: true,
      enableQuickDiscount: true,
    },
    broadcastNotice: 'Team Target: Prioritize Near-Expiry stock batches for promotional clearance today.',
    discountPresets: [5, 10, 15, 20, 25],
    expiryWarningDays: 60,
    requireCustomerConfirmation: true,
  },
  operations: {
    outOfStockThreshold: 0,
    lowStockThreshold: 20,
    warehouseNotice: 'Central Warehouse: Spintex Road, Accra. Operating hours: Mon-Sat 08:00 - 17:00 GMT.',
  },
});

/**
 * Initialize site_settings table and seed row if missing.
 */
export function initSiteSettings(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS site_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      settings TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT
    )`);

  const existing = db.prepare('SELECT id FROM site_settings WHERE id = 1').get();
  if (!existing) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO site_settings (id, settings, updated_at, updated_by)
      VALUES (1, ?, ?, 'system')
    `).run(JSON.stringify(DEFAULT_SITE_SETTINGS), now);
  }
}

/**
 * Read current site settings, safely merged with defaults in case new fields were added.
 */
export function getSiteSettings(db) {
  initSiteSettings(db);
  const row = db.prepare('SELECT settings, updated_at, updated_by FROM site_settings WHERE id = 1').get();
  if (!row) {
    return { ...DEFAULT_SITE_SETTINGS, _meta: { updatedAt: new Date().toISOString(), updatedBy: 'system' } };
  }
  try {
    const parsed = JSON.parse(row.settings);
    // Deep merge with defaults
    const merged = {
      storefront: {
        ...DEFAULT_SITE_SETTINGS.storefront,
        ...(parsed.storefront || {}),
        announcement: {
          ...DEFAULT_SITE_SETTINGS.storefront.announcement,
          ...((parsed.storefront && parsed.storefront.announcement) || {}),
        },
        hero: {
          ...DEFAULT_SITE_SETTINGS.storefront.hero,
          ...((parsed.storefront && parsed.storefront.hero) || {}),
        },
        policies: {
          ...DEFAULT_SITE_SETTINGS.storefront.policies,
          ...((parsed.storefront && parsed.storefront.policies) || {}),
        },
      },
      salesRep: {
        ...DEFAULT_SITE_SETTINGS.salesRep,
        ...(parsed.salesRep || {}),
        features: {
          ...DEFAULT_SITE_SETTINGS.salesRep.features,
          ...((parsed.salesRep && parsed.salesRep.features) || {}),
        },
      },
      operations: {
        ...DEFAULT_SITE_SETTINGS.operations,
        ...(parsed.operations || {}),
      },
      _meta: {
        updatedAt: row.updated_at,
        updatedBy: row.updated_by,
      },
    };
    return merged;
  } catch (_e) {
    return { ...DEFAULT_SITE_SETTINGS, _meta: { updatedAt: row.updated_at, updatedBy: row.updated_by } };
  }
}

/**
 * Update site settings (Admin only).
 */
export function updateSiteSettings(db, newSettings, updatedBy = 'admin') {
  if (!newSettings || typeof newSettings !== 'object') {
    throw new Error('Invalid settings object');
  }

  const current = getSiteSettings(db);

  // Validate and sanitize values
  const updated = {
    storefront: {
      storeName: String(newSettings.storefront?.storeName ?? current.storefront.storeName).trim() || 'Box for Less',
      tagline: String(newSettings.storefront?.tagline ?? current.storefront.tagline).trim(),
      supportPhone: String(newSettings.storefront?.supportPhone ?? current.storefront.supportPhone).trim(),
      whatsappNumber: String(newSettings.storefront?.whatsappNumber ?? current.storefront.whatsappNumber).trim(),
      currencySymbol: String(newSettings.storefront?.currencySymbol ?? current.storefront.currencySymbol).trim() || 'GH₵',
      announcement: {
        enabled: Boolean(newSettings.storefront?.announcement?.enabled ?? current.storefront.announcement.enabled),
        text: String(newSettings.storefront?.announcement?.text ?? current.storefront.announcement.text).trim(),
        tone: ['brand', 'info', 'warn', 'ok'].includes(newSettings.storefront?.announcement?.tone)
          ? newSettings.storefront.announcement.tone
          : current.storefront.announcement.tone,
      },
      hero: {
        headline: String(newSettings.storefront?.hero?.headline ?? current.storefront.hero.headline).trim(),
        subtitle: String(newSettings.storefront?.hero?.subtitle ?? current.storefront.hero.subtitle).trim(),
        ctaText: String(newSettings.storefront?.hero?.ctaText ?? current.storefront.hero.ctaText).trim(),
        ctaLink: String(newSettings.storefront?.hero?.ctaLink ?? current.storefront.hero.ctaLink).trim(),
      },
      policies: {
        allowGuestBrowsing: Boolean(newSettings.storefront?.policies?.allowGuestBrowsing ?? current.storefront.policies.allowGuestBrowsing),
        requireAccessCodeToOrder: Boolean(newSettings.storefront?.policies?.requireAccessCodeToOrder ?? current.storefront.policies.requireAccessCodeToOrder),
        hideOutOfStock: Boolean(newSettings.storefront?.policies?.hideOutOfStock ?? current.storefront.policies.hideOutOfStock),
        showExactStock: Boolean(newSettings.storefront?.policies?.showExactStock ?? current.storefront.policies.showExactStock),
        enableBulkReorder: Boolean(newSettings.storefront?.policies?.enableBulkReorder ?? current.storefront.policies.enableBulkReorder),
      },
    },
    salesRep: {
      portalTitle: String(newSettings.salesRep?.portalTitle ?? current.salesRep.portalTitle).trim(),
      portalSubtitle: String(newSettings.salesRep?.portalSubtitle ?? current.salesRep.portalSubtitle).trim(),
      features: {
        enableWhatsApp: Boolean(newSettings.salesRep?.features?.enableWhatsApp ?? current.salesRep.features.enableWhatsApp),
        enableMaps: Boolean(newSettings.salesRep?.features?.enableMaps ?? current.salesRep.features.enableMaps),
        enableCall: Boolean(newSettings.salesRep?.features?.enableCall ?? current.salesRep.features.enableCall),
        enableQuickDiscount: Boolean(newSettings.salesRep?.features?.enableQuickDiscount ?? current.salesRep.features.enableQuickDiscount),
      },
      broadcastNotice: String(newSettings.salesRep?.broadcastNotice ?? current.salesRep.broadcastNotice).trim(),
      discountPresets: Array.isArray(newSettings.salesRep?.discountPresets)
        ? newSettings.salesRep.discountPresets.map(Number).filter((n) => Number.isFinite(n) && n > 0 && n <= 100)
        : current.salesRep.discountPresets,
      expiryWarningDays: Number.isFinite(Number(newSettings.salesRep?.expiryWarningDays))
        ? Math.max(1, Math.min(365, Number(newSettings.salesRep.expiryWarningDays)))
        : current.salesRep.expiryWarningDays,
      requireCustomerConfirmation: Boolean(newSettings.salesRep?.requireCustomerConfirmation ?? current.salesRep.requireCustomerConfirmation),
    },
    operations: {
      outOfStockThreshold: Number.isFinite(Number(newSettings.operations?.outOfStockThreshold))
        ? Math.max(0, Number(newSettings.operations.outOfStockThreshold))
        : current.operations.outOfStockThreshold,
      lowStockThreshold: Number.isFinite(Number(newSettings.operations?.lowStockThreshold))
        ? Math.max(0, Number(newSettings.operations.lowStockThreshold))
        : current.operations.lowStockThreshold,
      warehouseNotice: String(newSettings.operations?.warehouseNotice ?? current.operations.warehouseNotice).trim(),
    },
  };

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO site_settings (id, settings, updated_at, updated_by)
    VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      settings = excluded.settings,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by
  `).run(JSON.stringify(updated), now, String(updatedBy));

  return {
    ...updated,
    _meta: {
      updatedAt: now,
      updatedBy: String(updatedBy),
    },
  };
}

// The Warehouse Manager's sidebar: the eight working screens, then the other warehouse tools (nothing the role could
// reach before is taken away), then a short card about the module. app.js puts it in place of the main menu for the
// WAREHOUSE role. Every link is a route the role is allowed (the server checks each one anyway).
import { h } from './lib/dom.js';
import { icon } from './lib/lucide.js';

const link = (href, nav, iconName, label, badgeId = null) => h('a', { href, 'data-nav': nav },
  icon(iconName), h('span', { class: 'wh-nav-label' }, label),
  badgeId ? h('span', { id: badgeId, class: 'badge hidden' }, '0') : null);

export function buildWarehouseNav() {
  return h('div', { class: 'wh-side' },
    h('nav', { class: 'adm-nav wh-nav', 'aria-label': 'Warehouse' },
      link('#/warehouse', 'warehouse', 'dashboard', 'Dashboard'),
      link('#/inventory', 'inventory', 'inventory', 'Inventory'),
      link('#/movements', 'movements', 'movements', 'Stock Movements'),
      link('#/expiry', 'expiry', 'expiry', 'Expiry Tracking'),
      link('#/products', 'products', 'package', 'Products'),
      link('#/reports', 'reports', 'reports', 'Reports'),
      link('#/notifications', 'notifications', 'bell', 'Notifications', 'whNotifBadge'),
      link('#/workspace/settings', 'workspace-settings', 'settings', 'Settings'),
      h('p', { class: 'adm-label' }, 'More tools'),
      link('#/imports', 'imports', 'upload', 'Stock Imports'),
      link('#/changes', 'changes', 'review', 'Change Review', 'reviewBadge'),
      link('#/returns', 'returns', 'returns', 'Sales Rep Returns', 'returnsBadge'),
      link('scan.html', 'scan', 'scan', 'Scan'),
      link('#/health', 'health', 'activity', 'Sync Health'),
      link('#/workspace/data-quality', 'workspace-data-quality', 'shieldCheck', 'Data Quality')),
    h('div', { class: 'wh-side-card' },
      h('span', { class: 'wh-side-card-icon' }, icon('warehouse')),
      h('b', null, 'Warehouse'),
      h('p', null, 'Manage stock, track movements and monitor expiry dates.')));
}

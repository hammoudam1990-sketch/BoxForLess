// The Sales Manager's sidebar: the eight working screens, then every other screen the role already had (nothing is
// taken away), then a short card. app.js puts it in place of the main menu for the SALES_MANAGER role, exactly as the
// warehouse module does. Every link is a route the role is allowed (the server checks each one anyway).
import { h } from './lib/dom.js';
import { icon } from './lib/lucide.js';

const link = (href, nav, iconName, label, badgeId = null) => h('a', { href, 'data-nav': nav },
  icon(iconName), h('span', { class: 'wh-nav-label' }, label),
  badgeId ? h('span', { id: badgeId, class: 'badge hidden' }, '0') : null);

export function buildSalesNav() {
  return h('div', { class: 'wh-side' },
    h('nav', { class: 'adm-nav wh-nav', 'aria-label': 'Sales' },
      link('#/sales', 'sales', 'dashboard', 'Dashboard'),
      link('#/performance', 'performance', 'users', 'Team Performance'),
      link('#/targets', 'targets', 'target', 'Sales Targets'),
      link('#/orders', 'orders', 'cart', 'Orders'),
      link('#/customers', 'customers', 'building', 'Customers'),
      link('#/reports', 'reports', 'reports', 'Reports'),
      link('#/notifications', 'notifications', 'bell', 'Notifications', 'smNotifBadge'),
      link('#/sales-settings', 'sales-settings', 'settings', 'Settings'),
      h('p', { class: 'adm-label' }, 'More tools'),
      link('#/access', 'access', 'userPlus', 'Registrations', 'accessBadge'),
      link('#/requests', 'requests', 'clipboardCheck', 'Requests'),
      link('#/customer-returns', 'customer-returns', 'returns', 'Customer Returns'),
      link('#/approvals', 'approvals', 'review', 'Approvals'),
      link('#/payments', 'payments', 'creditCard', 'Payments Due'),
      link('#/codes', 'codes', 'key', 'Customer Codes'),
      link('#/rep-customers', 'rep-customers', 'userCheck', 'Rep Customers'),
      link('#/team', 'team', 'users', 'Team Accounts'),
      link('#/visits', 'visits', 'mapPin', 'Shop Visits'),
      link('#/visibility', 'visibility', 'eye', 'Visibility'),
      link('#/expiry', 'expiry', 'expiry', 'Expiry & Discounts'),
      link('#/returns', 'returns', 'returns', 'Returns', 'returnsBadge'),
      link('#/products', 'products', 'package', 'Products'),
      link('#/sample-odoo', 'sample-odoo', 'database', 'Sample Odoo'),
      link('#/health', 'health', 'activity', 'Sync Health'),
      link('#/workspace/data-quality', 'workspace-data-quality', 'shieldCheck', 'Data Quality')),
    h('div', { class: 'wh-side-card' },
      h('span', { class: 'wh-side-card-icon' }, icon('trendingUp')),
      h('b', null, 'Grow Together'),
      h('p', null, 'Better sales. Stronger teams. Bigger results.')));
}

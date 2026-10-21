import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const readPublic = (name) => fs.readFileSync(new URL(`../src/public/${name}`, import.meta.url), 'utf8');

test('Sales Manager navigation targets have corresponding rendered views', () => {
  const html = readPublic('sales.html');
  const js = readPublic('js/sales.js');
  for (const route of ['dashboard', 'products', 'requests', 'customers', 'imports', 'settings']) {
    assert.match(html, new RegExp(`href="#${route}" data-route="${route}"`), `${route} navigation link exists`);
    assert.match(js, new RegExp(`key === '${route}'`), `${route} route is rendered`);
  }
  assert.match(html, /href="\/catalog"[^>]*target="_blank"/, 'catalogue opens from the navigation');
});

test('dashboard controls and request actions have working event handlers', () => {
  const html = readPublic('sales.html');
  const js = readPublic('js/sales.js');
  for (const id of ['smSearchForm', 'smNotifications', 'smMenuToggle', 'userBtn', 'salesLogout']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} control exists`);
  }
  assert.match(js, /getElementById\('smSearchForm'\)\.addEventListener\(/);
  assert.match(js, /getElementById\('smNotifications'\)\.addEventListener\(/);
  for (const handler of ['menuToggle', 'userBtn']) {
    assert.match(js, new RegExp(`${handler}\\.addEventListener\\(`), `${handler} responds to interaction`);
  }
  assert.match(js, /getElementById\('salesLogout'\)\.addEventListener\(/);
  assert.match(js, /data-view-request/);
  assert.match(js, /data-export-request/);
  assert.match(js, /data-route-to/);
  assert.match(js, /id="smDownload"/);
  assert.match(js, /id="smRange"/);
});

test('Sales Manager screen keeps request actions read-only', () => {
  const html = readPublic('sales.html');
  const js = readPublic('js/sales.js');
  assert.match(html, /Read-only access/);
  assert.match(js, /read-only view/);
  assert.doesNotMatch(js, /\/api\/sales\/requests\/[^`]*accept/);
});

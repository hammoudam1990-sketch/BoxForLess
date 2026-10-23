// Expiry rules (Warehouse: Expiry W1-W3). Sample data only: no database, no Odoo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ExpiryBand, ShelfLife, EntryIssue, ShelfAlertKind, ExpiryAction, ExpiryStatus, VisitOutcome,
  DEFAULT_EXPIRY_SETTINGS, withSettings, toDay, formatDay, daysLeft, categoryRules, classifyLot,
  isSellable, needsDecision, checkEntry, buildExpiryRow, sortExpiryRows, countByBand,
  validateDiscountPercent, valueAtRisk, valueByBand, shelfAlertDates, shelfAlertStatus, nextCheckDate, friendlyDate,
  checkMinimumShelfLife, deliveryBelowMinimum, findShelfLifeExceptions,
} from '../src/domain/expiry.js';

const TODAY = '2026-10-21';
/** The date `n` days after TODAY. */
const inDays = (n) => formatDay(toDay(TODAY) + n);

// ===========================================================================
// dates
// ===========================================================================
test('1. days left counts whole calendar days, and the expiry day itself is still a day', () => {
  assert.equal(daysLeft('2026-10-21', TODAY), 0);
  assert.equal(daysLeft('2026-10-22', TODAY), 1);
  assert.equal(daysLeft('2026-10-20', TODAY), -1);
  assert.equal(daysLeft('2027-01-19', TODAY), 90);             // across a month and a year
  assert.equal(daysLeft('2028-03-01', '2028-02-28'), 2);       // a leap day sits between
});

test('2. Odoo datetimes, ISO strings and Date objects are all read as their calendar day', () => {
  assert.equal(daysLeft('2026-12-01 23:59:59', TODAY), daysLeft('2026-12-01', TODAY));
  assert.equal(daysLeft('2026-12-01T08:00:00.000Z', TODAY), daysLeft('2026-12-01', TODAY));
  assert.equal(daysLeft(new Date(Date.UTC(2026, 11, 1, 23, 0, 0)), TODAY), daysLeft('2026-12-01', TODAY));
  assert.equal(formatDay(toDay('2026-02-28') + 1), '2026-03-01');
});

test('3. an unreadable or impossible date is null, never a guess', () => {
  for (const bad of [null, undefined, '', 'soon', '2026-13-01', '2026-02-30', '21/10/2026', NaN, new Date('x')]) {
    assert.equal(toDay(bad), null, String(bad));
  }
  assert.equal(daysLeft('nonsense', TODAY), null);
});

// ===========================================================================
// W1 — bands
// ===========================================================================
test('4. long-shelf-life bands: 90 / 60 / 30 days, expired once past', () => {
  const band = (n) => classifyLot({ expiryDate: inDays(n), today: TODAY }).band;
  assert.equal(band(91), ExpiryBand.OK);
  assert.equal(band(90), ExpiryBand.EARLY);
  assert.equal(band(61), ExpiryBand.EARLY);
  assert.equal(band(60), ExpiryBand.WARNING);
  assert.equal(band(31), ExpiryBand.WARNING);
  assert.equal(band(30), ExpiryBand.CRITICAL);
  assert.equal(band(0), ExpiryBand.CRITICAL, 'the expiry day itself is still sellable');
  assert.equal(band(-1), ExpiryBand.EXPIRED);
});

test('5. short-shelf-life bands are tighter: 60 / 30 / 14 days', () => {
  const settings = withSettings({ categories: { 'FOOD / DAIRY': { type: ShelfLife.SHORT } } });
  const band = (n) => classifyLot({ expiryDate: inDays(n), today: TODAY, categoryPath: 'FOOD / DAIRY / MILK', settings }).band;
  assert.equal(band(61), ExpiryBand.OK);
  assert.equal(band(60), ExpiryBand.EARLY);
  assert.equal(band(31), ExpiryBand.EARLY);
  assert.equal(band(30), ExpiryBand.WARNING);
  assert.equal(band(15), ExpiryBand.WARNING);
  assert.equal(band(14), ExpiryBand.CRITICAL);
  assert.equal(band(-1), ExpiryBand.EXPIRED);
});

test('6. the same lot lands in different bands in different categories', () => {
  const settings = withSettings({ categories: { 'FOOD / DAIRY': { type: ShelfLife.SHORT } } });
  const at = (categoryPath) => classifyLot({ expiryDate: inDays(45), today: TODAY, categoryPath, settings }).band;
  assert.equal(at('FOOD / DRY GOODS'), ExpiryBand.WARNING);     // long: 45 is inside 60
  assert.equal(at('FOOD / DAIRY'), ExpiryBand.EARLY);           // short: 45 is only inside 60
});

test('7. changing a category\'s bands changes the report (acceptance check)', () => {
  const lot = { expiryDate: inDays(45), today: TODAY, categoryPath: 'DRINKS / JUICE' };
  assert.equal(classifyLot(lot).band, ExpiryBand.WARNING);
  const tighter = withSettings({ categories: { 'DRINKS / JUICE': { bands: { early: 40, warning: 25, critical: 10 } } } });
  assert.equal(classifyLot({ ...lot, settings: tighter }).band, ExpiryBand.OK);
});

test('8. categories match on whole path segments, and the most specific entry wins per field', () => {
  const settings = withSettings({
    categories: {
      'FOOD / DAIRY': { type: ShelfLife.SHORT, usualShelfLifeDays: 120 },
      'FOOD / DAIRY / CHEESE': { usualShelfLifeDays: 300 },
    },
  });
  assert.equal(categoryRules('FOOD / DAIRY / MILK', settings).type, ShelfLife.SHORT);
  assert.equal(categoryRules('FOOD / DAIRYFREE / OAT', settings).type, ShelfLife.LONG, 'DAIRYFREE is not under DAIRY');
  assert.equal(categoryRules('food / dairy / milk', settings).type, ShelfLife.SHORT, 'case does not matter');
  const cheese = categoryRules('FOOD / DAIRY / CHEESE / HARD', settings);
  assert.equal(cheese.type, ShelfLife.SHORT, 'type inherited from the parent');
  assert.equal(cheese.usualShelfLifeDays, 300, 'usual shelf life overridden by the child');
  assert.equal(categoryRules('', settings).type, ShelfLife.LONG);
});

test('9. nonsense settings are refused', () => {
  assert.throws(() => withSettings({ bands: { LONG: { early: 30, warning: 60, critical: 90 } } }), RangeError);
  assert.throws(() => withSettings({ bands: { LONG: { early: 90, warning: 60, critical: 0 } } }), RangeError);
  assert.throws(() => withSettings({ bands: { LONG: { early: 90.5, warning: 60, critical: 30 } } }), RangeError);
  assert.throws(() => withSettings({ alerts: { LONG: { first: 30, final: 60 } } }), RangeError);
  assert.throws(() => withSettings({ categories: { X: { type: 'MEDIUM' } } }), RangeError);
  assert.throws(() => withSettings({ categories: { X: { bands: { early: 5, warning: 5, critical: 1 } } } }), RangeError);
  assert.doesNotThrow(() => withSettings());
});

test('10. a lot with no expiry date is NO_DATE, not expired and not an error', () => {
  assert.equal(classifyLot({ expiryDate: null, today: TODAY }).band, ExpiryBand.NO_DATE);
  assert.equal(classifyLot({ expiryDate: null, today: TODAY }).daysLeft, null);
  assert.equal(needsDecision(ExpiryBand.NO_DATE), false);
  assert.equal(needsDecision(ExpiryBand.OK), false);
  for (const b of [ExpiryBand.EARLY, ExpiryBand.WARNING, ExpiryBand.CRITICAL]) assert.equal(needsDecision(b), true);
  assert.equal(needsDecision(ExpiryBand.EXPIRED), false, 'an expired lot is already out of sale, not a decision about selling it');
});

test('11. expired lots are never sellable; a bad date is not trusted; no date means not perishable', () => {
  assert.equal(isSellable(inDays(-1), TODAY), false);
  assert.equal(isSellable(inDays(0), TODAY), true);
  assert.equal(isSellable(inDays(400), TODAY), true);
  assert.equal(isSellable(null, TODAY), true);
  assert.equal(isSellable('', TODAY), true);
  assert.equal(isSellable('garbage', TODAY), false);
});

// ===========================================================================
// W1 — hand-entered dates
// ===========================================================================
test('12. a mistyped date in the past on the day of receipt is caught; the same day is fine', () => {
  assert.deepEqual(checkEntry({ expiryDate: '2026-10-20', receivedDate: '2026-10-21' }), [EntryIssue.PAST_AT_RECEIPT]);
  assert.deepEqual(checkEntry({ expiryDate: '2026-10-21', receivedDate: '2026-10-21' }), []);
  assert.deepEqual(checkEntry({ expiryDate: '2026-12-01', receivedDate: '2026-10-21' }), []);
});

test('13. more than 5 years ahead is caught; exactly 5 years is not', () => {
  assert.deepEqual(checkEntry({ expiryDate: '2036-10-21', receivedDate: '2026-10-21' }), [EntryIssue.TOO_FAR_AHEAD]);
  assert.deepEqual(checkEntry({ expiryDate: '2031-10-21', receivedDate: '2026-10-21' }), []);
  assert.deepEqual(checkEntry({ expiryDate: '2031-10-22', receivedDate: '2026-10-21' }), [EntryIssue.TOO_FAR_AHEAD]);
  assert.deepEqual(checkEntry({ expiryDate: '2033-02-28', receivedDate: '2028-02-29' }), [], 'a leap-day receipt: 5 years on is 28 Feb');
});

test('14. a 3-month product received with 2 years to expiry is flagged against its usual shelf life', () => {
  const settings = withSettings({ categories: { 'FOOD / DAIRY': { type: ShelfLife.SHORT, usualShelfLifeDays: 90 } } });
  const check = (expiryDate) => checkEntry({ expiryDate, receivedDate: '2026-10-21', categoryPath: 'FOOD / DAIRY / YOGHURT', settings });
  assert.deepEqual(check('2028-10-21'), [EntryIssue.FAR_ABOVE_USUAL]);
  assert.deepEqual(check('2027-01-19'), [], '90 days is exactly the usual life');
  assert.deepEqual(check('2027-04-19'), [], '180 days is 2x: still fine');
  assert.deepEqual(check('2027-04-20'), [EntryIssue.FAR_ABOVE_USUAL], 'over 2x');
  assert.deepEqual(check('2026-10-25'), [EntryIssue.FAR_BELOW_USUAL], '4 days left on a 90-day product');
});

test('15. with no usual shelf life configured, that check stays silent rather than inventing one', () => {
  assert.deepEqual(checkEntry({ expiryDate: '2029-01-01', receivedDate: '2026-10-21', categoryPath: 'FOOD / DAIRY' }), []);
});

test('16. several problems are all reported; an unreadable date is not reported as a mistake', () => {
  const settings = withSettings({ categories: { X: { usualShelfLifeDays: 90 } } });
  assert.deepEqual(checkEntry({ expiryDate: '2040-01-01', receivedDate: '2026-10-21', categoryPath: 'X', settings }),
    [EntryIssue.TOO_FAR_AHEAD, EntryIssue.FAR_ABOVE_USUAL]);
  assert.deepEqual(checkEntry({ expiryDate: 'nonsense', receivedDate: '2026-10-21' }), []);
});

// ===========================================================================
// W1 — the list
// ===========================================================================
test('17. rows are sorted expired first, then fewest days left, no-date last', () => {
  const rows = [
    { lotName: 'later', expiryDate: inDays(200) },
    { lotName: 'nodate', expiryDate: null },
    { lotName: 'soon', expiryDate: inDays(10) },
    { lotName: 'expired', expiryDate: inDays(-5) },
    { lotName: 'mid', expiryDate: inDays(50) },
  ].map((l) => buildExpiryRow(l, TODAY));
  assert.deepEqual(sortExpiryRows(rows).map((r) => r.lotName), ['expired', 'soon', 'mid', 'later', 'nodate']);
  assert.equal(rows.find((r) => r.lotName === 'expired').sellable, false);
  assert.equal(rows.find((r) => r.lotName === 'soon').sellable, true);
});

test('18. a row carries its band and any typing-mistake issues; the bands are counted', () => {
  const rows = [
    buildExpiryRow({ lotName: 'a', expiryDate: inDays(20), receivedDate: inDays(-30) }, TODAY),
    buildExpiryRow({ lotName: 'b', expiryDate: inDays(-2), receivedDate: inDays(-40) }, TODAY),
    buildExpiryRow({ lotName: 'c', expiryDate: inDays(3000), receivedDate: inDays(-1) }, TODAY),
  ];
  assert.equal(rows[0].band, ExpiryBand.CRITICAL);
  assert.deepEqual(rows[2].issues, [EntryIssue.TOO_FAR_AHEAD]);
  const counts = countByBand(rows);
  assert.equal(counts.CRITICAL, 1);
  assert.equal(counts.EXPIRED, 1);
  assert.equal(counts.OK, 1);
  assert.equal(counts.NO_DATE, 0);
});

test('19. a clearance discount is a percentage strictly between 0 and 100', () => {
  assert.deepEqual(validateDiscountPercent(25), { ok: true, value: 25, error: null });
  assert.equal(validateDiscountPercent('12.345').value, 12.35);
  for (const bad of [0, 100, -5, 150, '', null, undefined, 'abc', NaN]) {
    assert.equal(validateDiscountPercent(bad).ok, false, String(bad));
  }
});

// ===========================================================================
// W2 — customer-shelf alerts
// ===========================================================================
test('20. a long-shelf-life lot alerts at 60 days and again at 30', () => {
  const dates = shelfAlertDates('2027-01-01', 'FOOD / DRY GOODS');
  assert.deepEqual(dates.map((d) => [d.kind, d.daysBefore, d.date]), [
    [ShelfAlertKind.FIRST, 60, '2026-11-02'],
    [ShelfAlertKind.FINAL, 30, '2026-12-02'],
  ]);
});

test('21. a short-shelf-life lot has one alert, at 30 days, and no final', () => {
  const settings = withSettings({ categories: { 'FOOD / DAIRY': { type: ShelfLife.SHORT } } });
  const dates = shelfAlertDates('2027-01-01', 'FOOD / DAIRY', settings);
  assert.deepEqual(dates.map((d) => [d.kind, d.daysBefore]), [[ShelfAlertKind.FIRST, 30]]);
});

test('22. which alert is due today, and when the lot has already expired', () => {
  const lot = { expiryDate: '2027-01-01', categoryPath: 'FOOD / DRY GOODS' };
  const at = (today) => shelfAlertStatus({ ...lot, today });
  assert.equal(at('2026-11-01').current, null, 'the day before the first alert');
  assert.equal(at('2026-11-02').current, ShelfAlertKind.FIRST);
  assert.equal(at('2026-12-01').current, ShelfAlertKind.FIRST);
  assert.equal(at('2026-12-02').current, ShelfAlertKind.FINAL);
  assert.equal(at('2027-01-01').expired, false);
  assert.equal(at('2027-01-02').expired, true);
  assert.deepEqual(at('2026-12-02').alerts.map((a) => a.due), [true, true]);
});

test('23. a shop that was not checked is due again in 7 days', () => {
  assert.equal(nextCheckDate('2026-10-21'), '2026-10-28');
  assert.equal(nextCheckDate('2026-12-28'), '2027-01-04');
  assert.equal(nextCheckDate('nonsense'), null);
  assert.equal(DEFAULT_EXPIRY_SETTINGS.notCheckedRepeatDays, 7);
});

test('24. the outcome and action vocabularies are the ones in the specification', () => {
  assert.deepEqual(Object.keys(VisitOutcome).sort(), ['DISCOUNT_AGREED', 'NOT_CHECKED', 'RETURN_EXPECTED', 'SOLD_OUT']);
  assert.deepEqual(Object.keys(ExpiryAction).sort(), ['DONATE_OR_WRITE_OFF', 'MOVE_TO_CLEARANCE', 'PUSH_THROUGH_REPS', 'RETURN_TO_SUPPLIER']);
  assert.deepEqual(Object.keys(ExpiryStatus), ['OPEN', 'IN_PROGRESS', 'DONE']);
});

// ===========================================================================
// W3 — minimum shelf life
// ===========================================================================
const lot = (lotId, days, cartons) => ({ lotId, expiryDate: days === null ? null : inDays(days), cartons });

test('25. a customer with no minimum accepts any lot that is not expired', () => {
  const r = checkMinimumShelfLife({ minDays: null, quantityCtn: 10, lots: [lot('A', 5, 10)], today: TODAY });
  assert.equal(r.needsAcceptance, false);
  assert.equal(r.message, null);
  assert.equal(checkMinimumShelfLife({ minDays: 0, quantityCtn: 10, lots: [lot('A', 5, 10)], today: TODAY }).needsAcceptance, false);
});

test('26. enough stock that meets the 90-day minimum: no warning', () => {
  const r = checkMinimumShelfLife({ minDays: 90, quantityCtn: 30, lots: [lot('OLD', 40, 100), lot('NEW', 200, 50)], today: TODAY });
  assert.equal(r.needsAcceptance, false);
  assert.equal(r.qualifyingCartons, 30);
});

test('27. only shorter-dated stock: the line is warned, with the date of the best of it', () => {
  const r = checkMinimumShelfLife({ minDays: 90, quantityCtn: 20, lots: [lot('A', 30, 40), lot('B', 60, 40)], today: TODAY });
  assert.equal(r.needsAcceptance, true);
  assert.equal(r.shortCartons, 20);
  assert.equal(r.belowMinimumLot.lotId, 'B', 'the warehouse would load the best of the short-dated lots');
  assert.equal(r.message, `Available stock expires on ${friendlyDate(inDays(60))}, below your 90-day minimum`);
  assert.match(r.message, /^Available stock expires on \d{1,2} [A-Z][a-z]{2} \d{4}, below your 90-day minimum$/);
});

test('28. part of the order meets the minimum and part does not: only the rest needs acceptance', () => {
  const r = checkMinimumShelfLife({ minDays: 90, quantityCtn: 50, lots: [lot('GOOD', 200, 30), lot('SHORT', 45, 100)], today: TODAY });
  assert.equal(r.needsAcceptance, true);
  assert.equal(r.qualifyingCartons, 30);
  assert.equal(r.shortCartons, 20);
  assert.equal(r.unavailableCartons, 0);
});

test('29. expired lots never count, however many there are', () => {
  const r = checkMinimumShelfLife({ minDays: 90, quantityCtn: 10, lots: [lot('DEAD', -1, 500), lot('GOOD', 120, 4)], today: TODAY });
  assert.equal(r.qualifyingCartons, 4);
  assert.equal(r.needsAcceptance, false, 'the rest is simply not in stock; there is no shorter-dated lot to accept');
  assert.equal(r.unavailableCartons, 6);
});

test('30. when stock runs out the shortfall is reported as unavailable, not as a shelf-life problem', () => {
  const r = checkMinimumShelfLife({ minDays: 90, quantityCtn: 100, lots: [lot('GOOD', 120, 10), lot('SHORT', 20, 15)], today: TODAY });
  assert.equal(r.needsAcceptance, true);
  assert.equal(r.shortCartons, 15);
  assert.equal(r.unavailableCartons, 75);
});

test('31. a lot with no expiry date meets any minimum', () => {
  const r = checkMinimumShelfLife({ minDays: 365, quantityCtn: 5, lots: [lot('NODATE', null, 10)], today: TODAY });
  assert.equal(r.needsAcceptance, false);
});

test('32. a lot exactly at the minimum meets it; one day short does not', () => {
  assert.equal(checkMinimumShelfLife({ minDays: 90, quantityCtn: 1, lots: [lot('A', 90, 1)], today: TODAY }).needsAcceptance, false);
  assert.equal(checkMinimumShelfLife({ minDays: 90, quantityCtn: 1, lots: [lot('A', 89, 1)], today: TODAY }).needsAcceptance, true);
});

test('33. odd inputs do not crash or invent stock', () => {
  assert.equal(checkMinimumShelfLife({ minDays: 90, quantityCtn: 0, lots: [], today: TODAY }).needsAcceptance, false);
  assert.equal(checkMinimumShelfLife({ minDays: 90, quantityCtn: 5, lots: undefined, today: TODAY }).unavailableCartons, 5);
  assert.equal(checkMinimumShelfLife({ minDays: 'abc', quantityCtn: 5, lots: [lot('A', 3, 5)], today: TODAY }).needsAcceptance, false);
  assert.equal(checkMinimumShelfLife({ minDays: 90, quantityCtn: 5, lots: [lot('A', 200, -3)], today: TODAY }).qualifyingCartons, 0);
});

test('34. the daily exceptions list: below the minimum at delivery and no recorded acceptance', () => {
  const deliveries = [
    { id: 1, expiryDate: '2026-12-01', deliveredOn: '2026-10-21', minDays: 90, accepted: false },   // 41 days: exception
    { id: 2, expiryDate: '2026-12-01', deliveredOn: '2026-10-21', minDays: 90, accepted: true },    // accepted: fine
    { id: 3, expiryDate: '2027-06-01', deliveredOn: '2026-10-21', minDays: 90, accepted: false },   // plenty of life
    { id: 4, expiryDate: '2026-12-01', deliveredOn: '2026-10-21', minDays: null, accepted: false }, // no minimum
  ];
  assert.deepEqual(findShelfLifeExceptions(deliveries).map((d) => d.id), [1]);
  assert.equal(deliveryBelowMinimum(deliveries[0]).daysLeftAtDelivery, 41);
  assert.equal(deliveryBelowMinimum(deliveries[1]).below, true);
  assert.equal(deliveryBelowMinimum(deliveries[1]).exception, false);
});

test('35. dates read for people', () => {
  assert.equal(friendlyDate('2026-12-01'), '1 Dec 2026');
  assert.equal(friendlyDate('2027-01-09 10:00:00'), '9 Jan 2027');
  assert.equal(friendlyDate('nonsense'), '');
});

test('36. value at risk is cartons x selling price; an unknown price is unknown, not zero', () => {
  assert.equal(valueAtRisk(40, 12.5), 500);
  assert.equal(valueAtRisk('3', '19.99'), 59.97);
  assert.equal(valueAtRisk(0, 10), 0);
  for (const bad of [[5, null], [5, undefined], [5, ''], [5, 'abc'], [-1, 10], [5, -10], ['x', 10]]) {
    assert.equal(valueAtRisk(...bad), null, JSON.stringify(bad));
  }
});

test('37. value at risk is summed per band for the bands that need attention, and says how many lots had no price', () => {
  const lot = (name, days, cartons, price) => buildExpiryRow({ lotName: name, expiryDate: inDays(days), cartons, pricePerCarton: price }, TODAY);
  const rows = [
    lot('expired', -3, 10, 10),       // 100
    lot('critical', 10, 20, 5),       // 100
    lot('critical2', 20, 1, 2.5),     // 2.5
    lot('warning', 45, 4, 25),        // 100
    lot('early', 80, 2, 50),          // 100
    lot('fine', 300, 1000, 99),       // not at risk: ignored
    lot('unpriced', 15, 7, null),     // at risk but unvalued
  ];
  const v = valueByBand(rows);
  assert.deepEqual(v.byBand, { EXPIRED: 100, CRITICAL: 102.5, WARNING: 100, EARLY: 100 });
  assert.equal(v.total, 402.5);
  assert.equal(v.unpriced, 1);
  assert.equal(rows[4].valueAtRisk, 100, 'every row carries its own value');
});

test('38. the module reads no cost, valuation or purchase figure (project rule); selling price is allowed', async () => {
  const { readFileSync } = await import('node:fs');
  const code = readFileSync(new URL('../src/domain/expiry.js', import.meta.url), 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /standard_price|cost_price|\bcost\b|valuation|purchase|supplier_price/i);
});

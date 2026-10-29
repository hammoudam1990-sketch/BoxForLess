// The shared sales-target calculations (js/lib/targets.js): remaining, percentage, status.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatGhs, remainingTarget, achievementPct, hasTarget, overTargetBy, targetStatus,
  TARGET_STATUS_LABEL, TARGET_STATUS_TONE, monthLabel,
} from '../src/public/js/lib/targets.js';

test('formatGhs formats Ghanaian cedis with two decimals', () => {
  assert.equal(formatGhs(10000), 'GH₵ 10,000.00');
  assert.equal(formatGhs(6500.5), 'GH₵ 6,500.50');
  assert.equal(formatGhs(0), 'GH₵ 0.00');
});

test('formatGhs shows a dash for missing values, never a zero', () => {
  assert.equal(formatGhs(null), '—');
  assert.equal(formatGhs(undefined), '—');
  assert.equal(formatGhs(''), '—');
  assert.equal(formatGhs('abc'), '—');
});

test('hasTarget accepts only a real positive number', () => {
  assert.equal(hasTarget(10000), true);
  assert.equal(hasTarget('500'), true);
  assert.equal(hasTarget(0), false);
  assert.equal(hasTarget(null), false);
  assert.equal(hasTarget(undefined), false);
  assert.equal(hasTarget('x'), false);
});

test('remainingTarget is target minus eligible sales, never below zero', () => {
  assert.equal(remainingTarget(10000, 6500), 3500);
  assert.equal(remainingTarget(10000, 10000), 0);
  assert.equal(remainingTarget(10000, 12000), 0);
  assert.equal(remainingTarget(10000, 0), 10000);
});

test('remainingTarget is null when no target is set', () => {
  assert.equal(remainingTarget(null, 6500), null);
  assert.equal(remainingTarget(0, 6500), null);
});

test('achievementPct is eligible over target as a percentage', () => {
  assert.equal(achievementPct(10000, 6500), 65);
  assert.equal(achievementPct(10000, 10000), 100);
  assert.equal(achievementPct(10000, 12500), 125);
  assert.equal(achievementPct(10000, 0), 0);
});

test('achievementPct never divides by zero', () => {
  assert.equal(achievementPct(0, 6500), 0);
  assert.equal(achievementPct(null, 6500), 0);
  assert.equal(achievementPct(undefined, undefined), 0);
});

test('overTargetBy is the amount above target, else zero', () => {
  assert.equal(overTargetBy(10000, 12500), 2500);
  assert.equal(overTargetBy(10000, 10000), 0);
  assert.equal(overTargetBy(10000, 6500), 0);
  assert.equal(overTargetBy(null, 6500), null);
});

test('targetStatus covers none, behind, on track, reached and exceeded', () => {
  assert.equal(targetStatus(null, 500), 'NONE');
  assert.equal(targetStatus(0, 500), 'NONE');
  assert.equal(targetStatus(10000, 0), 'BEHIND');
  assert.equal(targetStatus(10000, 6500), 'BEHIND');
  assert.equal(targetStatus(10000, 6667), 'ON_TRACK');
  assert.equal(targetStatus(10000, 9999), 'ON_TRACK');
  assert.equal(targetStatus(10000, 10000), 'REACHED');
  assert.equal(targetStatus(10000, 10001), 'EXCEEDED');
});

test('every status has a label and a badge tone', () => {
  for (const status of ['NONE', 'REACHED', 'EXCEEDED', 'ON_TRACK', 'BEHIND']) {
    assert.ok(TARGET_STATUS_LABEL[status], `label for ${status}`);
    assert.ok(status in TARGET_STATUS_TONE, `tone for ${status}`);
  }
});

test('monthLabel renders a month key as a month name', () => {
  assert.equal(monthLabel('2026-10'), 'October 2026');
  assert.equal(monthLabel('2026-01'), 'January 2026');
  assert.equal(monthLabel(''), '—');
});

// Unit tests for the pure pricing/history math. These import the real
// extension module directly — pricing.js has no chrome/storage dependency.
// Run with `npm test` (node --test).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lowsDescending,
  deepestTier,
  medianOfTotals,
  quantityVelocity,
  windowDelta,
  fmtWindow,
  trendWindows,
} from '../extension/lib/pricing.js';

const H = 3.6e6; // ms per hour, matching constants.MS.HOUR

test('lowsDescending sorts markers high -> low and normalizes shapes', () => {
  assert.deepEqual(lowsDescending({ lowPrices: [320, 390, 340] }), [390, 340, 320]);
  assert.deepEqual(lowsDescending({ lowPrice: 100 }), [100]);
  assert.deepEqual(lowsDescending({}), []);
});

test('deepestTier returns the deepest crossed marker (or -1)', () => {
  const lows = [390, 360, 340, 320];
  assert.equal(deepestTier(400, lows), -1); // above all markers
  assert.equal(deepestTier(390, lows), 0);  // exactly the shallowest
  assert.equal(deepestTier(350, lows), 1);  // crosses 390,360 but not 340
  assert.equal(deepestTier(310, lows), 3);  // crosses all
  assert.equal(deepestTier(100, []), -1);   // no markers
});

test('medianOfTotals matches the middle-of-sorted definition', () => {
  assert.equal(medianOfTotals([10, 30, 20]), 20);
  assert.equal(medianOfTotals([5, 1, 9, 3]), 5); // sorted [1,3,5,9], index floor(4/2)=2
  assert.equal(medianOfTotals([42]), 42);
});

test('quantityVelocity reports the fractional stock drop over the window', () => {
  const now = 1000 * H;
  const hist = [
    { t: now - 10 * H, mkt: 400, qty: 100 },
    { t: now - 1 * H, mkt: 390, qty: 70 },
  ];
  assert.ok(Math.abs(quantityVelocity(hist, 12, now) - 0.30) < 1e-9);
  assert.equal(quantityVelocity(hist, 12, now) > 0, true);
});

test('quantityVelocity is 0 when flat, rising, or sparse', () => {
  const now = 1000 * H;
  assert.equal(quantityVelocity([], 12, now), 0);
  assert.equal(quantityVelocity([{ t: now, qty: 50 }], 12, now), 0); // single sample
  const rising = [
    { t: now - 5 * H, qty: 50 },
    { t: now - 1 * H, qty: 80 },
  ];
  assert.equal(quantityVelocity(rising, 12, now), 0); // rose, not dropped
});

test('windowDelta computes percent change or null', () => {
  const now = 100 * H;
  const hist = [
    { t: now - 48 * H, mkt: 500 },
    { t: now - 1 * H, mkt: 400 },
  ];
  const wd = windowDelta(hist, 72, now);
  assert.ok(wd);
  assert.equal(wd.abs, -100);
  assert.ok(Math.abs(wd.pct - -0.2) < 1e-9);
  assert.equal(windowDelta([{ t: now, mkt: 1 }], 72, now), null); // too little history
});

test('fmtWindow renders direction and magnitude', () => {
  assert.equal(fmtWindow(3, null), '3d: collecting');
  assert.equal(fmtWindow(2, { abs: -10, pct: -0.05 }), '2d: down 5.0%');
  assert.equal(fmtWindow(5, { abs: 12, pct: 0.123 }), '5d: up 12.3%');
});

test('trendWindows prefers a per-product override, else global', () => {
  const global = { trendWindowsDays: [2, 3, 5] };
  assert.deepEqual(trendWindows({ trendWindowsDays: [7] }, global), [7]);
  assert.deepEqual(trendWindows({ trendWindowsDays: [] }, global), [2, 3, 5]);
  assert.deepEqual(trendWindows({}, global), [2, 3, 5]);
  assert.deepEqual(trendWindows(null, global), [2, 3, 5]);
});

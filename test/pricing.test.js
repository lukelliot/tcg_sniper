// Unit tests for the pure pricing/history math. These import the real
// extension module directly — pricing.js has no chrome/storage dependency.
// Run with `npm test` (node --test).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lowsDescending,
  deepestTier,
  highsAscending,
  highestTier,
  medianOfTotals,
  quantityVelocity,
  windowDelta,
  fmtWindow,
  trendWindows,
  sellerTrust,
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

test('highsAscending sorts markers low -> high and normalizes shapes', () => {
  assert.deepEqual(highsAscending({ highPrices: [450, 410, 500] }), [410, 450, 500]);
  assert.deepEqual(highsAscending({ highPrice: 410 }), [410]);
  assert.deepEqual(highsAscending({}), []);
});

test('highestTier returns the highest crossed spike marker (or -1)', () => {
  const highs = [410, 450, 500];
  assert.equal(highestTier(400, highs), -1); // below all markers
  assert.equal(highestTier(410, highs), 0);  // exactly the shallowest
  assert.equal(highestTier(460, highs), 1);  // crosses 410,450 but not 500
  assert.equal(highestTier(520, highs), 2);  // crosses all
  assert.equal(highestTier(999, []), -1);    // no markers
});

// Low-single-digit cards where the cents matter: markers and the tier math must
// be cent-accurate, not rounded to whole dollars. Listing totals reach the tier
// functions already rounded to 2 decimals (content.js: +(item+ship).toFixed(2)).
test('low/high ladders respect fractional (cent) markers', () => {
  const lows = lowsDescending({ lowPrices: [3.49, 2.99] }); // [3.49, 2.99]
  assert.deepEqual(lows, [3.49, 2.99]);
  assert.equal(deepestTier(3.50, lows), -1); // a cent above the shallowest — no hit
  assert.equal(deepestTier(3.49, lows), 0);  // exactly the shallowest marker
  assert.equal(deepestTier(3.00, lows), 0);  // between markers
  assert.equal(deepestTier(2.99, lows), 1);  // crosses the deeper marker

  const highs = highsAscending({ highPrices: [5.25] }); // [5.25]
  assert.equal(highestTier(5.24, highs), -1); // a cent below — no spike
  assert.equal(highestTier(5.25, highs), 0);  // exactly the spike marker
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

test('sellerTrust shows ✅ for badged sellers, then rating and sales (or empty)', () => {
  assert.equal(
    sellerTrust({ rating: 100, sales: 1820, badges: ['Gold Star Seller'] }),
    ' ✅ 100% (1820 sales)',
  );
  assert.equal(
    sellerTrust({ rating: 100, sales: 4, badges: [] }),
    ' 100% (4 sales)', // no badge — no checkmark
  );
  assert.equal(
    sellerTrust({ rating: 98.5, sales: 412, badges: ['Direct'] }),
    ' ✅ 98.5% (412 sales)',
  );
  assert.equal(
    sellerTrust({ rating: null, sales: 1820, badges: [] }),
    ' (1820 sales)', // partial render: rating not yet parsed
  );
  assert.equal(sellerTrust({ rating: null, sales: null, badges: [] }), '');
  assert.equal(sellerTrust(null), '');
});

test('trendWindows prefers a per-product override, else global', () => {
  const global = { trendWindowsDays: [2, 3, 5] };
  assert.deepEqual(trendWindows({ trendWindowsDays: [7] }, global), [7]);
  assert.deepEqual(trendWindows({ trendWindowsDays: [] }, global), [2, 3, 5]);
  assert.deepEqual(trendWindows({}, global), [2, 3, 5]);
  assert.deepEqual(trendWindows(null, global), [2, 3, 5]);
});

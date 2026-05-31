// pricing.js — pure price/history math. No chrome, no storage, no side effects,
// so it's directly unit-testable (see test/pricing.test.js). The stateful
// evaluation in evaluate.js and trend.js delegates its arithmetic here.

import { MS } from './constants.js';

// A product's low markers, high -> low (index 0 is the shallowest marker).
// Accepts either lowPrices: number[] or a single lowPrice.
export function lowsDescending(cfg) {
  const lows = Array.isArray(cfg.lowPrices)
    ? [...cfg.lowPrices]
    : (cfg.lowPrice != null ? [cfg.lowPrice] : []);
  return lows.sort((a, b) => b - a);
}

// Index of the deepest low marker the price has crossed (price <= marker), or
// -1 if none. `lowsDesc` must be sorted high -> low.
export function deepestTier(price, lowsDesc) {
  let tier = -1;
  for (let i = 0; i < lowsDesc.length; i++) {
    if (price <= lowsDesc[i]) {
      tier = i;
    }
  }
  return tier;
}

// Median of listing totals — the same middle-of-sorted definition v1.0 used.
export function medianOfTotals(totals) {
  const sorted = [...totals].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// Fractional drop in quantity over the last `hours` (e.g. 0.3 = stock fell 30%).
// 0 when flat/rising or with too little history. `now` is injectable for tests.
export function quantityVelocity(hist, hours, now = Date.now()) {
  if (!hist || hist.length < 2) {
    return 0;
  }
  const cutoff = now - hours * MS.HOUR;
  const old = hist.find((h) => h.t >= cutoff && h.qty != null);
  const cur = [...hist].reverse().find((h) => h.qty != null);
  if (!old || !cur || old === cur || !old.qty) {
    return 0;
  }
  const drop = (old.qty - cur.qty) / old.qty;
  return drop > 0 ? drop : 0;
}

// Change in Market Price over the last `hours`, or null if not enough history.
// `now` is injectable for tests.
export function windowDelta(hist, hours, now = Date.now()) {
  if (hist.length < 2) {
    return null;
  }

  const cutoff = now - hours * MS.HOUR;
  const old = hist.find((h) => h.t >= cutoff && h.mkt != null);
  const cur = [...hist].reverse().find((h) => h.mkt != null);

  if (!old || !cur || old === cur || old.mkt == null) {
    return null;
  }

  const abs = +(cur.mkt - old.mkt).toFixed(2);
  return {
    abs,
    pct: abs / old.mkt,
    hours: (cur.t - old.t) / MS.HOUR,
  };
}

export function fmtWindow(days, wd) {
  const label = `${days}d`;
  if (!wd) {
    return `${label}: collecting`;
  }
  const dir = wd.abs <= 0 ? 'down' : 'up';
  return `${label}: ${dir} ${Math.abs(wd.pct * 100).toFixed(1)}%`;
}

// Trend windows to report for a product: its own override if set, else global.
export function trendWindows(cfg, globalConfig) {
  return (cfg && Array.isArray(cfg.trendWindowsDays) && cfg.trendWindowsDays.length)
    ? cfg.trendWindowsDays
    : globalConfig.trendWindowsDays;
}

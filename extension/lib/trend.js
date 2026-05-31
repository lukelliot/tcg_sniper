// trend.js — Market Price history and the trend signals derived from it:
// the rolling sample store, the context windows reported in alerts, and the
// anchored "still falling" / "decline stalled" detector.

import { get, set, getConfig } from './storage.js';
import { KEY, MS, HISTORY } from './constants.js';
import { notify } from './notify.js';
import { windowDelta, fmtWindow, trendWindows } from './pricing.js';

// Append one Market Price sample (downsampled), prune to the longest window, return history.
// `cfg` is the per-product config, so a product can override trendWindowsDays.
export async function recordHistory(id, mkt, qty, cfg) {
  const now = Date.now();
  const hist = await get(KEY.hist(id), []);
  const lastT = hist.length ? hist[hist.length - 1].t : 0;

  if (now - lastT >= getConfig().historyMinIntervalMinutes * MS.MIN) {
    hist.push({ t: now, mkt, qty });
  }

  const windows = trendWindows(cfg, getConfig());
  const maxDays = windows.length ? Math.max(...windows) : 5;
  const cutoff = now - maxDays * HISTORY.RETENTION_FACTOR * MS.DAY;
  const pruned = hist.filter((h) => h.t >= cutoff).slice(-HISTORY.MAX_SAMPLES);
  await set({ [KEY.hist(id)]: pruned });
  return pruned;
}

// Returns the context as an array of pieces. Callers join with '\n' (one metric
// per line, for notifications) or ' | ' (single-line heartbeat log). `cfg` is
// the per-product config (for the target markers shown alongside the price).
export function buildContext(market, hist, cfg) {
  const lines = [];
  if (market.marketPrice != null) {
    const age = market.stale && market.t ? ` (${Math.round((Date.now() - market.t) / MS.MIN)}m old)` : '';
    const tgt = [];
    if (cfg) {
      const lows = (Array.isArray(cfg.lowPrices) ? cfg.lowPrices : (cfg.lowPrice != null ? [cfg.lowPrice] : [])).slice().sort((a, b) => b - a);
      const lowStr = lows.length ? lows.join('/') : null;
      const highStr = cfg.highPrice != null ? String(cfg.highPrice) : null;

      if (lowStr && highStr) {
        tgt.push(`${lowStr} <=> ${highStr}`);
      } else if (lowStr) {
        tgt.push(lowStr);
      } else if (highStr) {
        tgt.push(highStr);
      }
    }
    const tgtStr = tgt.length ? ` | ${tgt.join(' | ')}` : '';
    lines.push(`Market $${market.marketPrice.toFixed(2)}${age}${tgtStr}`);
  }
  if (market.quantity != null || market.sellers != null) {
    const q = market.quantity != null ? `Qty ${market.quantity}` : null;
    const s = market.sellers != null ? `Sellers ${market.sellers}` : null;
    lines.push([q, s].filter(Boolean).join(' | '));
  }
  for (const d of trendWindows(cfg, getConfig())) {
    lines.push(fmtWindow(d, windowDelta(hist, d * 24)));
  }
  return lines;
}

// Anchored Market Price trend: "still falling" on each leg down, "decline
// stalled" once it holds flat after a decline.
export async function checkTrend(id, cfg, mkt, ctx, url) {
  if (mkt == null) {
    return;
  }

  const c = getConfig();
  const anchor = await get(KEY.anchor(id), null);
  if (!anchor) {
    await set({ [KEY.anchor(id)]: { price: mkt, t: Date.now() } });
    return;
  }

  const dropPct = (anchor.price - mkt) / anchor.price;

  if (dropPct >= c.trendDropPct) {
    const hrs = (Date.now() - anchor.t) / MS.HOUR;
    notify(`${cfg.name}: still falling`, `Market down ${(dropPct * 100).toFixed(1)}% over ${hrs.toFixed(1)}h, now $${mkt.toFixed(2)} — likely still finding a floor.${ctx}`, url);
    await set({ [KEY.anchor(id)]: { price: mkt, t: Date.now() } });
    await set({ [KEY.declining(id)]: true, [KEY.lastDrop(id)]: Date.now() });
    return;
  }

  if (mkt >= anchor.price * (1 + c.trendRiseReset)) {
    await set({ [KEY.anchor(id)]: { price: mkt, t: Date.now() } });
    await set({ [KEY.declining(id)]: false });
    return;
  }

  if (await get(KEY.declining(id), false)) {
    const flatHrs = (Date.now() - (await get(KEY.lastDrop(id), Date.now()))) / MS.HOUR;
    if (flatHrs >= c.stallHours) {
      notify(`${cfg.name}: decline stalled`, `Market price has held near $${mkt.toFixed(2)} for ${flatHrs.toFixed(0)}h after falling — may have found its floor. Possible buy window.${ctx}`, url);
      await set({ [KEY.declining(id)]: false });
    }
  }
}

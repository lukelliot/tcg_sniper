// evaluate.js — process one scrape result. evaluate() is a thin pipeline; each
// step below does exactly one thing (adaptive period, carry-forward, floor,
// steal, threshold ladder, daily snapshot) so the flow reads top-to-bottom.

import { get, set, getConfig, getProducts, applyOverrides } from './storage.js';
import { KEY, STATE, REGEX, MS } from './constants.js';
import { notify } from './notify.js';
import { recordHistory, buildContext, checkTrend } from './trend.js';
import { checkScrapeHealth } from './health.js';
import { lowsDescending, deepestTier, highsAscending, highestTier, medianOfTotals, quantityVelocity } from './pricing.js';
import { ensureAlarm } from './scheduler.js';
import { log, warn } from './log.js';

export async function evaluate({ url, listings, market, diag }) {
  await applyOverrides();

  if (await get(KEY.PAUSED, false)) {
    return;
  }

  await clearBlockBackoff();

  const m = url.match(REGEX.PRODUCT_ID);
  const id = m ? m[1] : null;
  const cfg = id ? getProducts()[id] : null;
  if (!cfg) {
    return; // not (or no longer) a watched product
  }

  if (await get(KEY.productPaused(id), false)) {
    return; // this product is individually paused — no processing or alerts
  }

  await set({ [KEY.url(id)]: url }); // remember where to reopen if the tab closes

  // Detect selector breakage (page rendered but our fields didn't parse) before
  // the empty-render early return, so a break that yields zero listings is caught.
  await checkScrapeHealth(id, cfg, diag, url);

  const mult = await applyAdaptivePeriod(id, listings);
  if (!listings.length) {
    warn(`${cfg.name}: empty render — period x${mult.toFixed(2)} (possible challenge).`);
    return;
  }

  // Records the REAL scraped values only.
  const hist = await recordHistory(id, market.marketPrice, market.quantity, cfg);
  const mkt = await carryForwardMarket(id, market);

  const ctxLines = buildContext(mkt, hist, cfg);
  const ctx = ctxLines.length ? '\n' + ctxLines.join('\n') : '';

  // "still falling" / "decline stalled" trend alerts (real price; guards null).
  await checkTrend(id, cfg, market.marketPrice, ctx, url);

  const pool = await checkFloor(id, cfg, listings, ctx, url);
  if (!pool) {
    return; // everything is below the junk floor
  }

  const lowest = pool.reduce((a, b) => (b.total < a.total ? b : a));
  const price = lowest.total;

  const stealFired = await checkSteal(id, cfg, pool, lowest, price, hist, ctx, url);
  await checkThresholdLadder(id, cfg, lowest, price, stealFired, ctx, url);

  const lead = `${cfg.name}: $${price.toFixed(2)} from ${lowest.seller}`;
  log([lead, ...ctxLines].join(' | '));

  await maybeDailySnapshot(id, cfg, price, lowest, ctxLines, url);
}

// Receiving a scrape means the product page loaded (not /uhoh) — clear any block backoff.
async function clearBlockBackoff() {
  if (await get(KEY.FLAGGED_BACKOFF, 0)) {
    await set({ [KEY.FLAGGED_BACKOFF]: 0, [KEY.FLAGGED_SINCE]: null });
    log('recovered from block — resuming normal cadence.');
  }
}

// Cap the multiplier so basePeriodMin x mult never exceeds maxPeriodMin. Returns
// the multiplier in effect after this tick (for the empty-render log).
async function applyAdaptivePeriod(id, listings) {
  const c = getConfig();
  const maxMult = Math.max(1, c.maxPeriodMin / c.basePeriodMin);
  let empties = await get(KEY.empties(id), 0);
  let mult = await get(KEY.mult(id), 1);
  let clean = await get(KEY.clean(id), 0);

  if (!listings.length) {
    empties++;
    clean = 0;
    if (empties >= c.backoffAfterEmpties) {
      mult = Math.min(mult * c.backoffGrowth, maxMult);
    }
  } else {
    empties = 0;
    clean++;
    if (clean >= c.relaxAfterClean) {
      mult = Math.max(1, mult * c.relaxFactor);
      clean = 0;
    }
  }

  await set({
    [KEY.empties(id)]: empties,
    [KEY.mult(id)]: mult,
    [KEY.clean(id)]: clean,
  });
  ensureAlarm(c.basePeriodMin * mult);
  return mult;
}

// Carry forward the last good reading PER FIELD, so a late-rendering panel
// (backgrounded reload) or a not-yet-populated quantity doesn't blank the line
// or show 0. History elsewhere still uses the REAL values. Returns the display
// market object.
async function carryForwardMarket(id, market) {
  const lastM = await get(KEY.lastMarket(id), null);
  const mkt = { ...market };
  if (lastM) {
    if (mkt.marketPrice == null) {
      mkt.marketPrice = lastM.marketPrice;
      mkt.t = lastM.t;
      mkt.stale = true; // price itself is carried — tag it with an age
    }
    if (mkt.quantity == null) {
      mkt.quantity = lastM.quantity;
    }
    if (mkt.sellers == null) {
      mkt.sellers = lastM.sellers;
    }
    if (mkt.listedMedian == null) {
      mkt.listedMedian = lastM.listedMedian;
    }
  }
  await set({
    [KEY.lastMarket(id)]: {
      marketPrice: market.marketPrice != null ? market.marketPrice : (lastM ? lastM.marketPrice : null),
      quantity: market.quantity != null ? market.quantity : (lastM ? lastM.quantity : null),
      sellers: market.sellers != null ? market.sellers : (lastM ? lastM.sellers : null),
      listedMedian: market.listedMedian != null ? market.listedMedian : (lastM ? lastM.listedMedian : null),
      t: market.marketPrice != null ? Date.now() : (lastM ? lastM.t : Date.now()),
    },
  });
  return mkt;
}

// Drop junk listings below the floor. Returns the buyable pool, or null (and
// alerts once) if EVERYTHING is below the floor — sold out or a real drop.
async function checkFloor(id, cfg, listings, ctx, url) {
  const pool = listings.filter((L) => L.total >= cfg.floorPrice);
  if (pool.length) {
    // Back above the floor — clear the below-floor latch so a later sell-off re-alerts.
    if (await get(KEY.state(id), STATE.NORMAL) === STATE.BELOW_FLOOR) {
      await set({ [KEY.state(id)]: STATE.NORMAL });
    }
    return pool;
  }
  if (await get(KEY.state(id), STATE.NORMAL) !== STATE.BELOW_FLOOR) {
    notify(`${cfg.name}: market below $${cfg.floorPrice} floor`, `All listings under your junk floor — sold out or a real drop. Look manually.${ctx}`, url);
  }
  await set({ [KEY.state(id)]: STATE.BELOW_FLOOR });
  return null;
}

// Lowest listing far enough under the listing median to look like a steal.
// Velocity-aware: when stock is draining fast the steal factor is loosened so a
// disappearing deal still trips. Returns whether the price is in steal range
// (which suppresses the DROP alert).
async function checkSteal(id, cfg, pool, lowest, price, hist, ctx, url) {
  const c = getConfig();
  if (pool.length < c.stealMinListings) {
    return false;
  }

  const median = medianOfTotals(pool.map((l) => l.total));

  const vel = quantityVelocity(hist, c.stealVelocityWindowHours);
  const sellingFast = vel >= c.stealVelocityThreshold;
  const factor = sellingFast ? Math.min(0.95, c.stealFactor + c.stealVelocityBoost) : c.stealFactor;

  if (price <= median * factor) {
    if (await get(KEY.steal(id), 0) !== price) {
      const gapPct = ((1 - price / median) * 100).toFixed(0);
      const velNote = sellingFast ? ` Selling fast: stock down ${(vel * 100).toFixed(0)}% in ${c.stealVelocityWindowHours}h.` : '';
      notify(`${cfg.name}: POSSIBLE STEAL $${price.toFixed(2)}`, `${gapPct}% under the $${median.toFixed(2)} listing median, from ${lowest.seller}.${velNote}${ctx}`, url);
      await set({ [KEY.steal(id)]: price });
    }
    return true;
  }

  await set({ [KEY.steal(id)]: 0 });
  return false;
}

// Thresholds: two symmetric LADDERS — low markers (alert as the price steps
// DOWN through each new, deeper marker) and high markers (alert as it steps UP
// through each new, higher spike). Multiple markers on each side hedge against
// setting one target wrong and missing the move.
async function checkThresholdLadder(id, cfg, lowest, price, stealFired, ctx, url) {
  const c = getConfig();
  const lows = lowsDescending(cfg); // high -> low; index 0 is the shallowest marker
  const highs = highsAscending(cfg); // low -> high; index 0 is the shallowest marker
  const lowTier = deepestTier(price, lows); // deepest low marker crossed, or -1
  const highTier = highestTier(price, highs); // highest spike marker crossed, or -1

  const lastLowTier = await get(KEY.lowTier(id), -1);
  const lastHighTier = await get(KEY.highTier(id), -1);
  const lastAlertT = await get(KEY.lastAlertT(id), 0);
  let gapH = await get(KEY.reAlertGap(id), c.reAlertMinHours);

  const cooldownPassed = c.reAlertMaxHours > 0 && Date.now() - lastAlertT >= gapH * MS.HOUR;
  const levelChanged = (highTier !== lastHighTier) || (lowTier !== lastLowTier);
  let fired = false;

  if (highTier >= 0) {
    if (highTier > lastHighTier) {
      // stepped up to a NEW, higher spike marker
      notify(`${cfg.name}: SPIKE $${price.toFixed(2)} (marker ${highTier + 1}/${highs.length}, ≥$${highs[highTier].toFixed(2)})`, `$${price.toFixed(2)} from ${lowest.seller}.${ctx}`, url);
      fired = true;
    } else if (highTier === lastHighTier && cooldownPassed) {
      // still sitting at the highest marker — re-ping on the backoff
      notify(`${cfg.name}: still ≥$${highs[highTier].toFixed(2)} — $${price.toFixed(2)}`, `$${price.toFixed(2)} from ${lowest.seller}.${ctx}`, url);
      fired = true;
    }
  } else if (lowTier >= 0 && !stealFired) {
    if (lowTier > lastLowTier) {
      // stepped down to a NEW, deeper marker
      notify(`${cfg.name}: DROP $${price.toFixed(2)} (marker ${lowTier + 1}/${lows.length}, ≤$${lows[lowTier].toFixed(2)})`, `$${price.toFixed(2)} from ${lowest.seller}.${ctx}`, url);
      fired = true;
    } else if (lowTier === lastLowTier && cooldownPassed) {
      // still sitting at the deepest marker — re-ping on the backoff
      notify(`${cfg.name}: still ≤$${lows[lowTier].toFixed(2)} — $${price.toFixed(2)}`, `$${price.toFixed(2)} from ${lowest.seller}.${ctx}`, url);
      fired = true;
    }
  }

  if (fired) {
    await set({ [KEY.lastAlertT(id)]: Date.now() });
  }
  // reset the re-alert gap when the level changed (a new marker on either side);
  // grow it when re-pinging the same level; leave it otherwise.
  if (levelChanged) {
    gapH = c.reAlertMinHours;
  } else if (fired) {
    gapH = Math.min(gapH * 2, c.reAlertMaxHours);
  }
  await set({
    [KEY.reAlertGap(id)]: gapH,
    [KEY.lowTier(id)]: lowTier,
    [KEY.highTier(id)]: highTier,
  });
}

// Fire ONE summary notification per day, on the first scrape at/after the
// configured local hour — a "where things stand" digest to start the day.
async function maybeDailySnapshot(id, cfg, price, lowest, ctxLines, url) {
  const c = getConfig();
  if (c.dailySnapshotHour == null) {
    return;
  }
  const now = new Date();
  if (now.getHours() < c.dailySnapshotHour) {
    return;
  }
  const today = now.toLocaleDateString();
  if (await get(KEY.snapDay(id), null) === today) {
    return; // already sent today's
  }
  await set({ [KEY.snapDay(id)]: today });
  const lead = `Lowest $${price.toFixed(2)} from ${lowest.seller}`;
  notify(`${cfg.name}: daily snapshot`, [lead, ...ctxLines].join('\n'), url);
}

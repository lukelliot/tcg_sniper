// background.js — service worker. The DURABLE scheduler: a chrome.alarms alarm
// fires on its period regardless of page state, sleep, or network, so the watch
// recovers automatically from a failed load (next alarm just reloads again).
// On each alarm it reloads the watched product tab(s); the content script
// re-scrapes and messages back here, where we evaluate + notify.
//
// Controls from the SERVICE WORKER console (chrome://extensions -> this
// extension -> "service worker"). Config edits persist in storage (no reload):
//   setProduct('693209', { lowPrices: [390,360,340], highPrice: 410 })   change a product's markers
//   setProduct('693209', null)                                stop watching that product (and its timer)
//   setConfig({ basePeriodMin: 5, dailySnapshotHour: 8 })     change global settings
//   showConfig()                                              print effective config
//   resetConfig()                                             drop overrides, back to file defaults
//   pauseWatch() / resumeWatch() / statusWatch()              pause / resume / inspect

// FILE DEFAULTS. Runtime overrides (set from the console) are merged on top and
// win until resetConfig() — so after editing defaults here, run resetConfig() if
// an override is shadowing your change.
const DEFAULT_PRODUCTS = {
  "693209": {
    name: "Goblin Storm",
    lowPrices: [390, 360, 340, 320], // ladder: alerts as the price steps down through each
    highPrice: 410,
    floorPrice: 140,
  },
};

const DEFAULT_CONFIG = {
  // === POLL INTERVAL (minutes) — the main knob. ===
  // Effective interval = basePeriodMin x adaptive backoff multiplier.
  // Raise to poll less often. You CANNOT go below 1 (Chrome's alarm floor).
  basePeriodMin: 5,
  maxPeriodMin: 16,                 // backoff ceiling: basePeriodMin x mult never exceeds this

  backoffAfterEmpties: 3,           // consecutive empty renders before it counts as trouble
  backoffGrowth: 1.5,               // multiply the backoff multiplier by this each troubled cycle
  relaxAfterClean: 30,              // after this many clean cycles in a row...
  relaxFactor: 0.8,                 // ...multiply the multiplier by this (decays toward 1)

  // RE-ALERT: while still out of band, re-ping after a gap that DOUBLES each
  // time, clamped between min and max. e.g. 1 -> 2 -> 4 -> 5 -> 5h.
  // The gap resets to the minimum when the price leaves and re-enters the band.
  // Set reAlertMaxHours: 0 to disable repeats (alert only on the crossing).
  reAlertMinHours: 1,
  reAlertMaxHours: 5,

  // TREND on Market Price (smoothed). The anchor drives the "still falling" /
  // "decline stalled" alerts; the windows below are reported in context.
  trendDropPct: 0.05,               // ping each time Market Price falls this far from the anchor
  trendRiseReset: 0.05,             // rebaseline the anchor if it recovers this much
  stallHours: 24,                   // flat this long after declining => "possible floor" ping
  trendWindowsDays: [2, 3, 5],      // context windows reported in alerts/logs
  historyMinIntervalMinutes: 20,    // downsample stored history (we poll faster than this)

  stealFactor: 0.65,                // lowest listing <= median x this => steal alert
  stealMinListings: 4,              // need at least this many listings to form a median

  dailySnapshotHour: 8,             // local hour (0–23): once-a-day summary at start of day; null to disable

  ntfyTopic: "tcgplayer-sniper",    // your ntfy.sh topic (optional)
  useNtfy: true,
  useDesktop: true,
  reopenIfClosed: true,             // if a watched tab gets closed, reopen it (pinned, background)

  // When TCGplayer blocks us (redirects to /uhoh), slow down and recover by
  // REUSING the blocked tab. Backoff starts here and doubles per consecutive
  // block: 10 -> 20 -> 40 -> 80 -> 120 (cap). Resets to the start on recovery.
  flaggedBackoffMin: 10,
  flaggedMaxBackoffMin: 120,
};

// Effective config — defaults overlaid with stored overrides (rehydrated each tick).
let CONFIG = { ...DEFAULT_CONFIG };
let PRODUCTS = JSON.parse(JSON.stringify(DEFAULT_PRODUCTS));

const ALARM = "tcgpoll";

// Async wrappers around chrome.storage.local.
const get = (k, d) => new Promise((r) => chrome.storage.local.get([k], (o) => r(k in o ? o[k] : d)));
const set = (o) => new Promise((r) => chrome.storage.local.set(o, r));

// Local datetime for log lines (so overnight failures are timestamped).
const ts = () => new Date().toLocaleString();

// Merge stored overrides on top of the file defaults into the live CONFIG/PRODUCTS.
// A product override of null is a tombstone: it removes that product entirely.
async function applyOverrides() {
  const co = await get('configOverride', {});
  CONFIG = { ...DEFAULT_CONFIG, ...co };

  const po = await get('productsOverride', {});
  PRODUCTS = {};
  for (const id of Object.keys(DEFAULT_PRODUCTS)) {
    if (po[id] === null) {
      continue; // removed
    }
    PRODUCTS[id] = { ...DEFAULT_PRODUCTS[id], ...(po[id] || {}) };
  }
  for (const id of Object.keys(po)) {
    if (po[id] && !PRODUCTS[id]) {
      PRODUCTS[id] = { ...po[id] }; // a product added entirely via override
    }
  }
}

// ---------------------------------------------------------------------------
// Console controls (callable from the service-worker console)
// ---------------------------------------------------------------------------

globalThis.setConfig = async (patch) => {
  const ov = await get('configOverride', {});
  await set({ configOverride: { ...ov, ...patch } });
  await applyOverrides();
  ensureAlarm(CONFIG.basePeriodMin);
  console.log('[TCG ext] config override saved:', patch, '\nEffective CONFIG:', CONFIG);
};

// patch = object to merge, or null to stop watching this product (clears its
// timer if it was the last one; its open tab simply stops refreshing).
globalThis.setProduct = async (id, patch) => {
  const ov = await get('productsOverride', {});

  if (patch === null) {
    ov[id] = null;
    await set({ productsOverride: ov });
    await applyOverrides();
    if (Object.keys(PRODUCTS).length === 0) {
      await chrome.alarms.clear(ALARM);
      console.log(`[TCG ext] product ${id} removed — no products left, poll timer stopped. Any open tab will no longer refresh.`);
    } else {
      console.log(`[TCG ext] product ${id} removed — its tab will no longer refresh. Still watching:`, Object.keys(PRODUCTS));
    }
    return;
  }

  ov[id] = { ...(ov[id] || {}), ...patch };
  await set({ productsOverride: ov });
  await applyOverrides();
  ensureAlarm(CONFIG.basePeriodMin); // make sure the timer is running if it was stopped
  console.log(`[TCG ext] product ${id} override saved:`, patch, '\nEffective:', PRODUCTS[id]);
};

globalThis.showConfig = async () => {
  await applyOverrides();
  console.log('[TCG ext] effective CONFIG:', CONFIG, '\neffective PRODUCTS:', PRODUCTS);
};

globalThis.resetConfig = async () => {
  await set({ configOverride: {}, productsOverride: {} });
  await applyOverrides();
  ensureAlarm(CONFIG.basePeriodMin);
  console.log('[TCG ext] overrides cleared — back to file defaults.', CONFIG, PRODUCTS);
};

globalThis.pauseWatch = async () => {
  await set({ paused: true });
  console.log('[TCG ext] PAUSED — no reloads or alerts until resumeWatch().');
};

globalThis.resumeWatch = async () => {
  await set({ paused: false });
  await applyOverrides();
  ensureAlarm(CONFIG.basePeriodMin);
  console.log('[TCG ext] resumed.');
};

globalThis.statusWatch = async () => {
  await applyOverrides();
  const all = await new Promise((r) => chrome.storage.local.get(null, r));
  const alarm = await new Promise((r) => chrome.alarms.get(ALARM, r));
  console.log('[TCG ext] paused:', !!all.paused, '| alarm:', alarm, '| CONFIG:', CONFIG, '| PRODUCTS:', PRODUCTS, '| storage:', all);
};

// ---------------------------------------------------------------------------
// Lifecycle + scheduling
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  await applyOverrides();
  keepAwake();
  ensureAlarm(CONFIG.basePeriodMin);
});

chrome.runtime.onStartup.addListener(async () => {
  await applyOverrides();
  keepAwake();
  ensureAlarm(CONFIG.basePeriodMin);
});

function ensureAlarm(min) {
  chrome.alarms.create(ALARM, { periodInMinutes: Math.max(1, min) });
}

// Ask the OS not to IDLE-sleep the system (display/screensaver can still turn
// off). Does NOT override a manual sleep or a closed laptop lid. MV3 workers are
// short-lived, so we re-assert this on every alarm; placing the OS power request
// also resets the idle-sleep timer, so a ~1-min cadence keeps the machine up.
function keepAwake() {
  try {
    chrome.power.requestKeepAwake('system');
  } catch (e) {
    // power API unavailable — ignore.
  }
}

// On each tick, reload the WATCHED product tab(s). A failed load yields no scrape
// message; the next alarm retries — this is the auto-recovery a userscript lacks.
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== ALARM) {
    return;
  }

  await applyOverrides();

  if (await get('paused', false)) {
    console.log(`[TCG ext ${ts()}] paused — skipping tick (resumeWatch() to restart).`);
    return;
  }

  keepAwake(); // re-assert: the worker may have been torn down since last tick

  const allTcg = await chrome.tabs.query({ url: "https://www.tcgplayer.com/*" });
  const uhoh = allTcg.filter((t) => /tcgplayer\.com\/uhoh/.test(t.url || ''));
  const watched = allTcg.filter((t) => {
    const mm = (t.url || '').match(/\/product\/(\d+)/);
    return mm && PRODUCTS[mm[1]];
  });

  // ---- blocked: TCGplayer redirected us to /uhoh ----
  if (uhoh.length) {
    let fb = await get('flaggedBackoff', 0);
    fb = fb ? Math.min(fb * 2, CONFIG.flaggedMaxBackoffMin) : CONFIG.flaggedBackoffMin;
    const since = (await get('flaggedSince', null)) || Date.now();
    await set({ flaggedBackoff: fb, flaggedSince: since });
    ensureAlarm(fb); // slow down — hammering a block makes it worse

    // Recover by REUSING the blocked tab (navigate it back), never spawning new
    // ones; close any extra /uhoh tabs so they can't accumulate overnight.
    let recoverUrl = null;
    for (const id of Object.keys(PRODUCTS)) {
      const u = await get(`url_${id}`, null);
      if (u) {
        recoverUrl = u;
        break;
      }
    }

    for (const t of uhoh.slice(1)) {
      try {
        await chrome.tabs.remove(t.id);
      } catch (e) { /* tab already gone */ }
    }
    if (recoverUrl) {
      try {
        await chrome.tabs.update(uhoh[0].id, { url: recoverUrl });
      } catch (e) { /* tab already gone */ }
    }

    const downMin = ((Date.now() - since) / 60000).toFixed(0);
    console.warn(`[TCG ext ${ts()}] FLAGGED (/uhoh) — blocked ~${downMin}m so far. Backing off to ${fb}m and ${recoverUrl ? 'retrying the page now' : 'waiting (no saved product URL to retry)'}.`);
    return;
  }

  // ---- normal: reload only WATCHED product tabs ----
  if (watched.length) {
    // Reload at most one tab per product id — duplicate tabs (e.g. leftovers
    // from an earlier reopen) would otherwise each scrape and triple the logs.
    // Reloading also revives a tab Chrome discarded/froze during idle or sleep.
    const seen = new Set();
    for (const t of watched) {
      const pid = (t.url.match(/\/product\/(\d+)/) || [])[1];
      if (seen.has(pid)) {
        continue; // a duplicate tab for a product we already reloaded this tick
      }
      seen.add(pid);
      chrome.tabs.reload(t.id);
    }
    return;
  }

  if (!CONFIG.reopenIfClosed) {
    console.warn(`[TCG ext ${ts()}] no watched product tab open to poll.`);
    return;
  }

  // No open tab for a watched product — reopen any we've seen before, pinned +
  // in the background, so the watch self-heals.
  for (const id of Object.keys(PRODUCTS)) {
    const url = await get(`url_${id}`, null);
    if (url) {
      chrome.tabs.create({
        url,
        active: false,
        pinned: true,
      });
    }
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'scrape') {
    evaluate(msg).catch(console.error);
  }
});

// ---------------------------------------------------------------------------
// Notifications + trend history
// ---------------------------------------------------------------------------

function notify(title, message, url) {
  if (CONFIG.useDesktop) {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icon.png',
      title,
      message,
      priority: 2,
    });
  }

  if (CONFIG.useNtfy && CONFIG.ntfyTopic) {
    fetch('https://ntfy.sh/' + CONFIG.ntfyTopic, {
      method: 'POST',
      headers: {
        Title: title,
        Click: url || '',
        Tags: 'moneybag',
      },
      body: message,
    }).catch(() => {});
  }

  console.log(`[TCG ext ${ts()}]`, title, '—', message.replace(/\n/g, ' | '));
}

// Append one Market Price sample (downsampled), prune to the longest window, return history.
async function recordHistory(id, mkt, qty) {
  const now = Date.now();
  const hist = await get(`hist_${id}`, []);
  const lastT = hist.length ? hist[hist.length - 1].t : 0;

  if (now - lastT >= CONFIG.historyMinIntervalMinutes * 60000) {
    hist.push({ t: now, mkt, qty });
  }

  const maxDays = CONFIG.trendWindowsDays.length ? Math.max(...CONFIG.trendWindowsDays) : 5;
  const cutoff = now - maxDays * 1.5 * 86400000;
  const pruned = hist.filter((h) => h.t >= cutoff).slice(-2000);
  await set({ [`hist_${id}`]: pruned });
  return pruned;
}

// Change in Market Price over the last `hours`, or null if not enough history yet.
function windowDelta(hist, hours) {
  if (hist.length < 2) {
    return null;
  }

  const cutoff = Date.now() - hours * 3.6e6;
  const old = hist.find((h) => h.t >= cutoff && h.mkt != null);
  const cur = [...hist].reverse().find((h) => h.mkt != null);

  if (!old || !cur || old === cur || old.mkt == null) {
    return null;
  }

  const abs = +(cur.mkt - old.mkt).toFixed(2);
  return {
    abs,
    pct: abs / old.mkt,
    hours: (cur.t - old.t) / 3.6e6,
  };
}

function fmtWindow(days, wd) {
  const label = `${days}d`;
  if (!wd) {
    return `${label}: collecting`;
  }
  const dir = wd.abs <= 0 ? 'down' : 'up';
  return `${label}: ${dir} ${Math.abs(wd.pct * 100).toFixed(1)}%`;
}

// Returns the context as an array of pieces. Callers join with '\n' (one metric
// per line, for notifications) or ' | ' (single-line heartbeat log).
function buildContext(market, hist, cfg) {
  const lines = [];
  if (market.marketPrice != null) {
    const age = market.stale && market.t ? ` (${Math.round((Date.now() - market.t) / 60000)}m old)` : '';
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
  for (const d of CONFIG.trendWindowsDays) {
    lines.push(fmtWindow(d, windowDelta(hist, d * 24)));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Evaluate one scrape result
// ---------------------------------------------------------------------------

async function evaluate({ url, listings, market }) {
  await applyOverrides();

  if (await get('paused', false)) {
    return;
  }

  // Receiving a scrape means the product page loaded (not /uhoh) — clear any block backoff.
  if (await get('flaggedBackoff', 0)) {
    await set({ flaggedBackoff: 0, flaggedSince: null });
    console.log(`[TCG ext ${ts()}] recovered from block — resuming normal cadence.`);
  }

  const m = url.match(/\/product\/(\d+)/);
  const id = m ? m[1] : null;
  const cfg = id ? PRODUCTS[id] : null;
  if (!cfg) {
    return; // not (or no longer) a watched product
  }

  await set({ [`url_${id}`]: url }); // remember where to reopen if the tab closes

  // ---- adaptive period ----
  // Cap the multiplier so basePeriodMin x mult never exceeds maxPeriodMin.
  const maxMult = Math.max(1, CONFIG.maxPeriodMin / CONFIG.basePeriodMin);
  let empties = await get(`empties_${id}`, 0);
  let mult = await get(`mult_${id}`, 1);
  let clean = await get(`clean_${id}`, 0);

  if (!listings.length) {
    empties++;
    clean = 0;
    if (empties >= CONFIG.backoffAfterEmpties) {
      mult = Math.min(mult * CONFIG.backoffGrowth, maxMult);
    }
  } else {
    empties = 0;
    clean++;
    if (clean >= CONFIG.relaxAfterClean) {
      mult = Math.max(1, mult * CONFIG.relaxFactor);
      clean = 0;
    }
  }

  await set({
    [`empties_${id}`]: empties,
    [`mult_${id}`]: mult,
    [`clean_${id}`]: clean,
  });
  ensureAlarm(CONFIG.basePeriodMin * mult);

  if (!listings.length) {
    console.warn(`[TCG ext ${ts()}] ${cfg.name}: empty render — period x${mult.toFixed(2)} (possible challenge).`);
    return;
  }

  // ---- trend history (records the REAL scraped values only) ----
  const hist = await recordHistory(id, market.marketPrice, market.quantity);

  // ---- market for display: carry forward the last good reading PER FIELD, so a
  // late-rendering panel (backgrounded reload) or a not-yet-populated quantity
  // doesn't blank the line or show 0. History above still used the REAL values.
  const lastM = await get(`lastMarket_${id}`, null);
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
    [`lastMarket_${id}`]: {
      marketPrice: market.marketPrice != null ? market.marketPrice : (lastM ? lastM.marketPrice : null),
      quantity: market.quantity != null ? market.quantity : (lastM ? lastM.quantity : null),
      sellers: market.sellers != null ? market.sellers : (lastM ? lastM.sellers : null),
      listedMedian: market.listedMedian != null ? market.listedMedian : (lastM ? lastM.listedMedian : null),
      t: market.marketPrice != null ? Date.now() : (lastM ? lastM.t : Date.now()),
    },
  });

  const ctxLines = buildContext(mkt, hist, cfg);
  const ctx = ctxLines.length ? '\n' + ctxLines.join('\n') : '';

  // ---- "still falling" / "decline stalled" trend alerts (real price; guards null) ----
  await checkTrend(id, cfg, market.marketPrice, ctx, url);

  // ---- lowest real listing ----
  const pool = listings.filter((L) => L.total >= cfg.floorPrice);
  if (!pool.length) {
    if (await get(`state_${id}`, 'normal') !== 'belowfloor') {
      notify(`${cfg.name}: market below $${cfg.floorPrice} floor`, `All listings under your junk floor — sold out or a real drop. Look manually.${ctx}`, url);
    }
    await set({ [`state_${id}`]: 'belowfloor' });
    return;
  }

  const lowest = pool.reduce((a, b) => (b.total < a.total ? b : a));
  const price = lowest.total;

  // ---- steal ----
  let stealFired = false;
  if (pool.length >= CONFIG.stealMinListings) {
    const sorted = pool.map((l) => l.total).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (price <= median * CONFIG.stealFactor) {
      if (await get(`steal_${id}`, 0) !== price) {
        const gapPct = ((1 - price / median) * 100).toFixed(0);
        notify(`${cfg.name}: POSSIBLE STEAL $${price.toFixed(2)}`, `${gapPct}% under the $${median.toFixed(2)} listing median, from ${lowest.seller}.${ctx}`, url);
        await set({ [`steal_${id}`]: price });
      }
      stealFired = true;
    } else {
      await set({ [`steal_${id}`]: 0 });
    }
  }

  // ---- thresholds: a LADDER of low markers (alert as the price steps DOWN
  // through each new, deeper marker) plus a single high (spike). Multiple low
  // markers hedge against setting one buy target too low and missing the slide.
  const lows = (Array.isArray(cfg.lowPrices)
    ? [...cfg.lowPrices]
    : (cfg.lowPrice != null ? [cfg.lowPrice] : [])
  ).sort((a, b) => b - a); // high -> low; index 0 is the shallowest marker

  let lowTier = -1; // deepest marker index currently crossed (price <= marker)
  for (let i = 0; i < lows.length; i++) {
    if (price <= lows[i]) {
      lowTier = i;
    }
  }
  const highHit = cfg.highPrice != null && price >= cfg.highPrice;

  const lastLowTier = await get(`lowTier_${id}`, -1);
  const lastHigh = await get(`highState_${id}`, false);
  const lastAlertT = await get(`lastAlertT_${id}`, 0);
  let gapH = await get(`reAlertGap_${id}`, CONFIG.reAlertMinHours);

  const cooldownPassed = CONFIG.reAlertMaxHours > 0 && Date.now() - lastAlertT >= gapH * 3.6e6;
  const levelChanged = (highHit !== lastHigh) || (lowTier !== lastLowTier);
  let fired = false;

  if (highHit) {
    // spike: alert on entry, then re-ping on the backoff while still high
    if (highHit !== lastHigh || cooldownPassed) {
      notify(`${cfg.name}: SPIKE $${price.toFixed(2)}`, `$${price.toFixed(2)} from ${lowest.seller}.${ctx}`, url);
      fired = true;
    }
  } else if (lowTier >= 0 && !stealFired) {
    if (lowTier > lastLowTier) {
      // stepped down to a NEW, deeper marker
      notify(`${cfg.name}: DROP $${price.toFixed(2)} (marker ${lowTier + 1}/${lows.length}, ≤$${lows[lowTier]})`, `$${price.toFixed(2)} from ${lowest.seller}.${ctx}`, url);
      fired = true;
    } else if (lowTier === lastLowTier && cooldownPassed) {
      // still sitting at the deepest marker — re-ping on the backoff
      notify(`${cfg.name}: still ≤$${lows[lowTier]} — $${price.toFixed(2)}`, `$${price.toFixed(2)} from ${lowest.seller}.${ctx}`, url);
      fired = true;
    }
  }

  if (fired) {
    await set({ [`lastAlertT_${id}`]: Date.now() });
  }
  // reset the re-alert gap when the level changed (new marker, or in/out of high);
  // grow it when re-pinging the same level; leave it otherwise.
  if (levelChanged) {
    gapH = CONFIG.reAlertMinHours;
  } else if (fired) {
    gapH = Math.min(gapH * 2, CONFIG.reAlertMaxHours);
  }
  await set({
    [`reAlertGap_${id}`]: gapH,
    [`lowTier_${id}`]: lowTier,
    [`highState_${id}`]: highHit,
  });
  const lead = `${cfg.name}: $${price.toFixed(2)} from ${lowest.seller}`;
  console.log(`[TCG ext ${ts()}] ${[lead, ...ctxLines].join(' | ')}`);

  await maybeDailySnapshot(id, cfg, price, lowest, ctxLines, url);
}

// Fire ONE summary notification per day, on the first scrape at/after the
// configured local hour — a "where things stand" digest to start the day.
async function maybeDailySnapshot(id, cfg, price, lowest, ctxLines, url) {
  if (CONFIG.dailySnapshotHour == null) {
    return;
  }
  const now = new Date();
  if (now.getHours() < CONFIG.dailySnapshotHour) {
    return;
  }
  const today = now.toLocaleDateString();
  if (await get(`snapDay_${id}`, null) === today) {
    return; // already sent today's
  }
  await set({ [`snapDay_${id}`]: today });
  const lead = `Lowest $${price.toFixed(2)} from ${lowest.seller}`;
  notify(`${cfg.name}: daily snapshot`, [lead, ...ctxLines].join('\n'), url);
}

// Anchored Market Price trend: "still falling" on each leg down, "decline
// stalled" once it holds flat after a decline.
async function checkTrend(id, cfg, mkt, ctx, url) {
  if (mkt == null) {
    return;
  }

  const anchor = await get(`anchor_${id}`, null);
  if (!anchor) {
    await set({ [`anchor_${id}`]: { price: mkt, t: Date.now() } });
    return;
  }

  const dropPct = (anchor.price - mkt) / anchor.price;

  if (dropPct >= CONFIG.trendDropPct) {
    const hrs = (Date.now() - anchor.t) / 3.6e6;
    notify(`${cfg.name}: still falling`, `Market down ${(dropPct * 100).toFixed(1)}% over ${hrs.toFixed(1)}h, now $${mkt.toFixed(2)} — likely still finding a floor.${ctx}`, url);
    await set({ [`anchor_${id}`]: { price: mkt, t: Date.now() } });
    await set({ [`declining_${id}`]: true, [`lastDrop_${id}`]: Date.now() });
    return;
  }

  if (mkt >= anchor.price * (1 + CONFIG.trendRiseReset)) {
    await set({ [`anchor_${id}`]: { price: mkt, t: Date.now() } });
    await set({ [`declining_${id}`]: false });
    return;
  }

  if (await get(`declining_${id}`, false)) {
    const flatHrs = (Date.now() - (await get(`lastDrop_${id}`, Date.now()))) / 3.6e6;
    if (flatHrs >= CONFIG.stallHours) {
      notify(`${cfg.name}: decline stalled`, `Market price has held near $${mkt.toFixed(2)} for ${flatHrs.toFixed(0)}h after falling — may have found its floor. Possible buy window.${ctx}`, url);
      await set({ [`declining_${id}`]: false });
    }
  }
}

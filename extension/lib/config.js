// config.js — FILE DEFAULTS. Runtime overrides (set from the service-worker
// console) are merged on top in storage.js and win until resetConfig() — so
// after editing defaults here, run resetConfig() if an override is shadowing
// your change.

export const DEFAULT_PRODUCTS = {
  "693209": {
    name: "Goblin Storm",
    lowPrices: [390, 360, 340, 320], // ladder: alerts as the price steps down through each
    highPrices: [410], // ladder: alerts as the price steps up through each spike marker
    floorPrice: 140,
  },
};

export const DEFAULT_CONFIG = {
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

  stealFactor: 0.65,                // lowest listing <= Market Price x this => steal alert
  stealMinListings: 4,              // need at least this many listings before a steal can fire

  // VELOCITY-AWARE steals: when stock is draining fast a cheap listing won't
  // last, so loosen the steal factor to catch it sooner.
  stealVelocityWindowHours: 12,     // window over which quantity drop is measured
  stealVelocityThreshold: 0.30,     // qty fell this fraction over the window => "selling fast"
  stealVelocityBoost: 0.10,         // add this to stealFactor while selling fast (capped at 0.95)

  // SELECTOR HEALTH: if the page renders but our selectors parse nothing this
  // many polls in a row, alert that the scraper is likely broken.
  healthAlertAfter: 3,

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

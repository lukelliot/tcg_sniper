// constants.js — named values shared across the service worker. Anything that
// was previously a bare string/number literal lives here, so the meaning is in
// one place and call sites read declaratively.

// The single chrome.alarms alarm name (the durable poll timer).
export const ALARM = 'tcgpoll';

// Per-product floor state (stored under KEY.state(id)).
export const STATE = {
  NORMAL: 'normal',
  BELOW_FLOOR: 'belowfloor',
};

export const URLS = {
  TCG_ALL: 'https://www.tcgplayer.com/*',
  NTFY_BASE: 'https://ntfy.sh/',
};

export const REGEX = {
  PRODUCT_ID: /\/product\/(\d+)/, // captures the numeric product id from a URL
  UHOH: /tcgplayer\.com\/uhoh/,   // TCGplayer's "you're blocked" redirect
};

// Notification tuning.
export const NTFY_TAGS = 'moneybag';
export const NOTIFICATION_PRIORITY = 2;

// chrome.power level: keep the system awake (display may still sleep).
export const KEEP_AWAKE_LEVEL = 'system';

// Milliseconds per unit — replaces 60000 / 3.6e6 / 86400000 scattered inline.
export const MS = {
  MIN: 60000,
  HOUR: 3.6e6,
  DAY: 86400000,
};

// Price-history retention.
export const HISTORY = {
  MAX_SAMPLES: 2000,      // hard cap on stored samples per product
  RETENTION_FACTOR: 1.5,  // keep 1.5x the longest trend window before pruning
};

// chrome.storage.local keys. Globals are plain strings; per-product keys are
// builders so the produced string (e.g. "empties_693209") stays byte-identical
// to v1.0 — existing stored state survives the refactor.
export const KEY = {
  CONFIG_OVERRIDE: 'configOverride',
  PRODUCTS_OVERRIDE: 'productsOverride',
  PAUSED: 'paused',
  FLAGGED_BACKOFF: 'flaggedBackoff',
  FLAGGED_SINCE: 'flaggedSince',

  productPaused: (id) => `productPaused_${id}`,
  url: (id) => `url_${id}`,
  empties: (id) => `empties_${id}`,
  mult: (id) => `mult_${id}`,
  clean: (id) => `clean_${id}`,
  hist: (id) => `hist_${id}`,
  lastMarket: (id) => `lastMarket_${id}`,
  state: (id) => `state_${id}`,
  steal: (id) => `steal_${id}`,
  lowTier: (id) => `lowTier_${id}`,
  highState: (id) => `highState_${id}`,
  lastAlertT: (id) => `lastAlertT_${id}`,
  reAlertGap: (id) => `reAlertGap_${id}`,
  anchor: (id) => `anchor_${id}`,
  declining: (id) => `declining_${id}`,
  lastDrop: (id) => `lastDrop_${id}`,
  snapDay: (id) => `snapDay_${id}`,
  unhealthy: (id) => `unhealthy_${id}`,
  healthAlerted: (id) => `healthAlerted_${id}`,
};

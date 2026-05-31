// options.js — the settings UI. It reads and writes the SAME storage overrides
// (configOverride / productsOverride / paused) that the service-worker console
// controls use, so the two stay in sync. The form is generated from the file
// defaults, so adding a knob in config.js automatically surfaces here. Changes
// land in storage and the worker picks them up on its next poll.

import { DEFAULT_CONFIG, DEFAULT_PRODUCTS } from './lib/config.js';
import { KEY } from './lib/constants.js';

const get = (k, d) => new Promise((r) => chrome.storage.local.get([k], (o) => r(k in o ? o[k] : d)));
const set = (o) => new Promise((r) => chrome.storage.local.set(o, r));

// Config keys whose value may legitimately be null (empty input => null,
// rather than "unset, follow default").
const NULLABLE = new Set(['dailySnapshotHour']);

const PRODUCT_FIELDS = [
  { key: 'name', label: 'Name', type: 'text' },
  { key: 'lowPrices', label: 'Low markers (ladder)', type: 'list', hint: 'Comma-separated, high → low. Alerts as the price steps down through each.' },
  { key: 'highPrice', label: 'High (spike) price', type: 'number' },
  { key: 'floorPrice', label: 'Junk floor', type: 'number', hint: 'Listings below this are ignored.' },
];

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const parseList = (s) => String(s).split(',').map((x) => Number(x.trim())).filter((n) => Number.isFinite(n));

// --- effective state (defaults overlaid with stored overrides) ---------------

function effectiveProducts(po) {
  const out = {};
  for (const id of Object.keys(DEFAULT_PRODUCTS)) {
    if (po[id] === null) {
      continue;
    }
    out[id] = { ...DEFAULT_PRODUCTS[id], ...(po[id] || {}) };
  }
  for (const id of Object.keys(po)) {
    if (po[id] && !out[id]) {
      out[id] = { ...po[id] };
    }
  }
  return out;
}

// --- product cards -----------------------------------------------------------

const cardId = (card) => card.querySelector('.pid').value.trim();

// Read one card's fields into a product object.
function readCard(card) {
  const prod = {};
  PRODUCT_FIELDS.forEach((f) => {
    const raw = card.querySelector(`[data-field="${f.key}"]`).value.trim();
    if (f.type === 'list') {
      prod[f.key] = parseList(raw);
    } else if (f.type === 'number') {
      prod[f.key] = raw === '' ? null : Number(raw);
    } else {
      prod[f.key] = raw;
    }
  });
  return prod;
}

function readProductCards() {
  const out = {};
  document.querySelectorAll('#products .product').forEach((card) => {
    const id = cardId(card);
    if (id) {
      out[id] = readCard(card);
    }
  });
  return out;
}

// Per-tile actions. Each handler takes the card element and reads the id at
// click time (a new product's id is editable). Add buttons here to extend the
// bars — the top bar is for product actions, the bottom bar for destructive ones.
const PRODUCT_ACTIONS = [
  { label: 'Save', primary: true, handler: saveProductCard },
  { label: 'Open', handler: openProductPage },
  { label: 'Refresh', handler: refreshProductTabs },
  { label: 'Focus tab', handler: focusProductTab },
  // Pause is a toggle: its label/appearance reflect stored per-product state, so
  // it carries a `refresh` hook that actionBar calls on render and after click.
  { handler: toggleProductPause, refresh: syncPauseButton },
];
const PRODUCT_DESTRUCTIVE = [
  { label: 'Remove', danger: true, handler: removeProductCard },
];

// Find the open tab(s) for a product id. The id boundary guards against one id
// being a prefix of another (e.g. 693209 vs 6932090).
async function productTabs(id) {
  if (!id) {
    return [];
  }
  const tabs = await chrome.tabs.query({ url: 'https://www.tcgplayer.com/product/*' });
  const re = new RegExp(`/product/${id}(?:\\D|$)`);
  return tabs.filter((t) => re.test(t.url || ''));
}

// Save just this product into productsOverride (mirrors setProduct): drop the
// override when it equals the file default, otherwise store the whole object.
async function saveProductCard(card) {
  const id = cardId(card);
  if (!id) {
    flash('Set a product id first.', 'warn');
    return;
  }
  const prod = readCard(card);
  const po = await get(KEY.PRODUCTS_OVERRIDE, {});
  if (DEFAULT_PRODUCTS[id] && eq(prod, DEFAULT_PRODUCTS[id])) {
    delete po[id];
  } else {
    po[id] = prod;
  }
  await set({ [KEY.PRODUCTS_OVERRIDE]: po });
  flash(`Saved ${id} — applies on the next poll.`);
}

async function refreshProductTabs(card) {
  const id = cardId(card);
  const tabs = await productTabs(id);
  if (!tabs.length) {
    flash(`No open tab for ${id || 'this product'}.`, 'warn');
    return;
  }
  await Promise.all(tabs.map((t) => chrome.tabs.reload(t.id)));
  flash(`Refreshed ${tabs.length} tab${tabs.length > 1 ? 's' : ''} for ${id}.`);
}

// Open the product's TCGplayer page in a new tab. Prefer the last-known URL we
// scraped (full slug); otherwise the canonical /product/<id> URL, which
// TCGplayer redirects to the slug.
async function openProductPage(card) {
  const id = cardId(card);
  if (!id) {
    flash('Set a product id first.', 'warn');
    return;
  }
  const stored = await get(KEY.url(id), null);
  const url = stored || `https://www.tcgplayer.com/product/${id}`;
  await chrome.tabs.create({ url });
}

async function focusProductTab(card) {
  const id = cardId(card);
  const [tab] = await productTabs(id);
  if (!tab) {
    flash(`No open tab for ${id || 'this product'}.`, 'warn');
    return;
  }
  await chrome.tabs.update(tab.id, { active: true });
  if (tab.windowId != null) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
}

// Per-product pause. Independent of the product config override (so Save/Reset
// of the fields doesn't clobber it) and of the global pause; the scheduler skips
// reloads/reopens for a paused product and evaluate() drops its scrapes.
async function toggleProductPause(card) {
  const id = cardId(card);
  if (!id) {
    flash('Set a product id first.', 'warn');
    return;
  }
  const now = !(await get(KEY.productPaused(id), false));
  await set({ [KEY.productPaused(id)]: now });
  flash(now ? `Paused ${id} — no reloads or alerts.` : `Resumed ${id}.`, now ? 'warn' : 'success');
}

// Reflect the stored pause state on the button and dim the tile when paused.
// Called on render and again after the toggle handler runs.
async function syncPauseButton(button, card) {
  const id = cardId(card);
  const paused = id ? await get(KEY.productPaused(id), false) : false;
  button.textContent = paused ? 'Resume' : 'Pause';
  button.classList.toggle('danger', paused);
  card.classList.toggle('paused', paused);
}

// Stop watching: a default id becomes a null tombstone; anything else just
// drops its override. Brand-new unsaved cards (no id yet) only leave the DOM.
async function removeProductCard(card) {
  const id = cardId(card);
  if (id) {
    const po = await get(KEY.PRODUCTS_OVERRIDE, {});
    if (DEFAULT_PRODUCTS[id]) {
      po[id] = null;
    } else {
      delete po[id];
    }
    await set({ [KEY.PRODUCTS_OVERRIDE]: po });
  }
  card.remove();
  flash(id ? `Removed ${id}.` : 'Removed.');
}

function actionBar(card, actions, cls) {
  const bar = document.createElement('div');
  bar.className = `tile-bar ${cls}`;
  for (const a of actions) {
    const b = document.createElement('button');
    b.type = 'button';
    if (a.label) {
      b.textContent = a.label;
    }
    if (a.primary) {
      b.classList.add('primary');
    }
    if (a.danger) {
      b.classList.add('danger');
    }
    if (a.refresh) {
      a.refresh(b, card); // set the initial label/appearance from stored state
    }
    b.onclick = async () => {
      await a.handler(card);
      if (a.refresh) {
        a.refresh(b, card); // re-sync after a toggle changes stored state
      }
    };
    bar.appendChild(b);
  }
  return bar;
}

function productCard(id, prod) {
  const card = document.createElement('div');
  card.className = 'product';

  card.appendChild(actionBar(card, PRODUCT_ACTIONS, 'top'));

  const fields = document.createElement('div');
  fields.className = 'fields';

  const idRow = document.createElement('div');
  idRow.className = 'row';
  const idLab = document.createElement('label');
  idLab.textContent = 'Product id';
  const idInput = document.createElement('input');
  idInput.type = 'text';
  idInput.value = id || '';
  idInput.className = 'pid';
  idInput.placeholder = 'e.g. 693209';
  idInput.disabled = !!DEFAULT_PRODUCTS[id]; // don't let a default id be renamed
  idRow.appendChild(idLab);
  idRow.appendChild(idInput);
  fields.appendChild(idRow);

  for (const f of PRODUCT_FIELDS) {
    const row = document.createElement('div');
    row.className = 'row';
    const lab = document.createElement('label');
    lab.textContent = f.label;
    const input = document.createElement('input');
    input.type = f.type === 'number' ? 'number' : 'text';
    input.dataset.field = f.key;
    const v = prod ? prod[f.key] : undefined;
    input.value = f.type === 'list' ? (Array.isArray(v) ? v.join(', ') : '') : (v ?? '');
    row.appendChild(lab);
    row.appendChild(input);
    if (f.hint) {
      const hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent = f.hint;
      row.appendChild(hint);
    }
    fields.appendChild(row);
  }

  card.appendChild(fields);
  card.appendChild(actionBar(card, PRODUCT_DESTRUCTIVE, 'bottom'));
  return card;
}

// Turn the edited effective products back into the minimal override object,
// mirroring storage.applyOverrides: unchanged defaults are omitted, removed
// defaults become null tombstones, everything else is stored whole.
function productsToOverride(effective) {
  const po = {};
  for (const [id, prod] of Object.entries(effective)) {
    if (DEFAULT_PRODUCTS[id] && eq(prod, DEFAULT_PRODUCTS[id])) {
      continue;
    }
    po[id] = prod;
  }
  for (const id of Object.keys(DEFAULT_PRODUCTS)) {
    if (!(id in effective)) {
      po[id] = null;
    }
  }
  return po;
}

// --- global config form ------------------------------------------------------

// camelCase -> "Camel Case" (e.g. basePeriodMin -> "Base Period Min").
const humanize = (k) => k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()).trim();

// Functional grouping for the settings form. Keys not listed here fall into an
// "Other" group automatically, so a new knob in config.js still shows up.
const CONFIG_GROUPS = [
  { title: 'Polling', keys: ['basePeriodMin', 'maxPeriodMin'] },
  { title: 'Adaptive backoff', keys: ['backoffAfterEmpties', 'backoffGrowth', 'relaxAfterClean', 'relaxFactor'] },
  { title: 'Re-alerts', keys: ['reAlertMinHours', 'reAlertMaxHours'] },
  { title: 'Trend & history', keys: ['trendDropPct', 'trendRiseReset', 'stallHours', 'trendWindowsDays', 'historyMinIntervalMinutes'] },
  { title: 'Steals', keys: ['stealFactor', 'stealMinListings', 'stealVelocityWindowHours', 'stealVelocityThreshold', 'stealVelocityBoost'] },
  { title: 'Selector health', keys: ['healthAlertAfter'] },
  { title: 'Notifications', keys: ['dailySnapshotHour', 'useDesktop', 'useNtfy', 'ntfyTopic'] },
  { title: 'Tabs & block recovery', keys: ['reopenIfClosed', 'flaggedBackoffMin', 'flaggedMaxBackoffMin'] },
];

// Short, plain-English help per knob (shown under each field).
const CONFIG_HINTS = {
  basePeriodMin: 'Minutes between polls (Chrome floor is 1). e.g. 5',
  maxPeriodMin: 'Backoff ceiling — base × multiplier never exceeds this. e.g. 16',
  backoffAfterEmpties: 'Empty renders in a row before slowing down (likely a challenge). e.g. 3',
  backoffGrowth: 'Multiply the poll interval by this each troubled cycle. e.g. 1.5',
  relaxAfterClean: 'Clean cycles in a row before easing back toward the base period. e.g. 30',
  relaxFactor: 'Multiplier applied when relaxing (decays toward 1). e.g. 0.8',
  reAlertMinHours: 'Shortest gap before re-pinging the same level. e.g. 1',
  reAlertMaxHours: 'Longest re-ping gap; set 0 to alert only on the crossing. e.g. 5',
  trendDropPct: 'Ping when Market Price falls this fraction from the anchor. e.g. 0.05 = 5%',
  trendRiseReset: 'Rebaseline the anchor if the price recovers this much. e.g. 0.05 = 5%',
  stallHours: 'Flat this long after a decline → a "possible floor" ping. e.g. 24',
  trendWindowsDays: 'Look-back windows (days) reported in alerts. e.g. 2, 3, 5',
  historyMinIntervalMinutes: 'Minimum spacing between stored history samples. e.g. 20',
  stealFactor: 'Steal alert when lowest ≤ median × this. e.g. 0.65 = 35% under',
  stealMinListings: 'Minimum listings needed to compute a median. e.g. 4',
  stealVelocityWindowHours: 'Window over which stock drain is measured. e.g. 12',
  stealVelocityThreshold: 'Quantity drop over the window that counts as "selling fast". e.g. 0.30 = 30%',
  stealVelocityBoost: 'Loosen the steal factor by this while selling fast (capped 0.95). e.g. 0.10',
  healthAlertAfter: 'Polls that parse nothing before a "scraper likely broken" alert. e.g. 3',
  dailySnapshotHour: 'Local hour 0–23 for the daily digest; leave blank to disable. e.g. 8',
  useDesktop: 'Show Chrome desktop notifications.',
  useNtfy: 'Also push alerts via ntfy.sh.',
  ntfyTopic: 'Your ntfy.sh topic to publish to. e.g. tcgplayer-sniper',
  reopenIfClosed: 'Reopen a watched product tab if it gets closed (pinned, background).',
  flaggedBackoffMin: 'Starting backoff when blocked (/uhoh); doubles per block. e.g. 10',
  flaggedMaxBackoffMin: 'Cap on the blocked-state backoff. e.g. 120',
};

function configRow(key, def, current) {
  const row = document.createElement('div');
  row.className = 'row';
  const lab = document.createElement('label');
  lab.textContent = humanize(key);
  lab.htmlFor = `cfg_${key}`;
  row.appendChild(lab);

  const input = document.createElement('input');
  input.id = `cfg_${key}`;
  input.dataset.key = key;

  if (typeof def === 'boolean') {
    input.type = 'checkbox';
    input.checked = !!current;
    input.dataset.kind = 'boolean';
  } else if (Array.isArray(def)) {
    input.type = 'text';
    input.value = Array.isArray(current) ? current.join(', ') : '';
    input.dataset.kind = 'list';
  } else if (typeof def === 'number' || def === null) {
    input.type = 'number';
    input.value = current ?? '';
    input.dataset.kind = 'number';
  } else {
    input.type = 'text';
    input.value = current ?? '';
    input.dataset.kind = 'string';
  }

  // checkbox sits to the left; wrap so the grid column doesn't stretch it.
  if (input.type === 'checkbox') {
    const wrap = document.createElement('span');
    wrap.appendChild(input);
    row.appendChild(wrap);
  } else {
    row.appendChild(input);
  }

  if (CONFIG_HINTS[key]) {
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = CONFIG_HINTS[key];
    row.appendChild(hint);
  }
  return row;
}

function readConfig() {
  const override = {};
  document.querySelectorAll('#config input').forEach((input) => {
    const key = input.dataset.key;
    const def = DEFAULT_CONFIG[key];
    let val;
    switch (input.dataset.kind) {
      case 'boolean':
        val = input.checked;
        break;
      case 'list':
        val = parseList(input.value);
        break;
      case 'number': {
        const raw = input.value.trim();
        if (raw === '') {
          val = NULLABLE.has(key) ? null : def; // empty => null only where meaningful
        } else {
          val = Number(raw);
        }
        break;
      }
      default:
        val = input.value;
    }
    if (!eq(val, def)) {
      override[key] = val;
    }
  });
  return override;
}

// --- wiring ------------------------------------------------------------------

let paused = false;

function renderPause() {
  document.getElementById('pauseState').textContent = paused ? 'PAUSED — no reloads or alerts' : 'Active';
  document.getElementById('pauseBtn').textContent = paused ? 'Resume' : 'Pause';
}

// Floating toast feedback. variant 'success' (green) or 'warn' (amber).
let toastTimer = null;
function flash(msg, variant = 'success') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('warn');
  if (variant === 'warn') {
    el.classList.add('warn');
  }
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

async function load() {
  const co = await get(KEY.CONFIG_OVERRIDE, {});
  const po = await get(KEY.PRODUCTS_OVERRIDE, {});
  paused = await get(KEY.PAUSED, false);

  const productsEl = document.getElementById('products');
  productsEl.innerHTML = '';
  const products = effectiveProducts(po);
  for (const [id, prod] of Object.entries(products)) {
    productsEl.appendChild(productCard(id, prod));
  }

  const configEl = document.getElementById('config');
  configEl.innerHTML = '';
  const grouped = new Set(CONFIG_GROUPS.flatMap((g) => g.keys));
  const other = Object.keys(DEFAULT_CONFIG).filter((k) => !grouped.has(k));
  const groups = other.length ? [...CONFIG_GROUPS, { title: 'Other', keys: other }] : CONFIG_GROUPS;

  for (const group of groups) {
    const keys = group.keys.filter((k) => k in DEFAULT_CONFIG);
    if (!keys.length) {
      continue;
    }
    const heading = document.createElement('div');
    heading.className = 'group-title';
    heading.textContent = group.title;
    configEl.appendChild(heading);
    for (const key of keys) {
      const def = DEFAULT_CONFIG[key];
      const current = key in co ? co[key] : def;
      configEl.appendChild(configRow(key, def, current));
    }
  }

  renderPause();
}

async function save() {
  await set({
    [KEY.CONFIG_OVERRIDE]: readConfig(),
    [KEY.PRODUCTS_OVERRIDE]: productsToOverride(readProductCards()),
  });
  flash('Saved — applies on the next poll.');
}

async function reset() {
  // Drop overrides and clear runtime pause state (global + every per-product flag).
  const all = await new Promise((r) => chrome.storage.local.get(null, r));
  const pausedKeys = Object.keys(all).filter((k) => k.startsWith('productPaused_'));
  await new Promise((r) => chrome.storage.local.remove(pausedKeys, r));
  await set({ [KEY.CONFIG_OVERRIDE]: {}, [KEY.PRODUCTS_OVERRIDE]: {}, [KEY.PAUSED]: false });
  paused = false;
  await load();
  flash('Reset to file defaults.');
}

document.getElementById('addProduct').onclick = () => {
  document.getElementById('products').appendChild(productCard('', null));
};
document.getElementById('save').onclick = save;
document.getElementById('reset').onclick = reset;
document.getElementById('pauseBtn').onclick = async () => {
  paused = !paused;
  await set({ [KEY.PAUSED]: paused });
  renderPause();
  flash(paused ? 'Paused.' : 'Resumed.');
};

load();

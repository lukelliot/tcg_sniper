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

function productCard(id, prod) {
  const card = document.createElement('div');
  card.className = 'product';
  card.dataset.defaultId = DEFAULT_PRODUCTS[id] ? '1' : '';

  const idRow = document.createElement('div');
  idRow.className = 'row';
  idRow.innerHTML = '<label>Product id</label>';
  const idInput = document.createElement('input');
  idInput.type = 'text';
  idInput.value = id || '';
  idInput.className = 'pid';
  idInput.placeholder = 'e.g. 693209';
  idInput.disabled = !!DEFAULT_PRODUCTS[id]; // don't let a default id be renamed
  idRow.appendChild(idInput);
  card.appendChild(idRow);

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
    card.appendChild(row);
  }

  const rm = document.createElement('button');
  rm.type = 'button';
  rm.className = 'remove danger';
  rm.textContent = 'Remove';
  rm.onclick = () => card.remove();
  card.appendChild(rm);

  return card;
}

function readProductCards() {
  const out = {};
  document.querySelectorAll('#products .product').forEach((card) => {
    const id = card.querySelector('.pid').value.trim();
    if (!id) {
      return;
    }
    const prod = {};
    PRODUCT_FIELDS.forEach((f) => {
      const input = card.querySelector(`[data-field="${f.key}"]`);
      const raw = input.value.trim();
      if (f.type === 'list') {
        prod[f.key] = parseList(raw);
      } else if (f.type === 'number') {
        prod[f.key] = raw === '' ? null : Number(raw);
      } else {
        prod[f.key] = raw;
      }
    });
    out[id] = prod;
  });
  return out;
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

function configRow(key, def, current) {
  const row = document.createElement('div');
  row.className = 'row';
  const lab = document.createElement('label');
  lab.textContent = key;
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

function flash(msg) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1800);
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
  for (const [key, def] of Object.entries(DEFAULT_CONFIG)) {
    const current = key in co ? co[key] : def;
    configEl.appendChild(configRow(key, def, current));
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

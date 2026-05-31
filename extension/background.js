// background.js — service-worker ENTRY. Wires the chrome listeners to the
// modules in ./lib; all logic lives there:
//   lib/config.js     file defaults (products + global config)
//   lib/constants.js  storage keys, state enum, URLs/regex, time units
//   lib/storage.js    chrome.storage layer + live CONFIG/PRODUCTS holder
//   lib/scheduler.js  the durable alarm: poll, block recovery, tab reopen
//   lib/evaluate.js   process one scrape: period, floor, steal, ladder, trend
//   lib/notify.js     desktop + ntfy.sh fan-out
//   lib/trend.js      price history + trend signals
//   lib/controls.js   console controls (setProduct/setConfig/... on globalThis)
//
// Listeners are registered synchronously at top level, as MV3 requires.

import { applyOverrides, getConfig } from './lib/storage.js';
import { ensureAlarm, keepAwake, handleTick } from './lib/scheduler.js';
import { evaluate } from './lib/evaluate.js';
import { registerControls } from './lib/controls.js';

registerControls();

async function bootstrap() {
  await applyOverrides();
  keepAwake();
  ensureAlarm(getConfig().basePeriodMin);
}

chrome.runtime.onInstalled.addListener(bootstrap);
chrome.runtime.onStartup.addListener(bootstrap);

chrome.alarms.onAlarm.addListener((a) => {
  handleTick(a).catch(console.error);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'scrape') {
    evaluate(msg).catch(console.error);
  }
});

// Clicking the toolbar icon opens the settings page.
chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

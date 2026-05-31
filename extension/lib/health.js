// health.js — detect a likely SELECTOR BREAK: the product page structurally
// rendered, but our specific selectors extracted nothing. This is distinct
// from a sellout (no listing nodes at all) or an anti-bot challenge (an empty
// render, handled by the adaptive backoff). When TCGplayer changes their
// markup the watch would otherwise just go quiet; here we alert once instead.

import { get, set, getConfig } from './storage.js';
import { KEY } from './constants.js';
import { notify } from './notify.js';
import { log } from './log.js';

export async function checkScrapeHealth(id, cfg, diag, url) {
  if (!diag) {
    return; // older content script mid-upgrade — no diagnostics to judge
  }

  const c = getConfig();
  // Nodes exist but none yielded a price -> the listing selectors are stale.
  const listingsBroke = diag.listingNodes > 0 && diag.listingsParsed === 0;
  // The price panel is on the page but the market price didn't parse.
  const marketBroke = diag.marketPanel && !diag.marketParsed;
  const broken = listingsBroke || marketBroke;

  if (!broken) {
    // Healthy — clear any prior streak/alert latch so a future break re-alerts.
    if ((await get(KEY.unhealthy(id), 0)) || (await get(KEY.healthAlerted(id), false))) {
      await set({ [KEY.unhealthy(id)]: 0, [KEY.healthAlerted(id)]: false });
    }
    return;
  }

  const streak = (await get(KEY.unhealthy(id), 0)) + 1;
  await set({ [KEY.unhealthy(id)]: streak });

  if (streak >= c.healthAlertAfter && !(await get(KEY.healthAlerted(id), false))) {
    const what = [listingsBroke ? 'listings' : null, marketBroke ? 'market price' : null]
      .filter(Boolean)
      .join(' + ');
    notify(
      `${cfg.name}: scraper may be broken`,
      `The page rendered but ${what} didn't parse for ${streak} polls — TCGplayer's markup may have changed. Check the selectors in content.js.`,
      url,
    );
    await set({ [KEY.healthAlerted(id)]: true });
  }

  log(`${cfg.name}: scrape health — listingNodes=${diag.listingNodes} parsed=${diag.listingsParsed} marketPanel=${diag.marketPanel} marketParsed=${diag.marketParsed} (unhealthy x${streak})`);
}

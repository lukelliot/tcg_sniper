# TCGplayer Price Watch

A Chrome extension (Manifest V3) that watches the cheapest buyable listing and the Market Price trend on chosen [TCGplayer](https://www.tcgplayer.com) products, then notifies you on threshold, steal, and trend events — via desktop notifications and/or [ntfy.sh](https://ntfy.sh) push.

It's built to run unattended for days: a `chrome.alarms` timer drives the cadence independent of page state, so the watch recovers on its own from failed loads, discarded tabs, sleep, and anti-bot blocks.

## How it works

```
chrome.alarms ──tick──▶ background.js (service worker)
                          │  reloads watched product tab(s)
                          ▼
                        content.js (per product page)
                          │  scrapes listings + price-points panel
                          ▼
                        background.js → evaluate() → notify()
                                                       ├─ desktop notification
                                                       └─ ntfy.sh push
```

- **`background.js`** — a thin service-worker entry point. It wires up the listeners (alarm, message, install/startup) and delegates to focused ES modules under [`extension/lib/`](extension/lib): `scheduler.js` (alarm cadence, tab reload/reopen, block backoff), `evaluate.js` (the per-scrape pipeline), `trend.js`, `pricing.js` (pure price/history math), `health.js` (selector health-check), `notify.js`, `storage.js`, `config.js`, and `controls.js` (console commands). On each alarm it reloads the watched tab(s); when a scrape comes back, `evaluate()` runs thresholds, steals, and trend, fires notifications, and stores price history. All config and runtime state live in `chrome.storage.local`.
- **`content.js`** — injected into each `tcgplayer.com/product/*` page. Its only job is to wait for the listings and price-points panel to render, scrape them (plus structural diagnostics for the health-check), and message the result back. It schedules nothing.
- **`ui.html` / `ui.js`** — a settings UI (opens in a tab) for editing products and global config without the console. See [Configure](#configure).
- **`manifest.json`** — MV3 manifest; permissions: `alarms`, `notifications`, `storage`, `tabs`, `power`.

## Alerts

- **Threshold ladder** — a list of descending "low" price markers plus one "high" (spike) marker. You get a `DROP` alert as the cheapest listing steps down through each new, deeper marker, and a `SPIKE` alert when it crosses the high. While the price sits at a marker, it re-pings on a backoff that doubles each time (clamped between `reAlertMinHours` and `reAlertMaxHours`).
- **Steal** — fires when the cheapest listing is `stealFactor` (default 65%) or less of the listing median, given at least `stealMinListings` listings. *Velocity-aware:* when stock is draining fast (quantity falls `stealVelocityThreshold` over `stealVelocityWindowHours`), the factor loosens by `stealVelocityBoost` so a disappearing deal still trips.
- **Trend** — anchored on the smoothed Market Price: a `still falling` ping each time it drops `trendDropPct` from the anchor, and a `decline stalled` ping once it holds flat for `stallHours` after a decline (a possible buy window). Alerts also report change over `trendWindowsDays` (settable globally or per product).
- **Daily snapshot** — one digest notification per day at/after `dailySnapshotHour`.
- **Floor** — listings below `floorPrice` are treated as junk and ignored; if *all* listings fall below it you get a "look manually" alert.

## Resilience

- **Durable scheduling** — the alarm fires on its period regardless of page/network state; a failed load just gets retried next tick.
- **Adaptive backoff** — repeated empty renders (a likely challenge) slow the poll up to `maxPeriodMin`; a run of clean cycles relaxes it back toward the base.
- **Block recovery** — if TCGplayer redirects to `/uhoh`, the poll backs off (10 → 20 → … → 120 min) and recovers by reusing the blocked tab rather than hammering or spawning new ones.
- **Self-healing tabs** — if a watched tab is closed or discarded, it's reopened (pinned, background) from the last known URL.
- **Carry-forward** — late-rendering Market Price / quantity fields fall back to the last good reading per field so alerts don't blank out or show 0.
- **Selector health-check** — if a page renders but our selectors parse nothing for `healthAlertAfter` polls in a row, you get a one-time alert that the scraper is likely broken (TCGplayer changed their markup), instead of the watch silently going dark.
- **Keep-awake** — requests the OS not to idle-sleep so overnight watches keep running.

## Install

1. Clone this repo.
2. Open `chrome://extensions`, enable **Developer mode**.
3. Click **Load unpacked** and select the `extension/` folder.

## Configure

File defaults live in [`extension/lib/config.js`](extension/lib/config.js) (`DEFAULT_PRODUCTS` and `DEFAULT_CONFIG`). You can edit them there, or override them at runtime two ways:

**Settings UI (recommended).** Open the extension's options page (`chrome://extensions` → this extension → **Details** → **Extension options**, or the toolbar puzzle icon → ⋮ → **Options**). It has a form for each product (markers, high/spike, floor) and every global knob, plus pause/resume and reset. Changes are saved as overrides and the worker applies them on its next poll.

**Service worker console.** `chrome://extensions` → this extension → "service worker":

```js
setProduct('693209', { lowPrices: [390, 360, 340], highPrice: 410 }) // change a product's markers
setProduct('693209', null)                                           // stop watching that product
setConfig({ basePeriodMin: 5, dailySnapshotHour: 8 })                // change global settings
showConfig()                                                         // print effective config
resetConfig()                                                        // drop overrides, back to file defaults
pauseWatch() / resumeWatch() / statusWatch()                         // pause / resume / inspect
pauseProduct('693209') / pauseProduct('693209', false)               // pause / resume just one product
```

Both paths write the same overrides in `chrome.storage.local`, which win over file defaults until reset. To watch a product, find its numeric id in the TCGplayer product URL (`tcgplayer.com/product/<id>/...`) and add it in the UI or via `setProduct` (or to `DEFAULT_PRODUCTS`).

### Push notifications (optional)

Set `useNtfy: true` and a `ntfyTopic` in the config, then subscribe to that topic in the [ntfy](https://ntfy.sh) app to get alerts on your phone. Desktop notifications are controlled by `useDesktop`.

## Development

The pure price/history math in [`extension/lib/pricing.js`](extension/lib/pricing.js) has no `chrome` dependency and is unit-tested, as are the version helpers in [`scripts/version.mjs`](scripts/version.mjs):

```sh
npm test   # node --test
```

GitHub Actions runs the suite on every PR and on `main` ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

### Versioning & releases

Versioning follows [Conventional Commits](https://www.conventionalcommits.org/) and is automated — `manifest.json`'s `version` is never bumped by hand:

- On each PR, [`version-bump.yml`](.github/workflows/version-bump.yml) reads the **PR title** (which becomes the squash-merge subject) and bumps `manifest.json` on the PR branch — `feat:` → minor, `fix:`/`perf:` → patch, a `!` or `BREAKING CHANGE` → major, anything else (`docs:`, `chore:`, `ci:`, …) → no bump. The bump rides into `main` with the squash-merge, so the version lands on a verified commit with no extra tokens or protection changes.
- When the bump lands on `main`, [`release.yml`](.github/workflows/release.yml) tags it `vX.Y.Z` and cuts a GitHub Release with auto-generated notes.

The displayed version in the options header reads straight from the manifest at runtime, so it always matches the installed build.

## Notes

This relies on TCGplayer's current DOM structure (CSS classes scraped in `content.js`). If their markup changes, the selectors in `readListings()` / `scrapeMarket()` will need updating. For personal use; respect TCGplayer's terms of service and don't poll aggressively.

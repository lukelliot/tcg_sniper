// content.js — runs in each TCGplayer product page. Its ONLY job is to scrape
// the rendered DOM and report to the service worker. It schedules nothing;
// the worker's alarm drives the cadence. (Same parsing as the userscript.)

(function () {
  // Pull the first dollar amount out of a string, or null if none.
  const money = (s) => {
    if (!s) {
      return null;
    }
    const m = String(s).replace(/,/g, '').match(/\$?\s*(\d+(?:\.\d{1,2})?)/);
    return m ? parseFloat(m[1]) : null;
  };

  function readListings() {
    const out = [];

    document.querySelectorAll('.listing-item').forEach((li) => {
      const priceEl = li.querySelector('.listing-item__listing-data__info__price');
      if (!priceEl) {
        return;
      }

      const item = money(priceEl.textContent);
      if (item == null) {
        return;
      }

      let shipping = 0;
      const sib = priceEl.nextElementSibling;
      if (sib && sib.tagName === 'SPAN') {
        const txt = (sib.textContent || '').trim();
        const s = money(txt);
        if (s != null) {
          shipping = s;
        } else if (txt && !/included/i.test(txt)) {
          console.warn(`[TCG ext] unrecognized shipping text "${txt}" — treated as $0.`);
        }
      }

      const sellerEl = li.querySelector('.seller-info__name');
      out.push({
        item,
        shipping,
        total: +(item + shipping).toFixed(2),
        seller: sellerEl ? sellerEl.textContent.trim() : 'Unknown seller',
      });
    });

    return out;
  }

  function scrapeMarket() {
    const num = (el) => (el ? money(el.textContent) : null);
    const intOf = (s) => {
      if (s == null) {
        return null;
      }
      const m = String(s).replace(/,/g, '').match(/(\d+)/);
      return m ? parseInt(m[1], 10) : null;
    };
    // Treat 0 as "not rendered yet": with live listings present a real 0 is
    // impossible (a true sellout shows as empty listings), so 0 is a mid-render
    // placeholder. Returning null lets carry-forward show the last good value.
    const posInt = (s) => {
      const n = intOf(s);
      return n != null && n > 0 ? n : null;
    };

    const upper = document.querySelectorAll('.price-points__upper__price');
    const sales = document.querySelectorAll('.sales-data__price');
    const change = document.querySelector('.charts-change');

    // Lower panel: pair each label (.text) with its value, by document order,
    // into a label-keyed map — more robust than a bare positional index.
    // Labels: "Listed Median:", "Current Quantity:", "Current Sellers:".
    const lower = {};
    const labels = document.querySelectorAll('.price-points__lower .text');
    const values = document.querySelectorAll('.price-points__lower .price-points__lower__price');
    labels.forEach((lab, i) => {
      const key = (lab.textContent || '').trim().replace(/:$/, '').toLowerCase();
      if (key && values[i]) {
        lower[key] = values[i].textContent.trim();
      }
    });

    return {
      marketPrice: num(upper[0]),
      recentSale: num(upper[1]),
      lowSale3mo: num(sales[0]),
      chartChange: change ? change.textContent.trim().replace(/[()]/g, '') : null,
      listedMedian: money(lower['listed median']),
      quantity: posInt(lower['current quantity']),
      sellers: posInt(lower['current sellers']),
    };
  }

  function waitForListings(timeoutMs = 20000) {
    return new Promise((resolve) => {
      if (readListings().length) {
        resolve(readListings());
        return;
      }

      const start = Date.now();
      const obs = new MutationObserver(() => {
        if (readListings().length) {
          obs.disconnect();
          resolve(readListings());
        } else if (Date.now() - start > timeoutMs) {
          obs.disconnect();
          resolve([]);
        }
      });

      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => {
        obs.disconnect();
        resolve(readListings());
      }, timeoutMs);
    });
  }

  // The price-points panel (Market Price etc.) renders separately from listings,
  // usually a beat later. Resolve once it has a real value, or on timeout.
  function waitForMarket(timeoutMs = 15000) {
    const ready = () => {
      const el = document.querySelector('.price-points__upper__price');
      return el && /\d/.test(el.textContent);
    };
    return new Promise((resolve) => {
      if (ready()) {
        resolve();
        return;
      }

      const start = Date.now();
      const obs = new MutationObserver(() => {
        if (ready() || Date.now() - start > timeoutMs) {
          obs.disconnect();
          resolve();
        }
      });

      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => {
        obs.disconnect();
        resolve();
      }, timeoutMs);
    });
  }

  (async () => {
    // Listings and the price-points panel render separately and often at
    // different times — wait for BOTH (concurrently) before scraping, so we
    // don't capture a null market price (which also stalls the trend windows).
    const [listings] = await Promise.all([waitForListings(), waitForMarket()]);
    const market = scrapeMarket();

    // If the extension was reloaded/updated while this tab stayed open, this
    // (old) content script's context is invalidated and chrome.runtime is gone.
    // Guard + swallow it: harmless, and the next alarm-driven reload injects a
    // fresh content script with a live context.
    try {
      if (chrome.runtime && chrome.runtime.id) {
        await chrome.runtime.sendMessage({
          type: 'scrape',
          url: location.href,
          listings,
          market,
        });
      }
    } catch (e) {
      // context invalidated or no receiver — ignore.
    }
  })();
})();

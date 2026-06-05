// content.js — runs in each TCGplayer product page. Its ONLY job is to scrape
// the rendered DOM and report to the service worker. It schedules nothing;
// the worker's alarm drives the cadence. Kept as a single standalone file
// because content scripts can't cleanly import ES modules.

(function () {
  // DOM contract with TCGplayer. If their markup changes, update these.
  const SELECTORS = {
    listingItem: '.listing-item',
    listingPrice: '.listing-item__listing-data__info__price',
    sellerName: '.seller-info__name',
    sellerInfo: '.seller-info',
    sellerRating: '.seller-info__rating',
    sellerSales: '.seller-info__sales',
    sellerBadge: '.seller-info__content img[alt]',
    upperPrice: '.price-points__upper__price',
    salesPrice: '.sales-data__price',
    chartsChange: '.charts-change',
    lowerLabel: '.price-points__lower .text',
    lowerValue: '.price-points__lower .price-points__lower__price',
  };

  // Lower-panel row labels (lowercased, trailing colon stripped).
  const LABEL = {
    listedMedian: 'listed median',
    currentQuantity: 'current quantity',
    currentSellers: 'current sellers',
  };

  const TIMEOUT = {
    listingsMs: 20000,
    marketMs: 15000,
  };

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

    document.querySelectorAll(SELECTORS.listingItem).forEach((li) => {
      const priceEl = li.querySelector(SELECTORS.listingPrice);
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

      const sellerEl = li.querySelector(SELECTORS.sellerName);

      // Seller trust signals (rating %, lifetime sales, badges like Gold Star /
      // Direct). Each is best-effort — missing fields stay null so a partial
      // render never blanks the price line.
      const infoEl = li.querySelector(SELECTORS.sellerInfo);
      let rating = null;
      let sales = null;
      let badges = [];
      if (infoEl) {
        const ratingEl = infoEl.querySelector(SELECTORS.sellerRating);
        if (ratingEl) {
          const rm = (ratingEl.textContent || '').match(/(\d+(?:\.\d+)?)/);
          if (rm) {
            rating = parseFloat(rm[1]);
          }
        }
        const salesEl = infoEl.querySelector(SELECTORS.sellerSales);
        if (salesEl) {
          const sm = (salesEl.textContent || '').replace(/,/g, '').match(/(\d+)/);
          if (sm) {
            sales = parseInt(sm[1], 10);
          }
        }
        badges = Array.from(infoEl.querySelectorAll(SELECTORS.sellerBadge))
          .map((img) => (img.getAttribute('alt') || '').trim())
          .filter(Boolean);
      }

      out.push({
        item,
        shipping,
        total: +(item + shipping).toFixed(2),
        seller: sellerEl ? sellerEl.textContent.trim() : 'Unknown seller',
        rating,
        sales,
        badges,
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

    const upper = document.querySelectorAll(SELECTORS.upperPrice);
    const sales = document.querySelectorAll(SELECTORS.salesPrice);
    const change = document.querySelector(SELECTORS.chartsChange);

    // Lower panel: pair each label (.text) with its value, by document order,
    // into a label-keyed map — more robust than a bare positional index.
    // Labels: "Listed Median:", "Current Quantity:", "Current Sellers:".
    const lower = {};
    const labels = document.querySelectorAll(SELECTORS.lowerLabel);
    const values = document.querySelectorAll(SELECTORS.lowerValue);
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
      listedMedian: money(lower[LABEL.listedMedian]),
      quantity: posInt(lower[LABEL.currentQuantity]),
      sellers: posInt(lower[LABEL.currentSellers]),
    };
  }

  function waitForListings(timeoutMs = TIMEOUT.listingsMs) {
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
  function waitForMarket(timeoutMs = TIMEOUT.marketMs) {
    const ready = () => {
      const el = document.querySelector(SELECTORS.upperPrice);
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

    // Structural signals for the worker's selector-health check: did the page's
    // containers render even though our fields may not have parsed?
    const diag = {
      listingNodes: document.querySelectorAll(SELECTORS.listingItem).length,
      marketPanel: !!document.querySelector(SELECTORS.upperPrice),
      listingsParsed: listings.length,
      marketParsed: market.marketPrice != null,
    };

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
          diag,
        });
      }
    } catch (e) {
      // context invalidated or no receiver — ignore.
    }
  })();
})();

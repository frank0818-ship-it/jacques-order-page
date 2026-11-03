/*
 * Zuppler -> GA4 bridge for order.jacquescatering.com   (v2, 2026-11-03)
 *
 * Adapted from https://zuppler.github.io/online-ordering/analytics/
 * Changes from Zuppler's zuppler-gtm.js:
 *   - sends events with gtag('event', ...) instead of raw dataLayer.push,
 *     because this page runs gtag directly, not Google Tag Manager
 *   - purchase uses the GA4 ecommerce schema (transaction_id/value/items),
 *     not the Universal Analytics actionField/products schema
 *
 * v2 changes (after the first live order produced no purchase event):
 *   - every integration state is forwarded as ordering_<state> with its raw
 *     param keys, so GA4 shows us the real state names this build emits
 *   - purchase is ALSO fired from the receipt/confirmation URL, independent
 *     of the state callback, with a dedupe key in sessionStorage
 *   - money: item-level events arrive in DOLLARS, order totals in CENTS
 *
 * Placement: <script src> in <head>, AFTER the gtag snippet and
 * BEFORE web5.zuppler.com/common.js and order.js.
 * initZupplerBridge must be declared exactly once on the page.
 */
(function () {
  'use strict';

  var CURRENCY = 'USD';
  var DEDUPE_KEY = 'zga4_purchased';

  function warn() { try { console.warn.apply(console, ['[zuppler-ga4]'].concat([].slice.call(arguments))); } catch (_) {} }

  function send(name, params) {
    try {
      if (typeof window.gtag === 'function') {
        window.gtag('event', name, params || {});
      } else {
        window.dataLayer = window.dataLayer || [];
        window.dataLayer.push({ event: name, zuppler: params || {} });
      }
    } catch (e) { warn('send failed', name, e); }
  }

  // Order totals from Zuppler are integer cents.
  function cents(n) { n = Number(n); return isNaN(n) ? 0 : Math.round(n) / 100; }
  // Item-level prices on item:view / item:added arrive already in dollars.
  function dollars(n) { n = Number(n); return isNaN(n) ? 0 : Math.round(n * 100) / 100; }
  function str(v) { return v == null ? '' : String(v); }

  function pick(obj, keys) {
    var out = {};
    if (!obj) return out;
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (obj[k] != null && typeof obj[k] !== 'object') out[k] = obj[k];
    }
    return out;
  }

  function buildItems(order) {
    var items = [];
    var carts = (order && order.carts) || [];
    if (!Array.isArray(carts)) carts = [carts];
    carts.forEach(function (cart) {
      ((cart && cart.items) || []).forEach(function (it) {
        if (!it) return;
        var qty = Number(it.quantity) || 1;
        items.push({
          item_id: str(it.id || it.item_id),
          item_name: str(it.name),
          item_category: str(it.category),
          quantity: qty,
          price: cents(it.item_total || it.total || 0) / qty
        });
      });
    });
    return items;
  }

  function alreadySent(id) {
    try { return id && window.sessionStorage.getItem(DEDUPE_KEY) === id; } catch (_) { return false; }
  }
  function markSent(id) {
    try { if (id) window.sessionStorage.setItem(DEDUPE_KEY, id); } catch (_) {}
  }

  function measurePurchase(order, via) {
    if (!order) return;
    var id = str(order.uuid || order.id || order.order_id);
    if (alreadySent(id)) return;
    var totals = order.totals || order;
    send('purchase', {
      transaction_id: id,
      affiliation: 'Zuppler Online Ordering',
      currency: CURRENCY,
      value: cents(totals.total),
      tax: cents(totals.tax),
      shipping: cents(totals.delivery || totals.delivery_fee),
      service_fee: cents(totals.service),
      zuppler_via: via || 'state',
      items: buildItems(order)
    });
    markSent(id);
  }

  // ---- integration state listener -------------------------------------
  function onIntegrationChanged(type, params) {
    params = params || {};
    var t = str(type);
    var ev = 'ordering_' + t.replace(/[^a-z0-9]+/gi, '_');

    // Always forward the raw state so GA4 shows every name this build emits.
    send(ev, pick(params, ['restaurant_id', 'name', 'id', 'category', 'quantity', 'price', 'type', 'payment_type', 'total', 'uuid']));

    if (/item.?added/i.test(t)) {
      send('add_to_cart', {
        currency: CURRENCY,
        value: dollars(params.price) * (Number(params.quantity) || 1),
        items: [{
          item_id: str(params.id),
          item_name: str(params.name),
          item_category: str(params.category),
          price: dollars(params.price),
          quantity: Number(params.quantity) || 1
        }]
      });
    } else if (/cart|checkout/i.test(t) && !/new/i.test(t)) {
      send('begin_checkout', { currency: CURRENCY, zuppler_state: t });
    } else if (/payment/i.test(t)) {
      send('add_payment_info', { currency: CURRENCY, payment_type: str(params.type || params.payment_type), zuppler_state: t });
    } else if (/receipt|complete|confirm|placed|success/i.test(t)) {
      try { measurePurchase(params.details || params.order || params, 'state:' + t); }
      catch (e) { warn('purchase failed', e); }
    }
  }

  // ---- URL fallback: receipt / confirmation route ----------------------
  // Zuppler routes in the hash: #/restaurants/<slug>/<id>/receipt/<uuid>
  // or .../orders/<uuid>. If the state callback never fires, this does.
  var RECEIPT_RE = /\/(receipt|orders?|confirmation|thank-?you)\/([A-Za-z0-9-]+)/i;

  function tryUrlPurchase() {
    var m = RECEIPT_RE.exec(window.location.hash || '') || RECEIPT_RE.exec(window.location.pathname || '');
    if (!m) return;
    var uuid = m[2];
    if (alreadySent(uuid)) return;
    // Best-effort read of the on-page total; falls back to 0 so the event
    // still lands with the transaction_id and can be reconciled.
    var total = 0, tax = 0;
    try {
      var txt = document.body.innerText || '';
      var mt = /Total[:\s]*\$?\s*([\d,]+\.\d{2})/i.exec(txt);
      var mx = /Tax[:\s]*\$?\s*([\d,]+\.\d{2})/i.exec(txt);
      if (mt) total = parseFloat(mt[1].replace(/,/g, ''));
      if (mx) tax = parseFloat(mx[1].replace(/,/g, ''));
    } catch (_) {}
    send('purchase', {
      transaction_id: uuid,
      affiliation: 'Zuppler Online Ordering',
      currency: CURRENCY,
      value: total,
      tax: tax,
      zuppler_via: 'url',
      items: []
    });
    markSent(uuid);
  }

  window.addEventListener('hashchange', function () { setTimeout(tryUrlPurchase, 1500); });
  if (document.readyState === 'complete') setTimeout(tryUrlPurchase, 1500);
  else window.addEventListener('load', function () { setTimeout(tryUrlPurchase, 1500); });

  // ---- register with Zuppler ------------------------------------------
  if (typeof window.initZupplerBridge === 'function') {
    warn('initZupplerBridge already defined; not redefining');
    return;
  }
  window.initZupplerBridge = function (api) {
    try { api.addIntegrationStateListener(onIntegrationChanged); }
    catch (e) { warn('listener registration failed', e); }
    return Promise.resolve(true);
  };
})();

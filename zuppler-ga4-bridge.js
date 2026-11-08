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
 * v3 changes (2026-11-08, after the Nov 6-7 orders):
 *   - purchase fires only on receipt/order-complete states; "signup:confirm:start"
 *     had matched /confirm/ and created two fake $0 purchases with no order id
 *   - a purchase is never sent without an order id
 *   - value: tries several total fields; if none, reads the total off the
 *     receipt page after 4s (2 of 6 real orders had landed at $0)
 *   - adds zuppler_value_src / zuppler_total_keys params for diagnosis
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

  // Read "Total: $123.45" / "Tax: $1.23" off the rendered receipt page.
  function scrapeTotals() {
    var out = { total: 0, tax: 0 };
    try {
      var txt = document.body.innerText || '';
      var mt = /(?:^|[^a-z])Total[:\s]*\$?\s*([\d,]+\.\d{2})/i.exec(txt);
      var mx = /(?:^|[^a-z])Tax[:\s]*\$?\s*([\d,]+\.\d{2})/i.exec(txt);
      if (mt) out.total = parseFloat(mt[1].replace(/,/g, ''));
      if (mx) out.tax = parseFloat(mx[1].replace(/,/g, ''));
    } catch (_) {}
    return out;
  }

  // First non-empty money field (Zuppler order totals are integer cents).
  function firstCents(objs, keys) {
    for (var i = 0; i < objs.length; i++) {
      var o = objs[i]; if (!o) continue;
      for (var j = 0; j < keys.length; j++) {
        var v = Number(o[keys[j]]);
        if (!isNaN(v) && v > 0) return { value: cents(v), src: keys[j] };
      }
    }
    return { value: 0, src: '' };
  }

  function measurePurchase(order, via) {
    if (!order) return;
    var id = str(order.uuid || order.id || order.order_id);
    // v3: never send a purchase without an order id (Nov 6: signup states
    // produced two id-less $0 purchases).
    if (!id) { send('ordering_purchase_skipped', { reason: 'no_id', zuppler_via: via || 'state' }); return; }
    if (alreadySent(id)) return;
    markSent(id);
    var totals = order.totals || {};
    var srcs = [totals, order];
    var t = firstCents(srcs, ['total', 'grand_total', 'order_total', 'total_amount']);
    var tax = firstCents(srcs, ['tax', 'taxes', 'tax_total']).value;
    var payload = {
      transaction_id: id,
      affiliation: 'Zuppler Online Ordering',
      currency: CURRENCY,
      value: t.value,
      tax: tax,
      shipping: firstCents(srcs, ['delivery', 'delivery_fee']).value,
      service_fee: firstCents(srcs, ['service', 'service_fee']).value,
      zuppler_via: via || 'state',
      zuppler_value_src: t.src || 'none',
      zuppler_total_keys: Object.keys(totals).concat(Object.keys(order)).join(',').slice(0, 100),
      items: buildItems(order)
    };
    if (payload.value > 0) { send('purchase', payload); return; }
    // v3: total missing from the state payload (Nov 6-7: 2 of 6 orders at $0).
    // Wait for the receipt to render, then read the total off the page.
    setTimeout(function () {
      var s = scrapeTotals();
      payload.value = s.total;
      if (!payload.tax) payload.tax = s.tax;
      payload.zuppler_value_src = s.total > 0 ? 'page' : 'none';
      send('purchase', payload);
    }, 4000);
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
    } else if (/receipt|order.?(complete|placed|success)/i.test(t) && !/signup|profile|login|account/i.test(t)) {
      // v3: was /receipt|complete|confirm|.../ which also matched
      // "signup:confirm:start" and fired fake purchases. Live orders emit "order:receipt".
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
    markSent(uuid);
    var s = scrapeTotals();
    send('purchase', {
      transaction_id: uuid,
      affiliation: 'Zuppler Online Ordering',
      currency: CURRENCY,
      value: s.total,
      tax: s.tax,
      zuppler_via: 'url',
      zuppler_value_src: s.total > 0 ? 'page' : 'none',
      items: []
    });
  }

  // v3: 4s (was 1.5s) so the state callback wins and the receipt has rendered.
  window.addEventListener('hashchange', function () { setTimeout(tryUrlPurchase, 4000); });
  if (document.readyState === 'complete') setTimeout(tryUrlPurchase, 4000);
  else window.addEventListener('load', function () { setTimeout(tryUrlPurchase, 4000); });

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

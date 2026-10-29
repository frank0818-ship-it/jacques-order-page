/*
 * Zuppler -> GA4 bridge for order.jacquescatering.com
 *
 * Adapted from https://zuppler.github.io/online-ordering/analytics/
 * Changes from Zuppler's zuppler-gtm.js:
 *   - sends events with gtag('event', ...) instead of raw dataLayer.push,
 *     because this page runs gtag directly, not Google Tag Manager
 *   - purchase uses the GA4 ecommerce schema (transaction_id/value/items),
 *     not the Universal Analytics actionField/products schema
 *
 * Placement: inline <script> in <head>, AFTER the gtag snippet and
 * BEFORE web5.zuppler.com/common.js and order.js.
 * initZupplerBridge must be declared exactly once on the page.
 */
(function () {
  'use strict';

  var CURRENCY = 'USD';

  function send(name, params) {
    try {
      if (typeof window.gtag === 'function') {
        window.gtag('event', name, params || {});
      } else {
        // gtag not loaded yet or blocked: queue on dataLayer so nothing is lost
        window.dataLayer = window.dataLayer || [];
        window.dataLayer.push({ event: name, zuppler: params || {} });
      }
    } catch (e) {
      try { console.warn('[zuppler-ga4] send failed', name, e); } catch (_) {}
    }
  }

  function cents(n) {
    n = Number(n);
    return isNaN(n) ? 0 : Math.round(n) / 100;
  }

  function str(v) {
    return v == null ? '' : String(v);
  }

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
      var list = (cart && cart.items) || [];
      list.forEach(function (it) {
        if (!it) return;
        items.push({
          item_id: str(it.id),
          item_name: str(it.name),
          item_category: str(it.category),
          quantity: Number(it.quantity) || 1,
          price: cents(it.item_total) / (Number(it.quantity) || 1)
        });
      });
    });
    return items;
  }

  function measurePurchase(order) {
    if (!order) return;
    var totals = order.totals || {};
    send('purchase', {
      transaction_id: str(order.uuid || order.id),
      affiliation: 'Zuppler Online Ordering',
      currency: CURRENCY,
      value: cents(totals.total),
      tax: cents(totals.tax),
      shipping: cents(totals.delivery || totals.delivery_fee),
      service_fee: cents(totals.service),
      items: buildItems(order)
    });
  }

  // Zuppler integration states -> GA4 events
  function onIntegrationChanged(type, params) {
    params = params || {};
    var ev = 'ordering_' + str(type).replace(/[^a-z0-9]+/gi, '_');

    switch (type) {
      case 'portal':
      case 'order:cart':
      case 'dashboard':
        send(ev, {});
        break;

      case 'order':
        send(ev, pick(params, ['restaurant_id', 'restaurant', 'name']));
        break;

      case 'item:view':
        send(ev, pick(params, ['name', 'id', 'category', 'price']));
        break;

      case 'item:added':
        send(ev, pick(params, ['name', 'id', 'category', 'quantity', 'price']));
        send('add_to_cart', {
          currency: CURRENCY,
          value: cents(params.item_total || params.price),
          items: [{
            item_id: str(params.id),
            item_name: str(params.name),
            item_category: str(params.category),
            quantity: Number(params.quantity) || 1
          }]
        });
        break;

      case 'order:payment':
        send(ev, pick(params, ['type', 'payment_type']));
        send('begin_checkout', { currency: CURRENCY });
        break;

      case 'order:receipt':
        send(ev, { order_uuid: str(params.details && params.details.uuid) });
        try {
          measurePurchase(params.details);
        } catch (e) {
          try { console.warn('[zuppler-ga4] purchase failed', e); } catch (_) {}
        }
        break;

      default:
        send(ev, {});
    }
  }

  // Zuppler calls this once order.js initialises, if it is defined.
  if (typeof window.initZupplerBridge === 'function') {
    try { console.warn('[zuppler-ga4] initZupplerBridge already defined; not redefining'); } catch (_) {}
    return;
  }

  window.initZupplerBridge = function (api) {
    try {
      api.addIntegrationStateListener(onIntegrationChanged);
    } catch (e) {
      try { console.warn('[zuppler-ga4] listener registration failed', e); } catch (_) {}
    }
    return Promise.resolve(true);
  };
})();

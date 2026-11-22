/* Order execution, separate from the data feed. Modes: paper only | manual confirm | auto. Brokers: Upstox (built in) or custom webhook.
   EDUCATIONAL TOOL: live execution is OFF by default, starts in DRY-RUN, and needs an explicit acknowledgement. */
(function () {
  const QT = (globalThis.QT = globalThis.QT || {});
  const LS = () => (typeof localStorage !== 'undefined' ? localStorage : { getItem() {}, setItem() {} });
  const tick = (x) => Math.max(0.05, Math.round(x * 20) / 20);

  const B = (QT.Broker = {
    countToday() { try { const j = JSON.parse(LS().getItem('qt_livecount')); return j && j.d === QT.istDate() ? j.n : 0; } catch (e) { return 0; } },
    bump(n) { LS().setItem('qt_livecount', JSON.stringify({ d: QT.istDate(), n: B.countToday() + n })); },

    // legs in sending order: BUY legs first (margin benefit for spreads), then SELL legs
    legs(t, kind) {
      const L = t.legs.map((l) => (kind === 'entry'
        ? { side: l.a === 'B' ? 'BUY' : 'SELL', K: l.K, type: l.t, key: l.key, price: l.fill }
        : { side: l.a === 'B' ? 'SELL' : 'BUY', K: l.K, type: l.t, key: l.key, price: l.exitPx }));
      return L.sort((a, b) => (a.side === b.side ? 0 : a.side === 'BUY' ? -1 : 1));
    },
    payload(S, t, leg) {
      const price = S.orderType === 'LIMIT' ? tick(leg.price) : 0;
      if (S.orderBroker === 'custom') {
        const m = { sym: t.sym, expiry: t.expiry, strike: leg.K, type: leg.type, side: leg.side, qty: t.qty, lots: t.lots, price, key: leg.key || '', ordertype: S.orderType, product: S.product };
        let body = S.webhookBody; Object.entries(m).forEach(([k, v]) => (body = body.split('{' + k + '}').join(String(v))));
        return body;
      }
      return JSON.stringify({ quantity: t.qty, product: S.product, validity: 'DAY', price, tag: 'OptionsDesk', instrument_token: leg.key, order_type: S.orderType, transaction_type: leg.side, disclosed_quantity: 0, trigger_price: 0, is_amo: false });
    },
    guard(S, t, kind, src) {
      if (S.execMode === 'paper') return 'Execution mode is Paper only';
      if (S.mode === 'demo') return 'Demo feed: real orders are blocked (switch the data feed to a live source first)';
      if (!S.liveAck) return 'Live trading not acknowledged in Settings';
      if (S.orderBroker === 'upstox' && !S.brokerToken.trim()) return 'Upstox trading access token missing (Settings > Order execution)';
      if (S.orderBroker === 'custom' && !S.webhookUrl.trim()) return 'Custom order webhook URL missing';
      if (kind === 'entry' && !QT.canTrade(S, src === 'manual' ? 'manual' : 'auto')) return `Outside trading time ${S.tradeStart}-${S.tradeEnd} IST`;
      if (kind === 'exit' && !QT.marketOpen()) return 'Market is closed - exit orders wait for the next session';
      const L = B.legs(t, kind);
      if (L.some((l) => !l.key || String(l.key).startsWith('DEMO'))) return 'A leg has no real instrument key (model price) - cannot place';
      if (L.some((l) => l.price * t.qty > S.maxOrderValue)) return `An order exceeds the max order value ${S.maxOrderValue}`;
      if (B.countToday() + L.length > S.maxLiveOrdersDay) return `Daily live-order cap (${S.maxLiveOrdersDay}) reached`;
      return '';
    },
    preview(S, t, kind) { return B.legs(t, kind).map((l) => `${l.side} ${t.qty} ${t.sym} ${t.expiry} ${l.K} ${l.type} @ ${S.orderType === 'LIMIT' ? tick(l.price) : 'MARKET'}`); },

    async post(S, body) {
      if (S.orderBroker === 'custom') {
        let h = {}; try { h = JSON.parse(S.webhookHeaders || '{}'); } catch (e) {}
        const r = await fetch(S.webhookUrl.trim(), { method: 'POST', headers: h, body });
        const txt = await r.text(); if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + txt.slice(0, 120));
        return txt.slice(0, 60) || 'ok';
      }
      const h = { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Bearer ' + S.brokerToken.trim() };
      if (S.algoId) h['X-Algo-Name'] = S.algoId; // some brokers require an algo id for API orders - check your broker's documentation
      const r = await fetch('https://api.upstox.com/v2/order/place', { method: 'POST', headers: h, body });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.status === 'error') throw new Error((j.errors && j.errors[0] && j.errors[0].message) || 'HTTP ' + r.status);
      return (j.data && j.data.order_id) || 'ok';
    },

    // send all legs of an entry or exit to the broker (or log them in DRY-RUN)
    async send(S, t, kind, src) {
      const why = B.guard(S, t, kind, src);
      const rec = (status, reason, legs) => { QT.Paper.logOrder({ sym: t.sym, stratName: t.stratName, src: 'broker', signal: kind === 'entry' ? 'LIVE ENTRY' : 'LIVE EXIT', lots: t.lots, qty: t.qty, expiry: t.expiry, status, reason, tradeId: t.id, legs: legs || [] }); QT.Paper.save(); };
      const view = B.legs(t, kind).map((l) => ({ a: l.side === 'BUY' ? 'B' : 'S', t: l.type, K: l.K, px: tick(l.price) }));
      if (why) { rec('BLOCKED', why, view); return { ok: false, msg: why }; }
      if (S.dryRun) { if (kind === 'entry') { t.dry = true; QT.Paper.save(); } rec('DRY-RUN', 'Not sent (Dry run is ON): ' + B.preview(S, t, kind).join(' | '), view); return { ok: true, dry: true }; }
      const ids = [];
      for (const l of B.legs(t, kind)) {
        try { ids.push(await B.post(S, B.payload(S, t, l))); B.bump(1); }
        catch (e) { rec('FAILED', `Leg ${l.side} ${l.K}${l.type}: ${e.message}. ${ids.length} leg(s) already sent - check your broker app!`, view); if (QT.Alerts) QT.Alerts.add(S, 'ERROR', t.sym, `Broker order failed (${kind}): ${e.message}. ${ids.length} leg(s) already sent.`); return { ok: false, msg: e.message, partial: ids.length }; }
      }
      rec('SENT', 'Broker order id(s): ' + ids.join(', '), view);
      if (kind === 'entry') { t.live = true; t.brokerIds = ids; } else t.liveExitIds = ids;
      QT.Paper.save();
      return { ok: true, ids };
    },
  });
})();

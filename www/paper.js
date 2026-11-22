/* Paper broker: order book, positions, margin, charges, MTM at liquidation value, auto exits, history register */
(function () {
  const QT = (globalThis.QT = globalThis.QT || {});
  const r2 = (x) => Math.round(x * 100) / 100;
  const LS = () => (typeof localStorage !== 'undefined' ? localStorage : { getItem() {}, setItem() {} });
  const pad = (n, w) => String(n).padStart(w, '0');

  const P = (QT.Paper = {
    st: { seq: 0, oseq: 0, realized: 0, trades: [], orders: [], curve: [], capital: null },
    load() { try { const j = JSON.parse(LS().getItem('qt_paper2')); if (j) P.st = { ...P.st, ...j }; } catch (e) {} },
    save() { try { LS().setItem('qt_paper2', JSON.stringify(P.st)); } catch (e) {} },
    reset(cap) { P.st = { seq: 0, oseq: 0, realized: 0, trades: [], orders: [], curve: [], capital: cap }; P.save(); },
    open() { return P.st.trades.filter((t) => t.status === 'OPEN'); },
    closed() { return P.st.trades.filter((t) => t.status !== 'OPEN'); },

    charges(fills, S) {
      if (!S.charges) return 0;
      let b = 0, sell = 0, buy = 0, tot = 0;
      fills.forEach((f) => { const v = f.price * f.qty; tot += v; b += S.brokerage; f.side === 'S' ? (sell += v) : (buy += v); });
      const exch = tot * 0.0003503, sebi = tot * 0.000001, stt = sell * S.sttPct, stamp = buy * 0.00003, gst = 0.18 * (b + exch + sebi);
      return r2(b + exch + sebi + stt + stamp + gst);
    },
    unrealized() { return r2(P.open().reduce((s, t) => s + (t.pnlGross || 0) - t.chEntry, 0)); },
    margin() { return P.open().reduce((s, t) => s + t.margin, 0); },
    cap(S) { return P.st.capital ?? S.capital; },
    equity(S) { return r2(P.cap(S) + P.st.realized + P.unrealized()); },
    available(S) { return r2(P.cap(S) + P.st.realized - P.margin()); },

    logOrder(o) { const rec = { id: 'ORD-' + pad(++P.st.oseq, 5), time: new Date().toISOString(), ...o }; P.st.orders.unshift(rec); if (P.st.orders.length > 800) P.st.orders.pop(); return rec; },

    // place an order (always logged). src: 'auto' | 'manual'
    enter(row, S, spots, src, meta) {
      meta = meta || {};
      if (P.st.capital == null) P.st.capital = S.capital;
      const base = { sym: row.sym, stratName: row.stratName, src, lots: row.lots, qty: row.qty, expiry: row.expiry, conviction: row.conviction, signal: row.decision, candle: meta.candle || null,
        legs: row.legs.map((l) => ({ a: l.a, t: l.t, K: l.K, px: l.p })) };
      const reject = (reason) => { P.logOrder({ ...base, status: 'REJECTED', reason }); P.save(); return { ok: false, msg: reason }; };
      if (!QT.canTrade(S, src)) return reject(`Outside trading time ${S.tradeStart}-${S.tradeEnd} IST`);
      if (!S.allowDup && P.open().some((t) => t.sym === row.sym)) return reject('Position already open in ' + row.sym);
      if (P.open().length >= S.maxOpen) return reject('Max open positions (' + S.maxOpen + ') reached');
      const slip = S.slipPct;
      const legs = row.legs.map((l) => ({ a: l.a, t: l.t, K: l.K, key: l.key, fill: r2(l.a === 'B' ? l.p * (1 + slip) : l.p * (1 - slip)) }));
      const net = r2(legs.reduce((s, l) => s + (l.a === 'B' ? l.fill : -l.fill), 0));
      const margin = Math.round(net > 0 ? net * row.qty : row.maxLoss * row.qty);
      if (margin > P.available(S)) return reject(`Insufficient funds: margin ${margin} > available ${Math.round(P.available(S))}`);
      const ch = P.charges(legs.map((l) => ({ side: l.a, price: l.fill, qty: row.qty })), S);
      const tid = 'T-' + pad(++P.st.seq, 4);
      const o = P.logOrder({ ...base, status: 'COMPLETE', reason: '', tradeId: tid, fillNet: net, legs: legs.map((l) => ({ a: l.a, t: l.t, K: l.K, px: l.fill })) });
      const t = {
        id: tid, orderId: o.id, time: o.time, sym: row.sym, signal: row.decision, conviction: row.conviction, strat: row.strat, stratName: row.stratName, bias: row.bias,
        lots: row.lots, qty: row.qty, lot: row.lot, expiry: row.expiry, exitBy: row.exitBy, legs, net, margin, chEntry: ch, entrySpot: spots[row.sym],
        targetSpot: row.targetSpot, slSpot: row.slSpot, tpPnl: row.tpPnl, slPnl: row.slPnl, src: row.src, origin: src, candle: meta.candle || null,
        status: 'OPEN', pnlGross: 0, curSpot: spots[row.sym], val: net, why: row.verdict || '',
      };
      P.st.trades.unshift(t); P.save();
      return { ok: true, trade: t, order: o };
    },

    value(t, chain) {
      let v = 0;
      for (const l of t.legs) {
        const q = chain && chain.get(l.K) && chain.get(l.K)[l.t];
        if (!q) return null;
        const px = l.a === 'B' ? (q.bid > 0 ? q.bid : q.ltp) : q.ask > 0 ? q.ask : q.ltp;
        v += l.a === 'B' ? px || 0 : -(px || 0);
      }
      return v;
    },

    // spots = live prices; sig = last CLOSED candle closes (used for spot SL/target when S.closeExit)
    markAll(S, spots, chains, today, sig) {
      const out = [];
      for (const t of P.open()) {
        const ch = chains[t.sym + '|' + t.expiry], v = P.value(t, ch);
        if (spots[t.sym]) t.curSpot = spots[t.sym];
        if (v != null) { t.val = r2(v); t.pnlGross = r2((v - t.net) * t.qty); }
        const sp = S.closeExit && sig && sig[t.sym] ? sig[t.sym] : t.curSpot;
        const pps = t.val - t.net;
        let why = null;
        if (v != null) { if (pps >= t.tpPnl) why = 'TARGET HIT'; else if (pps <= t.slPnl) why = 'SL HIT'; }
        if (!why && t.targetSpot) {
          if (t.bias === 'U') why = sp >= t.targetSpot ? 'TARGET HIT' : sp <= t.slSpot ? 'SL HIT' : null;
          else if (t.bias === 'D') why = sp <= t.targetSpot ? 'TARGET HIT' : sp >= t.slSpot ? 'SL HIT' : null;
        }
        if (!why && today >= t.exitBy) why = 'EXIT-BY';
        if (!why && today >= t.expiry) why = 'EXPIRED';
        if (why && v != null && QT.marketOpen()) { P.close(t, why, S, ch); out.push(t); }
      }
      P.st.curve.push([Date.now(), P.equity(S)]); if (P.st.curve.length > 600) P.st.curve.shift();
      P.save();
      return out;
    },

    close(t, why, S, chain) {
      const fills = t.legs.map((l) => {
        const q = chain.get(l.K)[l.t];
        const px = l.a === 'B' ? (q.bid > 0 ? q.bid : q.ltp) : q.ask > 0 ? q.ask : q.ltp;
        l.exitPx = r2(Math.max(0.05, l.a === 'B' ? px * (1 - S.slipPct) : px * (1 + S.slipPct)));
        return { side: l.a === 'B' ? 'S' : 'B', price: l.exitPx, qty: t.qty };
      });
      const exitVal = t.legs.reduce((s, l) => s + (l.a === 'B' ? l.exitPx : -l.exitPx), 0);
      t.chExit = P.charges(fills, S);
      t.pnlGross = r2((exitVal - t.net) * t.qty);
      t.pnl = r2(t.pnlGross - t.chEntry - t.chExit);
      t.exitNet = r2(exitVal);
      t.status = why; t.exitTime = new Date().toISOString(); t.exitSpot = t.curSpot;
      P.logOrder({ sym: t.sym, stratName: t.stratName, src: why === 'MANUAL' ? 'manual' : 'auto-exit', lots: t.lots, qty: t.qty, expiry: t.expiry, signal: 'EXIT', status: 'COMPLETE', reason: why, tradeId: t.id,
        legs: t.legs.map((l) => ({ a: l.a === 'B' ? 'S' : 'B', t: l.t, K: l.K, px: l.exitPx })), fillNet: r2(-exitVal) });
      P.st.realized = r2(P.st.realized + t.pnl); P.save();
    },

    stats() {
      const c = P.closed(), W = c.filter((t) => t.pnl > 0), L = c.filter((t) => t.pnl <= 0);
      const gw = W.reduce((s, t) => s + t.pnl, 0), gl = -L.reduce((s, t) => s + t.pnl, 0);
      let eq = 0, pk = 0, dd = 0;
      [...c].sort((a, b) => a.exitTime.localeCompare(b.exitTime)).forEach((t) => { eq += t.pnl; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); });
      return { total: P.st.trades.length, open: P.open().length, closed: c.length, wins: W.length, losses: L.length, winRate: c.length ? (100 * W.length) / c.length : 0,
        avgWin: W.length ? gw / W.length : 0, avgLoss: L.length ? -gl / L.length : 0, pf: gl ? gw / gl : gw ? Infinity : 0, maxDD: dd,
        charges: r2(P.st.trades.reduce((s, t) => s + (t.chEntry || 0) + (t.chExit || 0), 0)) };
    },
    daywise() {
      const m = {};
      P.closed().forEach((t) => { const d = t.exitTime.slice(0, 10); m[d] = m[d] || { d, n: 0, pnl: 0 }; m[d].n++; m[d].pnl = r2(m[d].pnl + t.pnl); });
      return Object.values(m).sort((a, b) => b.d.localeCompare(a.d));
    },
    csv() {
      const h = 'trade_id,order_id,open_time,close_time,symbol,strategy,origin,signal,conviction,lots,qty,expiry,legs(entry),entry_net,exit_net,status,gross_pnl,charges,net_pnl';
      const rows = P.st.trades.map((t) => [t.id, t.orderId, t.time, t.exitTime || '', t.sym, t.stratName, t.origin, t.signal, t.conviction, t.lots, t.qty, t.expiry,
        '"' + t.legs.map((l) => `${l.a}${l.K}${l.t}@${l.fill}`).join(' ') + '"', t.net, t.exitNet ?? '', t.status, t.pnlGross ?? '', (t.chEntry || 0) + (t.chExit || 0), t.pnl ?? ''].join(','));
      return [h, ...rows].join('\n');
    },
  });
})();

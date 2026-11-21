/* Paper trading: fills at bid/ask (+slippage), margin, charges, MTM at liquidation value, auto exits */
(function () {
  const QT = (globalThis.QT = globalThis.QT || {});
  const r2 = (x) => Math.round(x * 100) / 100;
  const LS = () => (typeof localStorage !== 'undefined' ? localStorage : { getItem() {}, setItem() {} });

  const P = (QT.Paper = {
    st: { seq: 0, realized: 0, trades: [], curve: [], capital: null },
    load() { try { const j = JSON.parse(LS().getItem('qt_paper')); if (j) P.st = j; } catch (e) {} },
    save() { try { LS().setItem('qt_paper', JSON.stringify(P.st)); } catch (e) {} },
    reset(cap) { P.st = { seq: 0, realized: 0, trades: [], curve: [], capital: cap }; P.save(); },
    open() { return P.st.trades.filter((t) => t.status === 'OPEN'); },
    closed() { return P.st.trades.filter((t) => t.status !== 'OPEN'); },

    // statutory-style charges (approximate; configurable)
    charges(fills, S) {
      if (!S.charges) return 0;
      let b = 0, sell = 0, buy = 0, tot = 0;
      fills.forEach((f) => { const v = f.price * f.qty; tot += v; b += S.brokerage; f.side === 'S' ? (sell += v) : (buy += v); });
      const exch = tot * 0.0003503, sebi = tot * 0.000001, stt = sell * S.sttPct, stamp = buy * 0.00003, gst = 0.18 * (b + exch + sebi);
      return r2(b + exch + sebi + stt + stamp + gst);
    },
    unrealized() { return r2(P.open().reduce((s, t) => s + (t.pnlGross || 0) - t.chEntry, 0)); },
    margin() { return P.open().reduce((s, t) => s + t.margin, 0); },
    equity(S) { return r2((P.st.capital ?? S.capital) + P.st.realized + P.unrealized()); },
    available(S) { return r2((P.st.capital ?? S.capital) + P.st.realized - P.margin()); },

    // open a paper trade from a dashboard row
    enter(row, S, spots) {
      if (!QT.marketOpen() && !S.allowOffHours && S.mode === 'live') return { ok: false, msg: 'Market closed' };
      if (P.st.capital == null) P.st.capital = S.capital;
      if (!S.allowDup && P.open().some((t) => t.sym === row.sym)) return { ok: false, msg: 'Already open: ' + row.sym };
      if (P.open().length >= S.maxOpen) return { ok: false, msg: 'Max open trades reached' };
      const slip = S.slipPct;
      const legs = row.legs.map((l) => ({ a: l.a, t: l.t, K: l.K, key: l.key, fill: r2(l.a === 'B' ? l.p * (1 + slip) : l.p * (1 - slip)) }));
      const net = r2(legs.reduce((s, l) => s + (l.a === 'B' ? l.fill : -l.fill), 0));
      const margin = Math.round(net > 0 ? net * row.qty : row.maxLoss * row.qty);
      if (margin > P.available(S)) return { ok: false, msg: 'Insufficient margin (need ' + margin + ')' };
      const ch = P.charges(legs.map((l) => ({ side: l.a, price: l.fill, qty: row.qty })), S);
      const t = {
        id: 'PT-' + String(++P.st.seq).padStart(4, '0'), time: new Date().toISOString(), sym: row.sym, signal: row.decision,
        conviction: row.conviction, strat: row.strat, stratName: row.stratName, bias: row.bias, lots: row.lots, qty: row.qty, lot: row.lot,
        expiry: row.expiry, exitBy: row.exitBy, legs, net, margin, chEntry: ch, entrySpot: spots[row.sym],
        targetSpot: row.targetSpot, slSpot: row.slSpot, tpPnl: row.tpPnl, slPnl: row.slPnl, src: row.src,
        status: 'OPEN', pnlGross: -0, curSpot: spots[row.sym], val: net,
      };
      P.st.trades.unshift(t); P.save();
      return { ok: true, trade: t };
    },

    // liquidation value per share: long legs at bid, short legs at ask (fallback ltp)
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
    exitFills(t, v) { return t.legs.map((l) => ({ side: l.a === 'B' ? 'S' : 'B', price: Math.abs(l.exitPx ?? 0.05), qty: t.qty })); },

    // mark all open trades & trigger exits. spots: {sym:price}; chains: {sym|expiry: Map}
    markAll(S, spots, chains, today) {
      const out = [];
      for (const t of P.open()) {
        const v = P.value(t, chains[t.sym + '|' + t.expiry]);
        if (spots[t.sym]) t.curSpot = spots[t.sym];
        if (v != null) { t.val = r2(v); t.pnlGross = r2((v - t.net) * t.qty); }
        const pps = (t.val - t.net);
        let why = null;
        if (v != null) {
          if (pps >= t.tpPnl) why = 'TARGET HIT'; else if (pps <= t.slPnl) why = 'SL HIT';
        }
        if (!why && t.bias === 'U' && t.curSpot >= t.targetSpot) why = 'TARGET HIT';
        else if (!why && t.bias === 'U' && t.curSpot <= t.slSpot) why = 'SL HIT';
        else if (!why && t.bias === 'D' && t.curSpot <= t.targetSpot) why = 'TARGET HIT';
        else if (!why && t.bias === 'D' && t.curSpot >= t.slSpot) why = 'SL HIT';
        if (!why && today >= t.exitBy) why = 'EXIT-BY';
        if (!why && today >= t.expiry) why = 'EXPIRED';
        if (why && v != null) { P.close(t, why, S, chains[t.sym + '|' + t.expiry]); out.push(t); }
      }
      const eq = P.equity(S);
      P.st.curve.push([Date.now(), eq]); if (P.st.curve.length > 500) P.st.curve.shift();
      P.save();
      return out;
    },

    close(t, why, S, chain) {
      const fills = t.legs.map((l) => {
        const q = chain.get(l.K)[l.t];
        const px = l.a === 'B' ? (q.bid > 0 ? q.bid : q.ltp) : q.ask > 0 ? q.ask : q.ltp;
        const adj = l.a === 'B' ? px * (1 - S.slipPct) : px * (1 + S.slipPct);
        l.exitPx = r2(Math.max(0.05, adj));
        return { side: l.a === 'B' ? 'S' : 'B', price: l.exitPx, qty: t.qty };
      });
      const exitVal = t.legs.reduce((s, l) => s + (l.a === 'B' ? l.exitPx : -l.exitPx), 0);
      t.chExit = P.charges(fills, S);
      t.pnlGross = r2((exitVal - t.net) * t.qty);
      t.pnl = r2(t.pnlGross - t.chEntry - t.chExit);
      t.status = why; t.exitTime = new Date().toISOString(); t.exitSpot = t.curSpot;
      P.st.realized = r2(P.st.realized + t.pnl); P.save();
    },

    stats() {
      const c = P.closed(), w = c.filter((t) => t.pnl > 0).length;
      return { total: P.st.trades.length, open: P.open().length, closed: c.length, wins: w, losses: c.length - w, winRate: c.length ? (100 * w) / c.length : 0 };
    },
  });
})();

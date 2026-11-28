/* Paper broker: order book, positions, margin, charges, MTM at liquidation value, auto exits, history register */
(function () {
  const QT = (globalThis.QT = globalThis.QT || {});
  const r2 = (x) => Math.round(x * 100) / 100;
  const LS = () => (typeof localStorage !== 'undefined' ? localStorage : { getItem() {}, setItem() {} });
  const pad = (n, w) => String(n).padStart(w, '0');

  const P = (QT.Paper = {
    st: { seq: 0, oseq: 0, realized: 0, trades: [], orders: [], curve: [], capital: null },
    load() { try { const j = JSON.parse(LS().getItem('qt_paper2')); if (j) P.st = { ...P.st, ...j }; } catch (e) {} P.st.locks = P.st.locks || {}; },
    save() { try { LS().setItem('qt_paper2', JSON.stringify(P.st)); } catch (e) {} },
    reset(cap) { P.st = { seq: 0, oseq: 0, realized: 0, trades: [], orders: [], curve: [], capital: cap, locks: {} }; P.save(); },
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

    todayRealized() {
      const d = QT.istDate();
      return r2(P.closed().filter((t) => t.exitTime && new Date(new Date(t.exitTime).getTime() + 19800000).toISOString().slice(0, 10) === d).reduce((x, t) => x + t.pnl, 0));
    },
    // money management: lots from risk budget (scaled by conviction) within margin caps - "AI" sizing; or the workbook's profit-goal lots
    sizeInfo(row, S) {
      const eq = P.equity(S), lot = row.lot;
      const lossPerLot = Math.max(0.05, Math.abs(row.slPnl)) * lot, marginPerLot = Math.max(1, (row.debit ? row.net : row.maxLoss) * lot);
      const room = Math.min(eq * S.marginPerTradePct, eq * S.maxUtilPct - P.margin(), P.available(S));
      const byMargin = Math.floor(room / marginPerLot), budget = eq * S.riskPct * (0.5 + (row.conviction || 50) / 100), byRisk = Math.floor(budget / lossPerLot);
      const exact = S.strictBook || S.sizing === 'workbook'; // book sizing: lots = ROUNDUP(profit goal / (lot x profit per share)); never resized
      const lots = exact ? (byMargin >= row.lots ? row.lots : 0) : Math.max(0, Math.min(byRisk, byMargin, S.maxLots));
      return { lots, byRisk, byMargin, wb: row.lots, budget: Math.round(budget), lossPerLot: Math.round(lossPerLot), mode: exact ? 'workbook' : 'ai', need: Math.round(marginPerLot * row.lots) };
    },
    sizeLots(row, S) { return P.sizeInfo(row, S).lots; },

    // place an order (always logged). src: 'auto' | 'manual'
    enter(row, S, spots, src, meta) {
      meta = meta || {};
      if (P.st.capital == null) P.st.capital = S.capital;
      const base = { sym: row.sym, stratName: row.stratName, src, lots: row.lots, qty: row.qty, expiry: row.expiry, conviction: row.conviction, signal: row.decision, candle: meta.candle || null,
        legs: row.legs.map((l) => ({ a: l.a, t: l.t, K: l.K, px: l.p })) };
      const reject = (reason) => { P.logOrder({ ...base, status: 'REJECTED', reason }); P.save(); return { ok: false, msg: reason }; };
      if (!QT.canTrade(S, src)) return reject(QT.isWeekday() && !QT.dayAllowed(S) ? `${QT.dayName(QT.istNow().getUTCDay())} is not enabled for new orders (Settings > Trading days)` : `Outside trading time ${S.tradeStart}-${S.tradeEnd} IST`);
      if (P.open().some((t) => t.sym === row.sym)) return reject('One symbol - one order: a position is already open in ' + row.sym);
      const lk = P.lockedFor(row, S);
      if (lk) return reject(`Re-entry locked: ${row.sym} already hit ${lk.why} (${lk.since.slice(0, 16).replace('T', ' ')}). Same-direction order waits until the trend reverses`);
      if ((P.st.locks || {})[row.sym] && S.reentryLock !== 'off') delete P.st.locks[row.sym]; // opposite-direction signal = reversal
      if (P.open().length >= S.maxOpen) return reject('Max open positions (' + S.maxOpen + ') reached');
      if (S.quoteGuard && row.legs.every((l) => l.src === 'LIVE')) {
        const bad = row.legs.find((l) => Math.abs(l.p - l.model) > 0.6 * Math.max(l.model, 1));
        if (bad) return reject(`Quote check: ${bad.t} ${bad.K} price ${bad.p} is far from fair value ${bad.model.toFixed(2)} (stale or empty order book) - order not placed`);
      }
      const eq = P.equity(S), day = QT.istDate();
      if (P.st.trades.filter((t) => t.entryDay === day).length >= S.maxTradesPerDay) return reject('Max trades per day (' + S.maxTradesPerDay + ') reached');
      if (P.todayRealized() <= -eq * S.dailyLossPct) return reject(`Daily loss limit (${(S.dailyLossPct * 100).toFixed(1)}% of capital) reached - no new orders today`);
      const sz = P.sizeInfo(row, S), lots = sz.lots;
      if (lots < 1) return reject(sz.mode === 'workbook' ? `Capital limits: the book lots (${sz.wb}) need margin ${sz.need} but only ${Math.round(Math.min(eq * S.marginPerTradePct, eq * S.maxUtilPct - P.margin(), P.available(S)))} is allowed (free ${Math.round(P.available(S))}) - lots are never reduced` : `Capital limits: no room for 1 lot (free margin ${Math.round(P.available(S))}, utilisation cap ${(S.maxUtilPct * 100).toFixed(0)}%, per-trade cap ${(S.marginPerTradePct * 100).toFixed(0)}%, risk ${(S.riskPct * 100).toFixed(1)}%)`);
      const qty = lots * row.lot; base.lots = lots; base.qty = qty;
      const slip = S.slipPct;
      const legs = row.legs.map((l) => ({ a: l.a, t: l.t, K: l.K, key: l.key, fill: r2(l.a === 'B' ? l.p * (1 + slip) : l.p * (1 - slip)) }));
      const net = r2(legs.reduce((x, l) => x + (l.a === 'B' ? l.fill : -l.fill), 0));
      const margin = Math.round(net > 0 ? net * qty : row.maxLoss * qty);
      if (margin > P.available(S)) return reject(`Insufficient funds: margin ${margin} > available ${Math.round(P.available(S))}`);
      const ch = P.charges(legs.map((l) => ({ side: l.a, price: l.fill, qty })), S);
      const tid = 'PT-' + pad(++P.st.seq, 4);
      const o = P.logOrder({ ...base, status: 'COMPLETE', reason: '', tradeId: tid, fillNet: net, legs: legs.map((l) => ({ a: l.a, t: l.t, K: l.K, px: l.fill })) });
      const t = {
        id: tid, orderId: o.id, time: o.time, sym: row.sym, signal: row.decision, conviction: row.conviction, strat: row.strat, stratName: row.stratName, bias: row.bias,
        lots, qty, lot: row.lot, expiry: row.expiry, exitBy: row.exitBy, legs, net, margin, chEntry: ch, entrySpot: spots[row.sym],
        targetSpot: row.targetSpot, slSpot: row.slSpot, tpPnl: row.tpPnl, slPnl: row.slPnl, src: row.src, origin: src, candle: meta.candle || null,
        status: 'OPEN', pnlGross: 0, curSpot: spots[row.sym], val: net, why: row.verdict || '', ma20: meta.ma20 || null, range: row.range || null,
        exitTarget: row.exitTarget, exitSL: row.exitSL, profitAtTarget: Math.round(row.tpPnl * qty), lossAtSL: Math.round(-row.slPnl * qty), gate: row.gate, details: row.details, buyArea: row.buyArea,
        targetTxt: row.targetTxt, slTxt: row.slTxt, plan: row.plan, entryDay: day, debit: row.debit, peak: 0, m0: row.legs.reduce((x, l) => x + (l.a === 'B' ? l.model : -l.model), 0), spot0: row.spot,
        sizeNote: sz.mode === 'workbook' ? `Workbook sizing: ${sz.wb} lot(s) from profit goal, margin cap allows ${sz.byMargin}` : `AI sizing: risk budget ₹${sz.budget}, loss at SL ₹${sz.lossPerLot}/lot -> ${sz.byRisk} by risk, ${sz.byMargin} by margin; workbook goal lots ${sz.wb}`,
        ctx: { vix: meta.vix ?? null, edge: row.ag ? Math.abs(row.ag.edge) : null, streak: row.streak || 1, a2: row.a2 ? row.a2.score : null, conv1: row.conv1 ?? null, dte: row.dte, tf: S.candleTf, side: row.decision },
      };
      P.st.trades.unshift(t); P.save();
      if (P.onEnter) P.onEnter(t, row, o);
      return { ok: true, trade: t, order: o };
    },

    // Mark price like a broker's MTM: mid when the spread is sane (<=25%), else last traded price; never a stale/empty bid
    markPx(q) {
      if (!q) return null;
      const bid = q.bid || 0, ask = q.ask || 0, ltp = q.ltp || 0, mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : 0;
      if (mid > 0 && (ask - bid) / mid <= 0.25) return mid;
      if (ltp > 0) return ltp;
      if (mid > 0) return mid;
      return bid > 0 ? bid : ask > 0 ? ask : null;
    },
    // exit fill = mark -/+ half the spread, but never worse than max bid-ask / 2 (a junk quote cannot create a fake loss)
    exitPx(q, side, S) {
      const m = P.markPx(q), half = q.bid > 0 && q.ask > 0 ? (q.ask - q.bid) / 2 : 0, cap = m * (S.maxBA / 2), h = Math.min(half, cap);
      return Math.max(0.05, side === 'B' ? m - h : m + h);
    },
    // value from live two-sided quotes only (bid and ask present, spread <= 25%): a real market exists, so a target met here is a real exit
    valueTwoSided(t, chain) {
      let v = 0;
      for (const l of t.legs) {
        const q = chain && chain.get(l.K) && chain.get(l.K)[l.t];
        if (!q || !(q.bid > 0) || !(q.ask > 0) || (q.ask - q.bid) / ((q.ask + q.bid) / 2) > 0.25) return null;
        const m = (q.bid + q.ask) / 2; v += l.a === 'B' ? m : -m;
      }
      return v;
    },
    // re-entry lock: after a profit exit the same-direction order for that symbol waits until the trend reverses
    lockedFor(row, S) { const lk = (P.st.locks || {})[row.sym]; return S.reentryLock !== 'off' && lk && row.bias === lk.dir ? lk : null; },
    releaseLocks(all) {
      const out = [];
      for (const [sym, lk] of Object.entries(P.st.locks || {})) {
        const r = all[sym]; if (!r || !r.ag) continue; const ts = r.ag.ts;
        const rev = lk.dir === 'U' ? ts <= -1 : lk.dir === 'D' ? ts >= 1 : Math.abs(ts) >= 1;
        if (rev) { delete P.st.locks[sym]; out.push(sym); }
      }
      if (out.length) P.save();
      return out;
    },
    value(t, chain) {
      let v = 0;
      for (const l of t.legs) {
        const q = chain && chain.get(l.K) && chain.get(l.K)[l.t], m = P.markPx(q);
        if (m == null) return null;
        v += l.a === 'B' ? m : -m;
      }
      return v;
    },

    // model (Black-Scholes) net value now, calibrated to the entry: used to spot stale / junk option quotes
    expected(t, spot, S, vix, today) {
      const iv = (vix / 100) * (t.sym === 'NIFTY' ? 1 : S.ivMult), T = Math.max(1, QT.daysBetween(today, t.expiry)) / 365;
      const now = t.legs.reduce((x, l) => x + (l.a === 'B' ? 1 : -1) * QT.bs(l.t, spot, l.K, T, S.rf, iv), 0);
      return t.net + (now - t.m0);
    },
    // spots = live prices; sig = last CLOSED candle closes; ma20 = {sym: 20-DMA}
    markAll(S, spots, chains, today, sig, ma20, vix) {
      const out = [], mins = QT.istMin();
      const reasonTime = (S.mode === 'demo' && S.demoIgnoreHours) || mins >= 915; // "closes" = near the daily close
      const settled = (S.mode === 'demo' && S.demoIgnoreHours) || mins >= 555 + (S.settleMin || 0);
      const canExit = QT.marketOpen() || (S.mode === 'demo' && S.demoIgnoreHours);
      for (const t of P.open()) {
        const ch = chains[t.sym + '|' + t.expiry];
        let v = P.value(t, ch);
        if (spots[t.sym]) t.curSpot = spots[t.sym];
        t.stale = v == null; t.est = false;
        if (v != null && vix && t.m0 != null) { // quote sanity: a position cannot lose/gain far more than the model implies
          const exp = P.expected(t, t.curSpot, S, vix, today);
          if (Math.abs(v - exp) > 0.35 * Math.abs(t.net) + 0.5) { t.est = true; v = exp; } // junk quote -> show the model estimate, do not trade on it
        }
        if (v != null) { t.val = r2(v); t.pnlGross = r2((v - t.net) * t.qty); }
        const sp = S.closeExit && sig && sig[t.sym] ? sig[t.sym] : t.curSpot;
        const pps = t.val - t.net, ok = v != null && !t.est;
        let why = null, premium = false, viaTS = false;
        // premium TARGET: exit as soon as the option target is met on live two-sided quotes - never wait for the spot target
        if (S.exitOnPremiumTarget !== false) {
          const vt = P.valueTwoSided(t, ch);
          if (vt != null && vt - t.net >= t.tpPnl * (S.bookPct || 1) && settled) { why = 'TARGET HIT'; viaTS = true; if (v == null || t.est) { v = vt; t.val = r2(vt); t.pnlGross = r2((vt - t.net) * t.qty); t.est = false; } }
        }
        if (!why && ok) {
          t.peak = Math.max(t.peak || 0, pps);
          if (S.exitOnPremiumTarget === false) { /* wait for the spot target only */ }
          else if (pps >= t.tpPnl * (S.bookPct || 1)) { why = 'TARGET HIT'; premium = true; } // profit is booked any time the market is open
          if (why) { /* target already found */ } else if (pps <= t.slPnl) { why = 'SL HIT'; premium = true; }
          else if (S.lockProfit && t.peak >= t.tpPnl * S.lockAt && pps <= t.tpPnl * S.lockKeep) { why = 'PROFIT LOCK'; premium = true; }
        }
        if (!why && t.targetSpot) {
          if (t.bias === 'U') why = sp >= t.targetSpot ? 'TARGET HIT' : sp <= t.slSpot ? 'SL HIT' : null;
          else if (t.bias === 'D') why = sp <= t.targetSpot ? 'TARGET HIT' : sp >= t.slSpot ? 'SL HIT' : null;
        }
        // Rule 8 - entry reason gone (trading plan): spot closes through the 20-DMA / leaves the expected range
        if (!why && S.maExit && reasonTime) {
          const m = (ma20 && ma20[t.sym]) || t.ma20, c = sig && sig[t.sym] ? sig[t.sym] : t.curSpot;
          if (t.bias === 'U' && m && c < m) why = 'ENTRY REASON GONE';
          else if (t.bias === 'D' && m && c > m) why = 'ENTRY REASON GONE';
          else if (t.range && (c < t.range[0] || c > t.range[1])) why = 'ENTRY REASON GONE';
        }
        if (!why && t.bias === 'N' && !t.range) { // straddle / strangle: "exit if still flat at 1/2 time"
          const tot = QT.daysBetween(t.entryDay || today, t.exitBy), el = QT.daysBetween(t.entryDay || today, today);
          if (tot > 0 && el >= tot / 2 && Math.abs(t.curSpot / t.entrySpot - 1) < S.targetPct / 2) why = 'FLAT AT 1/2 TIME';
        }
        if (!why && today >= t.exitBy) why = 'EXIT-BY DUE';
        if (!why && today >= t.expiry) why = 'EXPIRED';
        // premium-based exits: not in the opening-settle minutes, and must repeat on N consecutive marks (filters bad ticks)
        if (why && premium) { t.hit = (t.hitWhy === why ? (t.hit || 0) : 0) + 1; t.hitWhy = why; if (!settled || t.hit < (S.exitConfirm || 1)) why = null; }
        else if (!why || !premium) { if (!premium) { t.hit = 0; t.hitWhy = null; } }
        if (why && v != null && (ok || viaTS) && canExit) { P.close(t, why, S, ch); out.push(t); }
      }
      P.st.curve.push([Date.now(), P.equity(S)]); if (P.st.curve.length > 600) P.st.curve.shift();
      P.save();
      return out;
    },

    close(t, why, S, chain) {
      const fills = t.legs.map((l) => {
        const q = chain.get(l.K)[l.t], px = P.exitPx(q, l.a, S);
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
      P.st.realized = r2(P.st.realized + t.pnl);
      if (S.reentryLock !== 'off' && (['TARGET HIT', 'PROFIT LOCK'].includes(why) || (S.reentryLock === 'both' && why !== 'MANUAL'))) (P.st.locks = P.st.locks || {})[t.sym] = { dir: t.bias, since: new Date().toISOString(), why, tid: t.id, strat: t.strat };
      P.save();
      if (P.onClose) P.onClose(t);
    },

    stats() {
      const c = P.closed(), W = c.filter((t) => t.pnl > 0), L = c.filter((t) => t.pnl <= 0);
      const gw = W.reduce((s, t) => s + t.pnl, 0), gl = -L.reduce((s, t) => s + t.pnl, 0);
      let eq = 0, pk = 0, dd = 0;
      [...c].sort((a, b) => a.exitTime.localeCompare(b.exitTime)).forEach((t) => { eq += t.pnl; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); });
      const th = c.filter((t) => t.status === 'TARGET HIT').length, sl = c.filter((t) => t.status === 'SL HIT').length, eb = c.filter((t) => t.status === 'EXIT-BY DUE').length;
      return { total: P.st.trades.length, open: P.open().length, closed: c.length, wins: W.length, losses: L.length, winRate: c.length ? (100 * W.length) / c.length : 0, targetHits: th, slHits: sl, exitBy: eb, targetWinRate: c.length ? (100 * th) / c.length : 0,
        avgWin: W.length ? gw / W.length : 0, avgLoss: L.length ? -gl / L.length : 0, pf: gl ? gw / gl : gw ? Infinity : 0, maxDD: dd,
        charges: r2(P.st.trades.reduce((s, t) => s + (t.chEntry || 0) + (t.chExit || 0), 0)) };
    },
    // win-rate tables: group closed trades by any key
    group(keyFn, labels) {
      const m = {}; (labels || []).forEach((l) => (m[l] = []));
      P.closed().forEach((t) => { const k = keyFn(t); if (k == null) return; (m[k] = m[k] || []).push(t); });
      return Object.entries(m).map(([k, a]) => {
        const w = a.filter((t) => t.pnl > 0), lo = a.filter((t) => t.pnl <= 0), gw = w.reduce((x, t) => x + t.pnl, 0), gl = -lo.reduce((x, t) => x + t.pnl, 0);
        return { k, n: a.length, wins: w.length, losses: lo.length, winRate: a.length ? (100 * w.length) / a.length : null, total: r2(a.reduce((x, t) => x + t.pnl, 0)), avg: a.length ? r2(a.reduce((x, t) => x + t.pnl, 0) / a.length) : 0,
          target: a.filter((t) => t.status === 'TARGET HIT').length, sl: a.filter((t) => t.status === 'SL HIT').length, other: a.filter((t) => !['TARGET HIT', 'SL HIT'].includes(t.status)).length, pf: gl ? gw / gl : gw ? Infinity : 0 };
      });
    },
    daywise() {
      const m = {};
      P.closed().forEach((t) => { const d = t.exitTime.slice(0, 10); m[d] = m[d] || { d, n: 0, pnl: 0 }; m[d].n++; m[d].pnl = r2(m[d].pnl + t.pnl); });
      return Object.values(m).sort((a, b) => b.d.localeCompare(a.d));
    },
    csv() {
      const h = 'trade_id,order_id,open_time,close_time,symbol,strategy,origin,signal,conviction,lots,qty,dr_cr,entry_spot,target_spot,sl_spot,expiry,exit_by,legs(entry),entry_prem,target_prem,sl_prem,exit_net,profit_at_target,loss_at_sl,status,exit_spot,gross_pnl,charges,net_pnl,book_rules';
      const rows = P.st.trades.map((t) => [t.id, t.orderId, t.time, t.exitTime || '', t.sym, t.stratName, t.origin, t.signal, t.conviction, t.lots, t.qty, t.net > 0 ? 'Debit' : 'Credit', t.entrySpot, t.targetSpot ?? '', t.slSpot ?? '', t.expiry, t.exitBy,
        '"' + t.legs.map((l) => `${l.a}${l.K}${l.t}@${l.fill}`).join(' ') + '"', t.net, t.exitTarget ?? '', t.exitSL ?? '', t.exitNet ?? '', t.profitAtTarget ?? '', t.lossAtSL ?? '', t.status, t.exitSpot ?? '', t.pnlGross ?? '', (t.chEntry || 0) + (t.chExit || 0), t.pnl ?? '', '"' + (t.details || '') + '"'].join(','));
      return [h, ...rows].join('\n');
    },
  });
})();

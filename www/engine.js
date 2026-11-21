/* Engine: signals, 10 strategies, book rules (port of the workbook logic) */
(function () {
  const QT = (globalThis.QT = globalThis.QT || {});

  QT.DEFAULTS = {
    mode: 'demo', token: '', refreshSec: 60, expiryMode: 'auto',
    strat: { 1: true, 2: true, 3: false, 4: false, 5: false, 6: false, 7: true, 8: true, 9: true, 10: true },
    // strategy params
    profitGoal: 4500, vixThreshold: 18, targetPct: 0.03, slPct: 0.015, widthStock: 0.025, widthNifty: 0.01,
    maxLots: 20, minEdge: 4, holdDays: 5, ivMult: 1.3, rf: 0.065,
    // book rules
    minOI: 100, minVol: 500000, maxBA: 0.1, minYield: 0.1, minDTEBuy: 60, maxDTESell: 35, exitBefore: 30, creditTP: 0.5,
    // paper
    capital: 1000000, autoTrade: true, minConviction: 50, maxOpen: 10, allowOffHours: false, allowDup: false,
    charges: true, brokerage: 20, sttPct: 0.001, slipPct: 0.003,
  };

  // Strategy map (Guy Cohen) - legs: [action, type, offset in width units]
  QT.STRATS = {
    1: { name: 'Long Call', bias: 'U', risk: 'D', exp: 'far', legs: [['B', 'CE', 0]] },
    2: { name: 'Long Put', bias: 'D', risk: 'D', exp: 'far', legs: [['B', 'PE', 0]] },
    3: { name: 'Bull Call Spread', bias: 'U', risk: 'D', exp: 'far', legs: [['B', 'CE', 0], ['S', 'CE', 1]] },
    4: { name: 'Bear Put Spread', bias: 'D', risk: 'D', exp: 'far', legs: [['B', 'PE', 0], ['S', 'PE', -1]] },
    5: { name: 'Bull Put Spread', bias: 'U', risk: 'C', exp: 'near', legs: [['S', 'PE', -1], ['B', 'PE', -2]] },
    6: { name: 'Bear Call Spread', bias: 'D', risk: 'C', exp: 'near', legs: [['S', 'CE', 1], ['B', 'CE', 2]] },
    7: { name: 'Long Straddle', bias: 'N', risk: 'D', exp: 'far', legs: [['B', 'CE', 0], ['B', 'PE', 0]] },
    8: { name: 'Long Strangle', bias: 'N', risk: 'D', exp: 'far', legs: [['B', 'CE', 1], ['B', 'PE', -1]] },
    9: { name: 'Long Iron Condor', bias: 'N', risk: 'C', exp: 'near', legs: [['S', 'PE', -1], ['B', 'PE', -2], ['S', 'CE', 1], ['B', 'CE', 2]] },
    10: { name: 'Long Iron Butterfly', bias: 'N', risk: 'C', exp: 'near', legs: [['S', 'CE', 0], ['S', 'PE', 0], ['B', 'CE', 1], ['B', 'PE', -1]] },
  };

  // ---------- helpers ----------
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
  const tick = (x) => Math.max(0.05, Math.round(x * 20) / 20);
  const r2 = (x) => Math.round(x * 100) / 100;
  QT.istNow = () => new Date(Date.now() + 19800000);
  QT.istDate = () => QT.istNow().toISOString().slice(0, 10);
  QT.daysBetween = (a, b) => Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 864e5);
  QT.addDays = (d, n) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) + n * 864e5).toISOString().slice(0, 10);
  QT.marketOpen = () => {
    const d = QT.istNow(), wd = d.getUTCDay(), m = d.getUTCHours() * 60 + d.getUTCMinutes();
    return wd >= 1 && wd <= 5 && m >= 555 && m <= 930;
  };
  function ncdf(x) {
    const t = 1 / (1 + 0.2316419 * Math.abs(x)), d = 0.3989423 * Math.exp((-x * x) / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return x > 0 ? 1 - p : p;
  }
  QT.bs = function (type, S, K, T, r, v) {
    if (T <= 0 || v <= 0) return Math.max(0, type === 'CE' ? S - K : K - S);
    const sq = v * Math.sqrt(T), d1 = (Math.log(S / K) + (r + (v * v) / 2) * T) / sq, d2 = d1 - sq;
    return type === 'CE' ? S * ncdf(d1) - K * Math.exp(-r * T) * ncdf(d2) : K * Math.exp(-r * T) * ncdf(-d2) - S * ncdf(-d1);
  };
  QT.strikeStep = (sym, s) => (sym === 'NIFTY' ? 50 : s < 250 ? 5 : s < 1000 ? 10 : s < 2000 ? 20 : s < 5000 ? 50 : 100);

  // monthly expiries: last date of each calendar month from a list of ISO dates, future only
  QT.monthly = function (dates, today) {
    const m = {};
    [...new Set(dates)].sort().forEach((d) => { if (d >= today) m[d.slice(0, 7)] = d; });
    return Object.values(m).sort().slice(0, 3);
  };
  QT.pickExpiry = function (series, S, type, today) {
    if (!series || !series.length) return null;
    if (S.expiryMode && S.expiryMode !== 'auto') {
      if (series.includes(S.expiryMode)) return S.expiryMode;
      const i = { near: 0, next: 1, far: 2 }[S.expiryMode];
      if (i !== undefined) return series[Math.min(i, series.length - 1)];
    }
    return type === 'far' ? series[series.length - 1] : series[0];
  };

  // ---------- indicators & agents ----------
  QT.indicators = function (candles) { // newest first [ts,o,h,l,c,v]
    if (!candles || candles.length < 25) return null;
    const cl = candles.map((c) => c[4]);
    const hi = candles.map((c) => c[2]), lo = candles.map((c) => c[3]);
    const today = QT.istDate();
    const prevC = candles.find((c) => String(c[0]).slice(0, 10) < today) || candles[1];
    return {
      ma20: avg(cl.slice(0, 20)), ma50: avg(cl.slice(0, 50)), hi52: Math.max(...hi), lo52: Math.min(...lo),
      hi60: Math.max(...hi.slice(0, 60)), lo60: Math.min(...lo.slice(0, 60)),
      avgVol: avg(candles.slice(0, 20).map((c) => c[5] || 0)), prevClose: prevC[4],
    };
  };
  QT.agents = function (sym, spot, ind, niftyTS) {
    const day = spot / ind.prevClose - 1;
    const pos = ind.hi52 === ind.lo52 ? 0.5 : (spot - ind.lo52) / (ind.hi52 - ind.lo52);
    const nf = sym === 'NIFTY';
    const B = [spot > ind.ma20, ind.ma20 > ind.ma50, pos >= 0.5, day > 0.005, !nf && niftyTS >= 1, spot < ind.ma20 * 0.96].map(Number);
    const R = [spot < ind.ma20, ind.ma20 < ind.ma50, pos < 0.5, day < -0.005, !nf && niftyTS <= -1, spot > ind.ma20 * 1.04].map(Number);
    const ts = (spot > ind.ma20 ? 1 : -1) + (ind.ma20 > ind.ma50 ? 1 : -1) + (pos >= 0.5 ? 1 : -1) + (day > 0.005 ? 1 : day < -0.005 ? -1 : 0);
    const bn = ['above ~20-DMA', '~20-DMA above ~50-DMA (uptrend)', 'upper half of 52-week range', 'up >0.5% today', 'Nifty trend positive', 'oversold >4% under 20-DMA (bounce chance)'];
    const rn = ['below ~20-DMA', '~20-DMA below ~50-DMA (downtrend)', 'lower half of 52-week range', 'down >0.5% today', 'Nifty trend negative', 'stretched >4% over 20-DMA (pullback risk)'];
    const bp = B.reduce((a, b) => a + b, 0), rp = R.reduce((a, b) => a + b, 0);
    return {
      day, pos, ts, bull: bp, bear: rp, edge: bp - rp,
      bullTxt: `Bull ${bp}/6: ` + (bp ? bn.filter((_, i) => B[i]).join('; ') : 'no technical case'),
      bearTxt: `Bear ${rp}/6: ` + (rp ? rn.filter((_, i) => R[i]).join('; ') : 'no technical case; only time decay / reversal risk'),
    };
  };
  QT.pickStrategy = function (ts, day, vix, thr) {
    const low = vix < thr;
    if (ts >= 3) return low ? 1 : 5;
    if (ts >= 1) return low ? 3 : 5;
    if (ts <= -3) return low ? 2 : 6;
    if (ts <= -1) return low ? 4 : 6;
    return Math.abs(day) < 0.005 ? (low ? 7 : 10) : low ? 8 : 9;
  };

  // ---------- trade builder ----------
  // ctx: {sym, spot, ind, ag, vix, S, strat, expiry, today, lot, chain(Map strike->{CE,PE}) | null}
  QT.buildTrade = function (c) {
    const { sym, spot, ind, ag, vix, S, strat, expiry, today, lot, chain } = c;
    const st = QT.STRATS[strat];
    const dte = QT.daysBetween(today, expiry), T = Math.max(dte, 1) / 365;
    const iv = (vix / 100) * S.ivMult;
    const step = QT.strikeStep(sym, spot), atm = Math.round(spot / step) * step;
    const cushion = Math.round((spot * iv * Math.sqrt(T)) / step) * step;
    const wPct = sym === 'NIFTY' ? S.widthNifty : S.widthStock;
    let W = Math.max(step, Math.round((spot * wPct) / step) * step);
    if ([5, 6, 9].includes(strat)) W = Math.max(W, cushion);

    const legs = st.legs.map(([a, t, off]) => {
      const K = atm + off * W, model = QT.bs(t, spot, K, T, S.rf, iv);
      const q = chain && chain.get(K) && chain.get(K)[t];
      let p = model, src = 'MODEL', oi = null, ba = null, key = null;
      if (q) {
        const px = a === 'B' ? (q.ask > 0 ? q.ask : q.ltp) : q.bid > 0 ? q.bid : q.ltp;
        if (px > 0) { p = px; src = 'LIVE'; oi = q.oi / lot; key = q.key; ba = q.ask > 0 && q.bid > 0 ? (q.ask - q.bid) / ((q.ask + q.bid) / 2) : null; }
      }
      return { a, t, K, p: tick(p), model, src, oi, ba, key };
    });
    const sgn = (l) => (l.a === 'B' ? 1 : -1);
    const net = r2(legs.reduce((s, l) => s + sgn(l) * l.p, 0));
    const modelNet0 = legs.reduce((s, l) => s + sgn(l) * l.model, 0);
    const debit = net > 0;
    const netAt = (sp, TT) => legs.reduce((s, l) => s + sgn(l) * QT.bs(l.t, sp, l.K, TT, S.rf, iv), 0);

    // payoff at expiry -> max loss / max profit (per share)
    const Ks = legs.map((l) => l.K), hiS = Math.max(...Ks) * 2, pts = [0, ...Ks, hiS];
    const pay = (x) => legs.reduce((s, l) => s + sgn(l) * Math.max(0, l.t === 'CE' ? x - l.K : l.K - x), 0) - net;
    const pv = pts.map(pay);
    const maxLoss = -Math.min(...pv);
    const unlimited = legs.filter((l) => l.a === 'B' && l.t === 'CE').length > legs.filter((l) => l.a === 'S' && l.t === 'CE').length;
    const maxProfit = unlimited ? Infinity : Math.max(...pv);

    // targets
    const up = st.bias === 'U' || st.bias === 'N';
    const sT = st.bias === 'D' ? spot * (1 - S.targetPct) : spot * (1 + S.targetPct);
    const sSL = st.bias === 'U' ? spot * (1 - S.slPct) : st.bias === 'D' ? spot * (1 + S.slPct) : spot;
    const T2 = Math.max(0, dte - S.holdDays) / 365;
    let tpPnl, slPnl;
    if (debit) {
      tpPnl = netAt(sT, T2) - modelNet0; slPnl = netAt(sSL, T2) - modelNet0; // calibrated to live fill
      tpPnl = Math.max(tpPnl, net * 0.05); slPnl = Math.max(-net, Math.min(slPnl, -net * 0.05));
    } else { const cr = -net; tpPnl = cr * S.creditTP; slPnl = -cr; }
    tpPnl = r2(tpPnl); slPnl = r2(slPnl);
    const perShareTarget = Math.max(tpPnl, 0.05);
    const lots = Math.min(S.maxLots, Math.max(1, Math.ceil(S.profitGoal / (lot * perShareTarget))));
    const qty = lots * lot;
    const exitDays = S.expiryMode === 'auto' ? S.exitBefore : Math.min(S.exitBefore, Math.max(1, Math.floor(dte / 4)));
    const exitBy = debit ? QT.addDays(expiry, -exitDays) : QT.addDays(expiry, -Math.min(2, Math.max(0, dte - 1)));
    const margin = debit ? net * qty : maxLoss * qty;

    // ---------- book rules gate ----------
    const fails = [], warns = [], auto = S.expiryMode === 'auto';
    const flag = (soft, m) => (auto && !soft ? fails : warns).push(m);
    if (debit && dte < S.minDTEBuy) flag(false, `bought option has ${dte}d to expiry (<${S.minDTEBuy})`);
    if (!debit && dte > S.maxDTESell) flag(false, `sold premium has ${dte}d to expiry (>${S.maxDTESell})`);
    if (strat === 3 || strat === 4) {
      const be = strat === 3 ? legs[0].K + net - spot : spot - (legs[0].K - net);
      const sig = spot * iv * Math.sqrt(Math.max(dte - S.exitBefore, 1) / 365);
      if (be > sig) flag(false, 'breakeven beyond 1-sigma move');
    }
    if (!debit && (strat === 5 || strat === 6 || strat === 9)) {
      const wing = Math.abs(legs[0].K - legs[1].K), y = -net / wing;
      if (y < S.minYield) flag(false, `credit yield ${(y * 100).toFixed(1)}% < ${S.minYield * 100}% of width`);
      if (strat === 5 && ind.ma20 < legs[0].K) fails.push('20-DMA support below short put');
      if (strat === 6 && ind.ma20 > legs[0].K) fails.push('20-DMA resistance above short call');
    }
    if ((strat === 7 || strat === 8) && net >= 0.5 * (ind.hi60 - ind.lo60)) fails.push('cost >= half of 60-day range');
    if (strat === 7 || strat === 8) warns.push('confirm results/news within ~2 weeks');
    if (legs.every((l) => l.src === 'LIVE')) {
      if (legs.some((l) => l.oi < S.minOI)) fails.push(`option OI < ${S.minOI} contracts`);
      if (legs.some((l) => l.ba != null && l.ba > S.maxBA)) warns.push('wide bid-ask');
    } else warns.push('open interest not verified (MODEL prices)');
    if (ind.avgVol < S.minVol) warns.push('low volume');
    if (maxProfit !== Infinity && maxProfit < maxLoss * 0.3) warns.push('reward:risk < 0.3');

    const t = (l) => `${l.a === 'B' ? 'BUY' : 'SELL'} ${lots}L ${sym} ${expiry} ${l.K} ${l.t} @~${l.p}`;
    const ret = {
      sym, spot, strat, stratName: st.name, bias: st.bias, expiry, dte, lot, lots, qty, net, debit, step, W,
      legs, ticket: legs.map(t), maxLoss: r2(maxLoss), maxProfit: maxProfit === Infinity ? null : r2(maxProfit),
      tpPnl, slPnl, profitAtTarget: Math.round(tpPnl * qty), lossAtSL: Math.round(-slPnl * qty),
      targetSpot: st.bias === 'N' ? null : r2(sT), slSpot: st.bias === 'N' ? null : r2(sSL),
      buyArea: `${r2(spot - step)} - ${r2(spot)}`, exitBy, margin: Math.round(margin),
      src: legs.every((l) => l.src === 'LIVE') ? 'Option-chain bid/ask' : 'MODEL prices - verify',
      fails, warns, pass: fails.length === 0,
      plan: debit
        ? `Exit at +${tpPnl}/share (target) or ${slPnl}/share (SL); exit by ${exitBy}; exit early if spot closes below/above ~20-DMA ${r2(ind.ma20)} against the trade.`
        : `Take profit at ${S.creditTP * 100}% of credit, stop at 100% loss of credit; exit by ${exitBy}.`,
    };
    ret.upDir = up;
    return ret;
  };

  // evaluate one symbol; returns row (always) with decision
  QT.evaluate = function (sym, snap, S, chainMap, expiries) {
    const spot = snap.quotes[sym], ind = snap.ind[sym];
    if (!spot || !ind) return { sym, decision: 'NO DATA', reason: 'no price/candle data' };
    const ag = QT.agents(sym, spot, ind, snap.niftyTS);
    const strat = QT.pickStrategy(ag.ts, ag.day, snap.vix, S.vixThreshold);
    const st = QT.STRATS[strat];
    const base = { sym, spot, ag, strat, stratName: st.name };
    if (!S.strat[strat]) return { ...base, decision: 'IGNORED', reason: `strategy #${strat} ${st.name} is OFF` };
    let decision = '', conviction = 0;
    if (st.bias === 'U' && ag.edge >= S.minEdge) { decision = 'BUY'; conviction = Math.round((100 * ag.edge) / 6); }
    else if (st.bias === 'D' && ag.edge <= -S.minEdge) { decision = 'SELL'; conviction = Math.round((100 * -ag.edge) / 6); }
    else if (st.bias === 'N' && Math.abs(ag.edge) < S.minEdge) { decision = 'NEUTRAL'; conviction = 50; }
    if (!decision) return { ...base, decision: 'IGNORED', reason: `no clear edge (bull ${ag.bull} vs bear ${ag.bear})` };
    const series = sym === 'NIFTY' ? expiries.index : expiries.stock;
    const expiry = QT.pickExpiry(series, S, st.exp, snap.today);
    if (!expiry) return { ...base, decision: 'IGNORED', reason: 'no expiry available' };
    const tr = QT.buildTrade({ sym, spot, ind, ag, vix: snap.vix, S, strat, expiry, today: snap.today, lot: QT.UNIVERSE[sym].lot, chain: chainMap && chainMap[sym + '|' + expiry] });
    if (!tr.pass) return { ...base, ...tr, decision: 'IGNORED', reason: 'book rule FAIL: ' + tr.fails.join('; ') };
    return { ...base, ...tr, decision, conviction, verdict: `${decision} - Bull ${ag.bull} vs Bear ${ag.bear} (edge ${ag.edge > 0 ? '+' : ''}${ag.edge}). Plan: ${tr.stratName}.` };
  };
})();

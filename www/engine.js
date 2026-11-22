/* Engine v3 - exact port of the workbook: Agents (Bull / Bear / Judge), Trade Planner, 11 book-rule checks, Strategy Map */
(function () {
  const QT = (globalThis.QT = globalThis.QT || {});

  QT.DEFAULTS = {
    mode: 'demo', token: '', feedUrl: '', feedHeaders: '{}', refreshSec: 60, expiryMode: 'auto', maxAge: 120,
    strat: { 1: true, 2: true, 3: false, 4: false, 5: false, 6: false, 7: true, 8: true, 9: true, 10: true },
    neutralTrade: true, maExit: true, force: {}, spotOv: {},
    // Settings sheet
    profitGoal: 4500, vixThreshold: 18, targetPct: 0.03, slPct: 0.015, widthStock: 0.025, widthNifty: 0.01,
    maxLots: 20, minEdge: 4, holdDays: 5, ivMult: 1.3, rf: 0.065,
    minOI: 100, minVol: 500000, maxBA: 0.1, minYield: 0.1, minDTEBuy: 60, maxDTESell: 35, exitBefore: 30, creditTP: 0.5,
    holidays: '2026-11-24,2026-12-25,2027-01-26,2027-03-04,2027-03-26',
    // paper account
    capital: 1000000, autoTrade: true, minConviction: 50, maxOpen: 20, allowDup: false,
    // money management ("AI" sizing = risk-based lots within utilisation caps)
    sizing: 'ai', riskPct: 0.015, marginPerTradePct: 0.1, maxUtilPct: 0.9, dailyLossPct: 0.03, maxTradesPerDay: 20,
    // profit booking (works any time the market is open, even outside the new-order window)
    bookPct: 1, lockProfit: true, lockAt: 0.7, lockKeep: 0.4,
    // Agent 2 (history & movement) + Judge
    a2Enabled: true, a2Strict: 'normal', a2Weight: 0.4,
    // broker execution (separate from the data feed)
    execMode: 'paper', orderBroker: 'upstox', brokerToken: '', algoId: '', dryRun: true, liveAck: false, product: 'D', orderType: 'LIMIT', maxOrderValue: 300000, maxLiveOrdersDay: 40,
    webhookUrl: '', webhookHeaders: '{"Content-Type":"application/json"}',
    webhookBody: '{"symbol":"{sym}","expiry":"{expiry}","strike":{strike},"type":"{type}","side":"{side}","qty":{qty},"price":{price},"key":"{key}","order_type":"{ordertype}","product":"{product}","tag":"OptionsDesk"}',
    // AI tuning of filters from paper-trade history
    autoTune: false, optMinTrades: 20, optTargetWin: 0.55,
    charges: true, brokerage: 20, sttPct: 0.001, slipPct: 0.003,
    // trading time + closed-candle logic
    tradeStart: '09:30', tradeEnd: '15:10', demoIgnoreHours: true, manualOutside: false, closedCandle: true, candleTf: 15, confirmN: 1, closeExit: true,
    // alerts
    notify: true, alertMinConv: 50, tgToken: '', tgChat: '', theme: 'light', eduAccepted: false,
  };

  // Strategy Map sheet
  QT.STRATS = {
    1: { name: 'Long Call', view: 'Bullish', bias: 'U', risk: 'D', exp: 'far', legs: [['B', 'CE', 0]] },
    2: { name: 'Long Put', view: 'Bearish', bias: 'D', risk: 'D', exp: 'far', legs: [['B', 'PE', 0]] },
    3: { name: 'Bull Call Spread', view: 'Mildly bullish', bias: 'U', risk: 'D', exp: 'far', legs: [['B', 'CE', 0], ['S', 'CE', 1]] },
    4: { name: 'Bear Put Spread', view: 'Mildly bearish', bias: 'D', risk: 'D', exp: 'far', legs: [['B', 'PE', 0], ['S', 'PE', -1]] },
    5: { name: 'Bull Put Spread', view: 'Bullish / neutral-bullish (credit)', bias: 'U', risk: 'C', exp: 'near', legs: [['S', 'PE', -1], ['B', 'PE', -2]] },
    6: { name: 'Bear Call Spread', view: 'Bearish / neutral-bearish (credit)', bias: 'D', risk: 'C', exp: 'near', legs: [['S', 'CE', 1], ['B', 'CE', 2]] },
    7: { name: 'Long Straddle', view: 'Big move either way', bias: 'N', risk: 'D', exp: 'far', legs: [['B', 'CE', 0], ['B', 'PE', 0]] },
    8: { name: 'Long Strangle', view: 'Big move either way (cheaper)', bias: 'N', risk: 'D', exp: 'far', legs: [['B', 'CE', 1], ['B', 'PE', -1]] },
    9: { name: 'Long Iron Condor', view: 'Range-bound (credit)', bias: 'N', risk: 'C', exp: 'near', legs: [['S', 'PE', -1], ['B', 'PE', -2], ['S', 'CE', 1], ['B', 'CE', 2]] },
    10: { name: 'Long Iron Butterfly', view: 'Pinned near ATM (credit)', bias: 'N', risk: 'C', exp: 'near', legs: [['S', 'CE', 0], ['S', 'PE', 0], ['B', 'CE', 1], ['B', 'PE', -1]] },
  };

  // 10 Logics sheet (static reference page)
  const LIQ = 'Liquid: avg volume >500,000, option open interest >=100 (ideally 500).';
  QT.LOGICS = [
    [1, 'Long Call', 'Bullish', 'Debit. Max loss = premium. Reward unlimited.', LIQ + ' Uptrend with clear support.', 'ATM/slightly ITM. Sheet: BUY ATM call.', 'Book: 3+ months, never into final month. Sheet: FAR month (>=60 days), exit 30 days before expiry.', 'Hurts you.', 'Score >= +3 and VIX < threshold', 'Ch.1 p.5'],
    [2, 'Long Put', 'Bearish', 'Debit. Max loss = premium.', LIQ + ' Downtrend with clear resistance.', 'ATM/slightly ITM. Sheet: BUY ATM put.', 'Same as long call.', 'Hurts you.', 'Score <= -3 and VIX < threshold', 'Ch.1 p.12'],
    [3, 'Bull Call Spread', 'Bullish', 'Debit. Max loss = net debit. Max profit = width - debit.', LIQ + ' Uptrend + clear support. Check breakeven first, then yield.', 'Buy near-ATM call, sell higher call. Sheet: BUY ATM, SELL +1 width.', 'Book: longer-term (6 months safest). Stocks list max ~3 months, so FAR month.', 'Hurts when losing.', 'Score +1..+2 and VIX < threshold', 'Ch.3 p.90'],
    [4, 'Bear Put Spread', 'Bearish', 'Debit. Max loss = net debit.', LIQ + ' Downtrend + clear resistance. Check breakeven first.', 'Buy higher put, sell lower put. Sheet: BUY ATM PE, SELL -1 width PE.', 'Same as bull call spread.', 'Hurts when losing.', 'Score -1..-2 and VIX < threshold', 'Ch.3 p.94'],
    [5, 'Bull Put Spread', 'Bullish / neutral-bullish (income)', 'Credit. Max profit = credit. Max loss = width - credit.', LIQ + ' Support must be ABOVE the short put strike.', 'Sell higher put, buy lower put; yield >=10% of width; decent cushion. Sheet: short put 1 sigma below spot.', 'Book: <=1 month. Sheet: NEAR month (<=35 days).', 'Helps you.', 'Score >= +1 and VIX >= threshold', 'Ch.2 p.28; Ch.3 p.99'],
    [6, 'Bear Call Spread', 'Bearish / neutral-bearish (income)', 'Credit. Max loss = width - credit.', LIQ + ' Resistance must be BELOW the short call strike.', 'Sell lower call, buy higher call; yield >=10%; cushion above price. Sheet: short call 1 sigma above spot.', 'Book: <=1 month. Sheet: NEAR month.', 'Helps you.', 'Score <= -1 and VIX >= threshold', 'Ch.2 p.32; Ch.3 p.99'],
    [7, 'Long Straddle', 'Big move either way', 'Debit (call+put). Reward unlimited.', LIQ + ' Straddle rules: results/news within ~2 weeks; pennant/consolidation; COST < half of the 60-day high-low range.', 'Both ATM. Sheet: BUY ATM CE + PE.', 'Book: 2-3 months out, exit within 2 weeks after the news, never into final month. Sheet: FAR month.', 'Harmful.', 'Score 0, day move <0.5%, VIX < threshold (confirm event yourself)', 'Ch.4 p.121'],
    [8, 'Long Strangle', 'Big move either way (cheaper)', 'Debit. Cheaper, wider breakevens.', 'Same rules as straddle.', 'OTM call + OTM put. Sheet: ATM +/-1 width.', 'Same as straddle.', 'Harmful.', 'Score 0, day move >=0.5%, VIX < threshold', 'Ch.4 p.127'],
    [9, 'Long Iron Condor', 'Range-bound (credit)', 'Credit. Max loss = wing width - credit.', LIQ + ' Range-bound with clear support & resistance around the shorts.', 'Short OTM put + short OTM call with wings. Sheet: shorts 1 sigma away.', 'Book: <=1 month. Sheet: NEAR month.', 'Helps you.', 'Score 0, day move >=0.5%, VIX >= threshold', 'Ch.2 p.41; Ch.5 p.217'],
    [10, 'Long Iron Butterfly', 'Pinned near ATM (credit)', 'Credit. Max loss = wing width - credit.', LIQ + ' Range-bound, no news due.', 'Sell ATM straddle, buy wings. Sheet: wings +/-1 width.', 'Book: <=1 month. Sheet: NEAR month.', 'Helps you.', 'Score 0, day move <0.5%, VIX >= threshold', 'Ch.2 p.36; Ch.5 p.217'],
  ].map(([n, name, view, risk, stock, strikes, expiry, decay, trigger, ref]) => ({ n, name, view, risk, stock, strikes, expiry, decay, trigger, ref }));
  QT.TARGET_SL_NOTE = 'Bought: option re-priced (Black-Scholes) at the underlying target/SL level after the assumed holding days. Sold: take profit at 50% of credit, stop at a loss = 100% of credit.';
  QT.THUMB = [
    ['Buy options with 2-3+ months to expiry; never hold bought options into the final month', "FAIL if days-to-expiry < 60 for bought options; 'Exit-by' date = expiry - 30 days. Stock options list only 3 monthly series, so 6-month spreads from the book are not possible."],
    ['Sell premium with 1 month or less', 'FAIL if days-to-expiry > 35 for credit trades.'],
    ['Before a bull call / bear put spread, look first at where the BREAKEVEN is - not at the potential yield', 'FAIL if breakeven is farther than the 1-sigma expected move over the holding window (expiry - 30 days). (Applied to strategies 1-4.)'],
    ['Credit spread yield should be about 10%+ of the spread width', 'FAIL if credit / width < 10%.'],
    ['Credit spreads need a decent cushion; support above the short put / resistance below the short call', 'FAIL if short strike is closer than ~0.9 x 1-sigma move; FAIL if the ~20-DMA support/resistance is on the wrong side of the short strike.'],
    ['Straddle cost should be less than half of the recent high-low range (60 trading days for a 3-month straddle)', 'FAIL if cost >= 0.5 x (60-day high - 60-day low). Also WARN: confirm earnings/news within ~2 weeks and a consolidation pattern - the app cannot see these.'],
    ['Liquidity: average volume > 500,000 shares and option open interest >= 100 (ideally 500)', 'FAIL if live option OI per leg < 100 contracts; WARN if volume < 500,000 or OI cannot be verified; WARN if bid-ask spread > 10% of mid.'],
    ['Follow your trading plan: stay in until one of your entry reasons is broken - then exit', "'Trading plan' shows target, SL, exit-by date and the entry-reason-broken exit (20-DMA close). The paper broker enforces them."],
    ['Rule of the Opposites: time decay hurts buyers and helps sellers', 'High VIX -> sell credit spreads; low VIX -> buy debit trades.'],
  ];
  QT.LIMITS = [
    'No formula or app can give true tick-by-tick data; this app refreshes every 15-300 seconds while it is open.',
    'Trend signals use price data only - not results, news, FII flows or global events. Straddle/strangle event rules need your own check.',
    'The profit goal sizes lots; it is not a promise. Loss at SL and Max loss are shown - credit trades can lose more than the goal.',
    'Nifty 50 list, lot sizes (NSE list of 29-Oct-2026) and strike steps are approximate - verify. The holiday list in Settings is an assumption (used only if the expiry list is missing).',
    "SEBI's own studies have found that most individual F&O traders lose money. Educational tool, NOT investment advice. Naked short options are left out on purpose (unlimited risk). Reward:Risk >= 1 is the workbook author's addition (warning only).",
  ];

  // ---------- helpers ----------
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
  const tick = (x) => Math.max(0.05, Math.round(x * 20) / 20);
  const r1 = (x) => Math.round(x * 10) / 10;
  const r2 = (x) => Math.round(x * 100) / 100;
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  QT.ddmmm = (d) => d.slice(8, 10) + '-' + MON[+d.slice(5, 7) - 1];
  QT.istNow = () => new Date(Date.now() + 19800000);
  QT.istDate = () => QT.istNow().toISOString().slice(0, 10);
  QT.daysBetween = (a, b) => Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 864e5);
  QT.addDays = (d, n) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) + n * 864e5).toISOString().slice(0, 10);
  QT.istMin = () => { const d = QT.istNow(); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
  QT.hm = (t) => { const [h, m] = String(t).split(':'); return +h * 60 + +m; };
  QT.isWeekday = () => { const w = QT.istNow().getUTCDay(); return w >= 1 && w <= 5; };
  QT.inWindow = (S) => QT.isWeekday() && QT.istMin() >= QT.hm(S.tradeStart) && QT.istMin() <= QT.hm(S.tradeEnd);
  QT.canTrade = (S, src) => (S.mode === 'demo' && S.demoIgnoreHours) || (src === 'manual' && S.manualOutside) || QT.inWindow(S);
  QT.candleId = (tf) => { const t = Date.now() + 19800000 - 5000, day = Math.floor(t / 864e5), mins = (t % 864e5) / 60000 - 555; return day * 1000 + Math.floor(mins / tf); };
  QT.nextCloseSecs = (tf) => { const t = Date.now() + 19800000, mins = (t % 864e5) / 60000 - 555, nxt = (Math.floor(mins / tf) + 1) * tf; return Math.max(0, Math.round((nxt - mins) * 60)); };
  QT.marketOpen = () => QT.isWeekday() && QT.istMin() >= 555 && QT.istMin() <= 930;
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

  // Settings sheet fallback: last Tuesday, moved to previous trading day if weekend/holiday
  QT.fallbackExpiries = function (today, holidays) {
    const hol = new Set(String(holidays || '').split(',').map((s) => s.trim()).filter(Boolean));
    const lastTue = (y, m) => { const d = new Date(Date.UTC(y, m + 1, 0)); while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };
    const adj = (s) => { let d = s; for (let i = 0; i < 10; i++) { const w = new Date(d + 'T00:00:00Z').getUTCDay(); if (w === 0 || w === 6 || hol.has(d)) d = QT.addDays(d, -1); else break; } return d; };
    const out = [];
    for (let i = 0; i < 4; i++) { const dt = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1 + i, 1)); out.push(adj(lastTue(dt.getUTCFullYear(), dt.getUTCMonth()))); }
    return out.filter((d) => d >= today);
  };
  QT.monthly = function (dates, today) {
    const m = {};
    [...new Set(dates)].sort().forEach((d) => { if (d >= today) m[d.slice(0, 7)] = d; });
    return Object.values(m).sort().slice(0, 3);
  };
  QT.pickExpiry = function (series, S, type) {
    if (!series || !series.length) return null;
    if (S.expiryMode && S.expiryMode !== 'auto') {
      if (series.includes(S.expiryMode)) return S.expiryMode;
      const i = { near: 0, next: 1, far: 2 }[S.expiryMode];
      if (i !== undefined) return series[Math.min(i, series.length - 1)];
    }
    return type === 'far' ? series[series.length - 1] : series[0];
  };

  // ---------- indicators (CLOSED daily candles only) ----------
  QT.indicators = function (candles) { // newest first [ts,o,h,l,c,v]
    if (!candles || candles.length < 25) return null;
    const today = QT.istDate(), done = QT.istMin() >= 930;
    candles = candles.filter((c) => String(c[0]).slice(0, 10) < today || (done && QT.isWeekday()));
    if (candles.length < 25) return null;
    const cl = candles.map((c) => c[4]), hi = candles.map((c) => c[2]), lo = candles.map((c) => c[3]), vo = candles.map((c) => c[5] || 0);
    const prevC = candles.find((c) => String(c[0]).slice(0, 10) < today) || candles[0];
    const tr = []; for (let i = 0; i < Math.min(candles.length - 1, 40); i++) tr.push(Math.max(hi[i] - lo[i], Math.abs(hi[i] - cl[i + 1]), Math.abs(lo[i] - cl[i + 1])));
    const chron = cl.slice(0, 80).reverse(); let g = 0, l = 0;
    for (let i = 1; i <= 14; i++) { const d = chron[i] - chron[i - 1]; d > 0 ? (g += d) : (l -= d); } g /= 14; l /= 14;
    for (let i = 15; i < chron.length; i++) { const d = chron[i] - chron[i - 1]; g = (g * 13 + Math.max(d, 0)) / 14; l = (l * 13 + Math.max(-d, 0)) / 14; }
    const mx = (a) => Math.max(...a), mn = (a) => Math.min(...a);
    let streak = 0; for (let i = 0; i < cl.length - 1; i++) { const up = cl[i] > cl[i + 1]; if (i === 0) streak = up ? 1 : -1; else if ((streak > 0) === up) streak += up ? 1 : -1; else break; }
    const va = avg(vo.slice(1, 21));
    return {
      ma20: avg(cl.slice(0, 20)), ma50: avg(cl.slice(0, 50)), hi52: mx(hi), lo52: mn(lo),
      hi40: mx(hi.slice(0, 40)), lo40: mn(lo.slice(0, 40)), hi60: mx(hi.slice(0, 60)), lo60: mn(lo.slice(0, 60)), hi80: mx(hi.slice(0, 80)), lo80: mn(lo.slice(0, 80)),
      avgVol: avg(vo.slice(0, 20)), prevClose: prevC[4],
      // history & movement measures (used by Agent 2)
      rsi: l === 0 ? 100 : 100 - 100 / (1 + g / l), roc5: cl[0] / cl[5] - 1, roc20: cl[0] / cl[20] - 1, atrPct: avg(tr.slice(0, 14)) / cl[0], atrRatio: avg(tr.slice(0, 5)) / avg(tr.slice(0, 20)),
      prior20hi: mx(hi.slice(1, 21)), prior20lo: mn(lo.slice(1, 21)), volRatio: va > 0 ? vo[0] / va : NaN, lastUp: cl[0] > cl[1], streak,
      rangeRatio: (mx(hi.slice(0, 10)) - mn(lo.slice(0, 10))) / (mx(hi.slice(0, 40)) - mn(lo.slice(0, 40))), lastClose: cl[0],
    };
  };

  // ---------- AGENTS: Bull (B1-B6) vs Bear (R1-R6) ----------
  QT.BULL_NAMES = ['above ~20-DMA', '~20-DMA above ~50-DMA (uptrend)', 'upper half of 52-week range', 'up >0.5% today', 'Nifty trend positive', 'oversold >4% under 20-DMA (bounce chance)'];
  QT.BEAR_NAMES = ['below ~20-DMA', '~20-DMA below ~50-DMA (downtrend)', 'lower half of 52-week range', 'down >0.5% today', 'Nifty trend negative', 'stretched >4% over 20-DMA (pullback risk)'];
  QT.agents = function (sym, spot, ind, niftyTS) {
    const day = spot / ind.prevClose - 1;
    const pos = ind.hi52 === ind.lo52 ? 0.5 : (spot - ind.lo52) / (ind.hi52 - ind.lo52);
    const nf = sym === 'NIFTY', hasN = typeof niftyTS === 'number';
    const B = [spot > ind.ma20, ind.ma20 > ind.ma50, pos >= 0.5, day > 0.005, !nf && hasN && niftyTS >= 1, spot < ind.ma20 * 0.96].map(Number);
    const R = [spot < ind.ma20, ind.ma20 < ind.ma50, pos < 0.5, day < -0.005, !nf && hasN && niftyTS <= -1, spot > ind.ma20 * 1.04].map(Number);
    const ts = (spot > ind.ma20 ? 1 : -1) + (ind.ma20 > ind.ma50 ? 1 : -1) + (pos >= 0.5 ? 1 : -1) + (day > 0.005 ? 1 : day < -0.005 ? -1 : 0);
    const bull = B.reduce((a, b) => a + b, 0), bear = R.reduce((a, b) => a + b, 0);
    return {
      day, pos, ts, B, R, bull, bear, edge: bull - bear,
      bullTxt: `Bull ${bull}/6: ` + (bull === 0 ? 'no technical case; only a reversal/bounce risk' : QT.BULL_NAMES.filter((_, i) => B[i]).join('; ') + '; '),
      bearTxt: `Bear ${bear}/6: ` + (bear === 0 ? 'no technical case; only risks: time decay and a reversal hitting the stop-loss' : QT.BEAR_NAMES.filter((_, i) => R[i]).join('; ') + '; '),
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

  // ---------- TRADE PLANNER ----------
  const RULE_NAMES = ['expiry rule', 'breakeven too far', 'credit yield <10%', 'short strike too close', 'support/resistance', 'open interest', 'wide bid-ask', 'low volume', 'straddle cost >1/2 range', 'confirm earnings/news within 2 wks', 'reward<risk', 'trend/support not clear', 'no consolidation pattern'];
  QT.RULE_LABELS = ['Expiry', 'Breakeven', 'Credit yield', 'Cushion', 'Support/Resist', 'Open interest', 'Bid-ask', 'Volume', 'Straddle cost', 'Event', 'Reward:Risk', 'Trend & support', 'Consolidation'];

  QT.buildTrade = function (c) {
    const { sym, spot, ind, vix, S, strat, expiry, today, lot, chain } = c;
    const st = QT.STRATS[strat], dte = QT.daysBetween(today, expiry);
    const iv = (vix / 100) * (sym === 'NIFTY' ? 1 : S.ivMult), T = Math.max(1, dte) / 365, T2 = Math.max(1, dte - S.holdDays) / 365;
    const step = QT.strikeStep(sym, spot), atm = Math.round(spot / step) * step;
    const cushion = Math.round((spot * iv * Math.sqrt(T)) / step) * step;
    let W = Math.max(step, Math.round((spot * (sym === 'NIFTY' ? S.widthNifty : S.widthStock)) / step) * step);
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
    const sg = (l) => (l.a === 'B' ? 1 : -1);
    const net = r2(legs.reduce((s, l) => s + sg(l) * l.p, 0)), debit = net > 0;
    const netAt = (sp, TT) => legs.reduce((s, l) => s + sg(l) * QT.bs(l.t, sp, l.K, TT, S.rf, iv), 0);
    const m0 = netAt(spot, T);
    const wing = !debit ? (strat === 10 ? Math.abs(legs[2].K - legs[0].K) : Math.abs(legs[0].K - legs[1].K)) : null;
    const maxLossPS = Math.max(0.05, debit ? net : wing + net);

    // target / SL spot (Trade Planner cols CL / CM)
    const sT = st.bias === 'U' ? spot * (1 + S.targetPct) : st.bias === 'D' ? spot * (1 - S.targetPct) : strat <= 8 ? spot * (1 + S.targetPct) : spot;
    const sSL = st.bias === 'U' ? spot * (1 - S.slPct) : st.bias === 'D' ? spot * (1 + S.slPct) : strat <= 8 ? spot : spot * (1 + S.targetPct);
    const profitPS = !debit ? r2(Math.max(0.05, Math.abs(net) * S.creditTP)) : r2(Math.max(0.05, netAt(sT, T2) - m0));
    const lossPS = !debit ? r2(Math.min(maxLossPS, Math.max(0.05, Math.abs(net)))) : r2(Math.min(maxLossPS, Math.max(0.05, m0 - netAt(sSL, T2))));
    const exitTarget = Math.round(Math.abs(net + profitPS) * 20) / 20;
    const exitSL = Math.round((net > 0 ? Math.max(0, net - lossPS) : Math.abs(net - lossPS)) * 20) / 20;
    const lots = Math.min(S.maxLots, Math.max(1, Math.ceil(S.profitGoal / (lot * profitPS)))), qty = lots * lot;
    const capital = Math.round(debit ? qty * net : qty * maxLossPS);

    // expiry payoff scan (for max profit display)
    const Ks = legs.map((l) => l.K), pts = [0, ...Ks, Math.max(...Ks) * 2];
    const pay = (x) => legs.reduce((s, l) => s + sg(l) * Math.max(0, l.t === 'CE' ? x - l.K : l.K - x), 0) - net;
    const unlimited = legs.filter((l) => l.a === 'B' && l.t === 'CE').length > legs.filter((l) => l.a === 'S' && l.t === 'CE').length;
    const maxProfit = unlimited ? null : r2(Math.max(...pts.map(pay)));

    const auto = S.expiryMode === 'auto';
    const exitDays = auto ? S.exitBefore : Math.min(S.exitBefore, Math.max(1, Math.floor(dte / 4)));
    const exitBy = debit ? QT.addDays(expiry, -exitDays) : QT.addDays(expiry, -Math.min(2, Math.max(0, dte - 1)));

    // ---- 11 book-rule checks (Trade Planner CU..DE) ----
    const rules = [], add = (res, note) => rules.push({ res, note: note || '' });
    let e1 = debit ? (dte >= S.minDTEBuy ? 'PASS' : 'FAIL') : dte <= S.maxDTESell ? 'PASS' : 'FAIL';
    if (e1 === 'FAIL' && !auto) e1 = 'WARN';
    add(e1, debit ? `${dte}d vs min ${S.minDTEBuy}` : `${dte}d vs max ${S.maxDTESell}`);
    if (strat <= 4) {
      const be = strat === 1 || strat === 3 ? legs[0].K + net : legs[0].K - net;
      const lim = iv * Math.sqrt(Math.max(1, dte - S.exitBefore) / 365), dist = Math.abs(be - spot) / spot;
      add(dist <= lim ? 'PASS' : 'FAIL', `BE ${r1(be)} is ${(dist * 100).toFixed(1)}% away, 1-sigma ${(lim * 100).toFixed(1)}%`);
    } else add('n/a');
    if (!debit) { const y = -net / wing; add(y >= S.minYield ? 'PASS' : 'FAIL', `yield ${(y * 100).toFixed(1)}% of width ${wing}`); } else add('n/a');
    if ([5, 6, 9].includes(strat)) {
      const need = 0.9 * spot * iv * Math.sqrt(T);
      const d = strat === 5 ? spot - legs[0].K : strat === 6 ? legs[0].K - spot : Math.min(spot - legs[0].K, legs[2].K - spot);
      add(d >= need ? 'PASS' : 'FAIL', `cushion ${r1(d)} vs need ${r1(need)}`);
    } else add('n/a');
    if ([5, 6, 9].includes(strat)) {
      const ok = strat === 5 ? legs[0].K <= ind.ma20 : strat === 6 ? legs[0].K >= ind.ma20 : legs[0].K <= ind.ma20 && legs[2].K >= ind.ma20;
      add(ok ? 'PASS' : 'FAIL', `~20-DMA ${r1(ind.ma20)}`);
    } else add('n/a');
    const oiV = legs.filter((l) => l.oi != null).map((l) => l.oi);
    if (oiV.length < legs.length) add('WARN', 'open interest not verified (MODEL prices)');
    else add(Math.min(...oiV) >= S.minOI ? 'PASS' : 'FAIL', `min OI ${Math.round(Math.min(...oiV))} contracts`);
    const baV = legs.filter((l) => l.ba != null).map((l) => l.ba);
    if (!baV.length) add('n/a'); else add(Math.max(...baV) > S.maxBA ? 'WARN' : 'PASS', `max bid-ask ${(Math.max(...baV) * 100).toFixed(1)}%`);
    if (sym === 'NIFTY' || !ind.avgVol) add('n/a'); else add(ind.avgVol >= S.minVol ? 'PASS' : 'WARN', `avg volume ${Math.round(ind.avgVol).toLocaleString('en-IN')}`);
    if (strat === 7 || strat === 8) { const lb = dte < 75 ? 40 : dte < 105 ? 60 : 80, rg = ind['hi' + lb] - ind['lo' + lb]; add(net < 0.5 * rg ? 'PASS' : 'FAIL', `cost ${net} vs half of ${lb}-day range ${r1(0.5 * rg)}`); } else add('n/a');
    add(strat === 7 || strat === 8 ? 'WARN' : 'n/a', strat === 7 || strat === 8 ? 'confirm results/news within ~2 weeks' : '');
    add(profitPS / lossPS >= 1 ? 'PASS' : 'WARN', `reward ${profitPS} vs risk ${lossPS}`);
    // book stock-selection conditions the workbook could only describe: trend + clear support/resistance, and consolidation (flag/pennant) for straddles
    if (st.bias === 'U') add(spot > ind.ma20 && ind.ma20 >= ind.ma50 ? 'PASS' : 'WARN', `spot ${r1(spot)} vs 20-DMA ${r1(ind.ma20)} / 50-DMA ${r1(ind.ma50)} (support below)`);
    else if (st.bias === 'D') add(spot < ind.ma20 && ind.ma20 <= ind.ma50 ? 'PASS' : 'WARN', `spot ${r1(spot)} vs 20-DMA ${r1(ind.ma20)} / 50-DMA ${r1(ind.ma50)} (resistance above)`);
    else add('n/a');
    if (strat === 7 || strat === 8) add(ind.atrRatio < 0.85 || ind.rangeRatio < 0.6 ? 'PASS' : 'WARN', `ATR5/ATR20 ${ind.atrRatio.toFixed(2)}, 10d/40d range ${ind.rangeRatio.toFixed(2)}`); else add('n/a');
    const fails = rules.map((r, i) => (r.res === 'FAIL' ? 'FAIL: ' + RULE_NAMES[i] + '; ' : '')).join('');
    const warns = rules.map((r, i) => (r.res === 'WARN' ? 'WARN: ' + RULE_NAMES[i] + '; ' : '')).join('');
    const gate = fails ? 'FAIL' : warns ? 'PASS (warnings)' : 'PASS';
    const details = !fails && !warns ? 'All book rules pass' : fails + warns;

    // ---- display texts (Trade Planner cols E, P, Q, R, Y) ----
    const useStr = strat <= 8 ? 'U' : 'N';
    const buyArea = st.bias === 'U' ? `${r1(Math.min(spot, Math.max(ind.ma20, spot * 0.985)))} - ${r1(spot)}` : st.bias === 'D' ? `${r1(spot)} - ${r1(Math.max(spot, Math.min(ind.ma20, spot * 1.015)))}` : `${r1(spot * 0.995)} - ${r1(spot * 1.005)}`;
    const targetTxt = st.bias === 'N' ? (strat <= 8 ? `Needs breakout beyond ${Math.round(legs[1].K - net)} / ${Math.round(legs[0].K + net)}` : strat === 9 ? `Stay inside ${Math.round(legs[0].K - Math.abs(net))} - ${Math.round(legs[2].K + Math.abs(net))}` : `Pin near ${legs[0].K} (BEP ${Math.round(legs[2].K - Math.abs(net))} - ${Math.round(legs[0].K + Math.abs(net))})`) : 'Target ' + r1(sT);
    const slTxt = st.bias === 'U' ? 'Exit if spot < ' + r1(sSL) : st.bias === 'D' ? 'Exit if spot > ' + r1(sSL) : strat <= 8 ? 'Exit at SL premium or if still flat at 1/2 time' : 'Exit if spot closes outside range / at SL premium';
    const plan = `Exit at ${exitTarget} (target) or ${exitSL} (SL); latest ${QT.ddmmm(exitBy)}${debit ? ' (never hold the final month)' : ' (avoid last 2 days)'}; exit early if ` +
      (st.bias === 'U' ? 'spot closes below ~20-DMA ' + r1(ind.ma20) : st.bias === 'D' ? 'spot closes above ~20-DMA ' + r1(ind.ma20) : 'price leaves the expected range') + ' (entry reason gone)';
    const ticket = legs.map((l) => `${l.a === 'B' ? 'BUY' : 'SELL'} ${lots}L ${sym} ${QT.ddmmm(expiry)} ${l.K} ${l.t} @~${l.p}`);
    // range for neutral credit strategies (entry-reason exit)
    const range = strat === 9 ? [legs[0].K - Math.abs(net), legs[2].K + Math.abs(net)] : strat === 10 ? [legs[2].K - Math.abs(net), legs[0].K + Math.abs(net)] : null;

    return {
      sym, spot, strat, stratName: st.name, view: st.view, bias: st.bias, expiry, dte, lot, lots, qty, net, debit, step, W, legs, ticket,
      maxLoss: r2(maxLossPS), maxProfit, tpPnl: profitPS, slPnl: -lossPS, profitAtTarget: Math.round(profitPS * qty), lossAtSL: Math.round(lossPS * qty),
      exitTarget, exitSL, capital, margin: capital, buyArea, targetTxt, slTxt, plan, targetSpot: st.bias === 'N' ? null : r2(sT), slSpot: st.bias === 'N' ? null : r2(sSL), range,
      exitBy, src: legs.every((l) => l.src === 'LIVE') ? 'LIVE option prices' : 'MODEL prices - verify', rules, gate, details, fails: fails ? fails.split('; ').filter(Boolean) : [], warns: warns ? warns.split('; ').filter(Boolean) : [], pass: !fails,
    };
  };

  // ---------- AGENT 2: history & movement ----------
  // Each check votes +1 (supports the trade), -1 (opposes) or 0. d = +1 for bullish plan, -1 for bearish plan.
  QT.agent2 = function (row, ctx) {
    const { ind, nind, hist, trades, S } = ctx, strat = row.strat, bias = row.bias, sym = row.sym, c = row.sig || row.spot, debit = row.debit;
    const ch = [], add = (name, vote, note) => ch.push({ name, vote, note });
    const pc = (x) => (x * 100).toFixed(1) + '%', sc = (x, th) => (x > th ? 1 : x < -th ? -1 : 0), d = bias === 'U' ? 1 : bias === 'D' ? -1 : 0;
    const mine = trades.filter((t) => t.sym === sym && t.strat === strat), allS = trades.filter((t) => t.strat === strat);
    const wr = (a) => a.filter((t) => t.pnl > 0).length / a.length;
    const historyVote = () => {
      if (mine.length >= 3) { const w = wr(mine); return [w >= 0.55 ? 1 : w <= 0.34 ? -1 : 0, `${sym} ${QT.STRATS[strat].name}: ${mine.length} past paper trades, win rate ${(w * 100).toFixed(0)}%`]; }
      if (allS.length >= 8) { const w = wr(allS); return [w >= 0.55 ? 1 : w <= 0.34 ? -1 : 0, `${QT.STRATS[strat].name} overall: ${allS.length} trades, win rate ${(w * 100).toFixed(0)}%`]; }
      return [0, 'no paper-trade history yet'];
    };
    if (d !== 0) {
      add('5-day momentum', sc(ind.roc5 * d, 0.005), `5-day change ${pc(ind.roc5)}`);
      add('20-day momentum', sc(ind.roc20 * d, 0.02), `20-day change ${pc(ind.roc20)}`);
      const r = d > 0 ? ind.rsi : 100 - ind.rsi; add('RSI(14) health', r >= 50 && r <= 72 ? 1 : r > 78 || r < 40 ? -1 : 0, `RSI ${ind.rsi.toFixed(0)}${r > 78 ? ' (stretched)' : r < 40 ? ' (weak)' : ''}`);
      const bo = d > 0 ? (c > ind.prior20hi ? 1 : c < ind.prior20lo ? -1 : 0) : c < ind.prior20lo ? 1 : c > ind.prior20hi ? -1 : 0; add('20-day breakout / breakdown', bo, `prior 20d range ${QT.r1(ind.prior20lo)}-${QT.r1(ind.prior20hi)}`);
      add('Volume confirmation', isFinite(ind.volRatio) && ind.volRatio > 1.2 ? ((ind.lastUp ? d > 0 : d < 0) ? 1 : -1) : 0, isFinite(ind.volRatio) ? `last-day volume ${ind.volRatio.toFixed(2)}x average, ${ind.lastUp ? 'up' : 'down'} day` : 'volume n/a');
      add('Strength vs Nifty (20d)', sym !== 'NIFTY' && nind ? sc((ind.roc20 - nind.roc20) * d, 0.01) : 0, sym !== 'NIFTY' && nind ? `stock ${pc(ind.roc20)} vs Nifty ${pc(nind.roc20)}` : 'n/a for index');
      if (hist && hist.length >= 3) { const mv = ((hist[0] - hist[2]) / hist[2]) * d; add('Intraday closed-candle momentum', sc(mv, 0.001), `last 3 closed candles ${pc((hist[0] - hist[2]) / hist[2])}`); } else add('Intraday closed-candle momentum', 0, 'not enough candles');
      const room = d > 0 ? (ind.hi52 - c) / c : (c - ind.lo52) / c; add('Room to run (52W level)', room >= 0.03 ? 1 : room <= 0.01 ? -1 : 0, `${pc(room)} to the ${d > 0 ? '52W high' : '52W low'}`);
      const em = ind.atrPct * Math.sqrt(S.holdDays); add('Movement big enough for target', debit ? (em >= S.targetPct ? 1 : em < S.targetPct * 0.5 ? -1 : 0) : 0, `ATR ${pc(ind.atrPct)}/day -> ~${pc(em)} in ${S.holdDays}d vs target ${pc(S.targetPct)}`);
      const [hv, hn] = historyVote(); add('Own paper-trade history', hv, hn);
    } else if (strat === 7 || strat === 8) { // long volatility: want a coiled stock
      add('Volatility contraction', ind.atrRatio < 0.8 ? 1 : ind.atrRatio > 1.3 ? -1 : 0, `ATR5/ATR20 ${ind.atrRatio.toFixed(2)}`);
      add('Range tightness (10d vs 40d)', ind.rangeRatio < 0.5 ? 1 : ind.rangeRatio > 0.9 ? -1 : 0, `10d/40d range ${ind.rangeRatio.toFixed(2)}`);
      add('Volume dry-up', isFinite(ind.volRatio) ? (ind.volRatio < 0.9 ? 1 : ind.volRatio > 1.5 ? -1 : 0) : 0, isFinite(ind.volRatio) ? `last-day volume ${ind.volRatio.toFixed(2)}x` : 'n/a');
      add('RSI coiled (40-60)', ind.rsi >= 40 && ind.rsi <= 60 ? 1 : 0, `RSI ${ind.rsi.toFixed(0)}`);
      const em = ind.atrPct * Math.sqrt(Math.max(1, row.dte - S.exitBefore)); add('Typical move vs straddle cost', em >= row.net / row.spot ? 1 : -1, `ATR-based move ${pc(em)} vs cost ${pc(row.net / row.spot)}`);
      const [hv, hn] = historyVote(); add('Own paper-trade history', hv, hn);
    } else { // credit range plays (9, 10): want a quiet, range-bound stock
      add('Quiet 20-day trend', Math.abs(ind.roc20) < 0.03 ? 1 : Math.abs(ind.roc20) > 0.06 ? -1 : 0, `20-day change ${pc(ind.roc20)}`);
      add('RSI neutral (40-60)', ind.rsi >= 40 && ind.rsi <= 60 ? 1 : ind.rsi < 30 || ind.rsi > 70 ? -1 : 0, `RSI ${ind.rsi.toFixed(0)}`);
      add('Volatility not expanding', ind.atrRatio <= 1 ? 1 : ind.atrRatio > 1.3 ? -1 : 0, `ATR5/ATR20 ${ind.atrRatio.toFixed(2)}`);
      add('Inside prior 20-day range', c <= ind.prior20hi && c >= ind.prior20lo ? 1 : -1, `prior 20d range ${QT.r1(ind.prior20lo)}-${QT.r1(ind.prior20hi)}`);
      if (hist && hist.length >= 3) { const mv = Math.abs((hist[0] - hist[2]) / hist[2]); add('Intraday calm', mv < 0.005 ? 1 : mv > 0.015 ? -1 : 0, `last 3 closed candles moved ${pc(mv)}`); } else add('Intraday calm', 0, 'not enough candles');
      const [hv, hn] = historyVote(); add('Own paper-trade history', hv, hn);
    }
    const score = ch.reduce((a, x) => a + x.vote, 0), n = ch.length, min = { lenient: -2, normal: 0, strict: 2 }[S.a2Strict] ?? 0;
    const opinion = score >= 2 ? 'SUPPORT' : score <= -2 ? 'OPPOSE' : 'NEUTRAL';
    const lines = ch.map((x) => `${x.vote > 0 ? '+' : x.vote < 0 ? '-' : '0'} ${x.name}: ${x.note}`).join('; ');
    return { checks: ch, score, n, min, opinion, pass: score >= min, conv2: Math.max(0, Math.min(100, Math.round(50 + (100 * score) / n))), text: lines,
      support: ch.filter((x) => x.vote > 0).length, oppose: ch.filter((x) => x.vote < 0).length };
  };
  QT.r1 = r1;

  // ---------- AGENTS + JUDGE for one symbol (always builds the plan, like the Trade Planner sheet) ----------
  QT.evaluate = function (sym, snap, S, chainMap, expiries) {
    const ov = S.spotOv && +S.spotOv[sym] > 0 ? +S.spotOv[sym] : null;
    const spot = ov || snap.quotes[sym], ind = snap.ind[sym];
    if (!spot || !ind) return { sym, decision: 'NO DATA', reason: 'No price data loaded', verdict: 'No data - wait for the feed or type a spot override', rules: [] };
    const sig = ov || (S.closedCandle && snap.sig && snap.sig[sym]) || spot; // last CLOSED candle close (closed-candle check ON by default)
    const ag = QT.agents(sym, sig, ind, snap.niftyTS);
    const forced = S.force && +S.force[sym] >= 1 && +S.force[sym] <= 10 ? +S.force[sym] : null;
    const strat = forced || QT.pickStrategy(ag.ts, ag.day, snap.vix, S.vixThreshold);
    const st = QT.STRATS[strat];
    const base = { sym, spot, sig, ag, strat, stratName: st.name, view: st.view, bias: st.bias, forced: !!forced, override: !!ov };
    const series = sym === 'NIFTY' ? expiries.index : expiries.stock;
    const expiry = QT.pickExpiry(series, S, st.exp);
    if (!expiry) return { ...base, decision: 'NO DATA', reason: 'No expiry available', rules: [] };
    const tr = QT.buildTrade({ sym, spot, ind, vix: snap.vix, S, strat, expiry, today: snap.today, lot: QT.UNIVERSE[sym].lot, chain: chainMap && chainMap[sym + '|' + expiry] });
    // CANDIDATE (Agents col S)
    let cand = '';
    if (ag.edge >= S.minEdge && st.bias === 'U') cand = 'BUY';
    else if (ag.edge <= -S.minEdge && st.bias === 'D') cand = 'SELL';
    else if (S.neutralTrade && st.bias === 'N') cand = 'NEUTRAL'; // extension: workbook only plans 7-10
    const full = { ...base, ...tr, candidate: cand };
    if (!S.strat[strat]) return { ...full, decision: 'IGNORE', reason: `strategy #${strat} (${st.name}) is OFF in settings`, verdict: `IGNORE - strategy #${strat} (${st.name}) is switched OFF` };
    if (!cand) return { ...full, decision: 'IGNORE', reason: `no clear edge (Bull ${ag.bull} vs Bear ${ag.bear}) or the planner strategy does not match the direction`, verdict: `IGNORE - Bull ${ag.bull} vs Bear ${ag.bear}: edge ${ag.edge > 0 ? '+' : ''}${ag.edge} is below ${S.minEdge} or does not match planner strategy` };
    if (!tr.pass) return { ...full, decision: 'IGNORE', reason: 'book rule ' + tr.details, verdict: `IGNORE - candidate ${cand} but book rules failed: ${tr.details}` };
    const conv1 = cand === 'NEUTRAL' ? 50 : Math.round((100 * Math.abs(ag.edge)) / 6);
    // ---- AGENT 2: history & movement check (runs only when Agent 1 / the book has triggered) ----
    let a2 = null;
    if (S.a2Enabled) {
      a2 = QT.agent2(full, { ind, nind: snap.ind.NIFTY, hist: (snap.hist && snap.hist[sym]) || [], trades: snap.trades || [], S });
      if (!a2.pass) return { ...full, a2, conv1, decision: 'IGNORE', reason: `Agent 2 (history & movement) ${a2.opinion} ${a2.score >= 0 ? '+' : ''}${a2.score}/${a2.n} - below minimum ${a2.min}`,
        verdict: `IGNORE - Agent 1 (book) triggered ${cand} (conviction ${conv1}) but Agent 2 does not confirm: ${a2.opinion} ${a2.score >= 0 ? '+' : ''}${a2.score}/${a2.n}. ${a2.text}` };
    }
    const conviction = a2 ? Math.round((1 - S.a2Weight) * conv1 + S.a2Weight * a2.conv2) : conv1;
    const a1txt = `Agent 1 (book): Bull ${ag.bull} vs Bear ${ag.bear} (edge ${ag.edge > 0 ? '+' : ''}${ag.edge}), book rules ${tr.gate}.`;
    const a2txt = a2 ? ` Agent 2 (history & movement): ${a2.opinion} ${a2.score >= 0 ? '+' : ''}${a2.score}/${a2.n}.` : '';
    const verdict = `${cand} - ${a1txt}${a2txt} Final conviction ${conviction}. Plan: ${tr.stratName}. ${tr.plan}`;
    return { ...full, decision: cand, conviction, conv1, a2, verdict };
  };
})();

/* Options Desk v3 - broker-style UI + full workbook concept (Agents, Judge, Planner, 10 Logics, Alerts) */
(function () {
  const QT = globalThis.QT;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const inr = (x) => (x == null || isNaN(x) ? '-' : (x < 0 ? '-' : '') + '₹' + Math.abs(Math.round(x)).toLocaleString('en-IN'));
  const num = (x, d = 2) => (x == null || isNaN(x) ? '-' : Number(x).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const cls = (x) => (x > 0 ? 'pos' : x < 0 ? 'neg' : '');
  const hhmm = (iso) => new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
  const dmy = (iso) => new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: 'Asia/Kolkata' });

  let S = { ...QT.DEFAULTS, strat: { ...QT.DEFAULTS.strat }, favs: [], force: {}, spotOv: {}, tuneLog: [], lastTuneN: 0 };
  try { const j = JSON.parse(localStorage.getItem('qt_cfg4')); if (j) S = { ...S, ...j, strat: { ...S.strat, ...(j.strat || {}) }, force: j.force || {}, spotOv: j.spotOv || {}, tuneLog: j.tuneLog || [] }; } catch (e) {}
  const saveS = () => localStorage.setItem('qt_cfg4', JSON.stringify(S));
  if ((S.cfgVer || 0) < 7) { S.targetBasis = S.exitOnPremiumTarget === false ? 'spot' : 'premium'; S.slBasis = 'premium'; S.targetConfirm = 1; S.slConfirm = 2; S.lockProfit = false; S.cfgVer = 7; saveS(); }
  if ((S.cfgVer || 0) < 6) { S.sizing = 'workbook'; S.strictBook = true; S.lotSource = 'book'; S.cfgVer = 6; saveS(); }
  QT.Paper.load(); QT.Alerts.load(); QT.Run.load();
  let freshStart = false;
  try { if (localStorage.getItem('qt_dataver') !== '6') { QT.Paper.reset(S.capital); QT.Alerts.log = []; QT.Alerts.seen = {}; QT.Alerts.save(); QT.Run.clear(); localStorage.setItem('qt_dataver', '6'); freshStart = true; } } catch (e) {}
  if (!Array.isArray(S.days)) S.days = [1, 2, 3, 4, 5];

  const A = { tab: 'watch', wl: 'sig', q: '', ag: 'debate', df: 'all', pq: '', ord: 'all', pos: 'open', hf: 'all', more: 'set', hseg: 'reg', modal: null, hist: {}, feed: null, snap: null, rows: [], ignored: [], all: {}, order: [],
    expiries: { stock: [], index: [] }, status: '', last: null, lastOk: null, busy: false, toast: '', chains: {}, open: {}, sheet: null, ind: {}, sig: null, sigTs: {}, streak: {}, tried: {}, cid: null, dirty: false };
  const SYMS = Object.keys(QT.UNIVERSE);
  SYMS.forEach((s) => (QT.UNIVERSE[s].wlot = QT.UNIVERSE[s].lot));
  try { const c = JSON.parse(localStorage.getItem('qt_lots')); if (c && c.m && S.mode === 'live') SYMS.forEach((s) => { if (c.m[s]) { QT.UNIVERSE[s].exch = c.m[s]; if (S.lotSource === 'upstox') { QT.UNIVERSE[s].lot = c.m[s]; QT.UNIVERSE[s].live = true; } } }); } catch (e) {}

  // ---------- data refresh ----------
  async function pool(items, n, fn) {
    let i = 0;
    await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; try { await fn(items[k]); } catch (e) { A.lastErr = e.message; } } }));
  }
  const keyOf = (r) => r.sym + '|' + r.decision + '|' + r.strat;
  const isTrig = (r) => r && ['BUY', 'SELL', 'NEUTRAL'].includes(r.decision);

  async function refresh() {
    if (A.busy) return; A.busy = true; A.status = 'Updating…'; paintHeader();
    try {
      if (S.mode === 'live' && !S.token.trim()) throw new Error('Add your Upstox token in More > Settings, or switch to Demo');
      if (S.mode === 'custom' && !S.feedUrl.trim()) throw new Error('Add the custom feed URL in More > Settings');
      const want = S.mode === 'demo' ? 'DEMO' : 'LIVE', fid = S.mode + '|' + S.token.trim() + '|' + S.feedUrl.trim();
      if (!A.feed || A.feed.name !== want || A.fid !== fid) {
        A.fid = fid;
        A.feed = QT.makeFeed(S); A.ind = {}; A.indDay = null; A.sig = null; A.expiries = { stock: [], index: [] }; A.cid = null; A.streak = {};
      }
      A.feed.tf = S.candleTf; A.feed.holidays = S.holidays; if (S.mode === 'custom') { try { A.feed.h = JSON.parse(S.feedHeaders || '{}'); } catch (e) {} }
      const today = QT.istDate();
      if (A.indDay !== today) { A.ind = {}; A.indDay = today; }
      const q = await A.feed.quotes();
      A.lastOk = Date.now();
      await pool(SYMS.filter((s) => !A.ind[s]), 5, async (s) => { A.ind[s] = QT.indicators(await A.feed.candles(s)); });
      // lot sizes: take the exchange lot size from Upstox (the workbook list can be out of date)
      if (S.mode === 'live' && S.lotSync && A.lotDay !== today) { A.lotDay = today; await lotCheck(false); }
      if (!A.expiries.stock.length) {
        let st = [], ix = [];
        try { [st, ix] = await Promise.all([A.feed.expiries('RELIANCE'), A.feed.expiries('NIFTY')]); } catch (e) {}
        const fb = QT.fallbackExpiries(today, S.holidays);
        A.expiries = { stock: QT.monthly(st.length ? st : fb, today), index: QT.monthly(ix.length ? ix : fb, today), fallback: !st.length };
      }
      const vix = q.vix || (A.snap && A.snap.vix) || QT.DEMO_VIX;
      const cid = QT.candleId(S.candleTf);
      const newBoundary = A.cid !== cid || A.tfUsed !== S.candleTf || !S.closedCandle;
      let evaluated = false;
      if (newBoundary || A.dirty || !A.sig) {
        evaluated = true;
        // CLOSED-CANDLE LOGIC: signals use only the last fully closed candle
        const sig = {}, sigTs = {};
        await pool(SYMS, 5, async (s) => { const c = await A.feed.closed(s, S.candleTf); if (c) { sig[s] = c.close; sigTs[s] = c.ts; A.hist[s] = c.hist || [c.close]; } });
        A.sig = sig; A.sigTs = sigTs; A.tfUsed = S.candleTf; A.dirty = false;
        if (newBoundary) A.tried = {};
        const snap = { quotes: q.q, ind: A.ind, vix, today, sig, hist: A.hist, trades: QT.Paper.closed(), niftyTS: undefined };
        const nov = S.spotOv.NIFTY > 0 ? +S.spotOv.NIFTY : null, ns = nov || (S.closedCandle && sig.NIFTY) || q.q.NIFTY;
        if (A.ind.NIFTY && ns) snap.niftyTS = QT.agents('NIFTY', ns, A.ind.NIFTY, undefined).ts;
        let rows = SYMS.map((s) => QT.evaluate(s, snap, S, null, A.expiries));
        const cands = rows.filter((r) => isTrig(r) || (r.candidate && r.expiry && r.decision === 'IGNORE'));
        const chains = {};
        await pool(cands, 4, async (r) => { chains[r.sym + '|' + r.expiry] = await A.feed.chain(r.sym, r.expiry); });
        rows = SYMS.map((s) => QT.evaluate(s, snap, S, chains, A.expiries));
        A.order = rows;
        A.rows = rows.filter(isTrig).sort((a, b) => b.conviction - a.conviction);
        A.ignored = rows.filter((r) => !isTrig(r));
        if (newBoundary) {
          const ns2 = {};
          A.rows.forEach((r) => { const p = A.streak[r.sym]; ns2[r.sym] = { key: keyOf(r), n: p && p.key === keyOf(r) ? p.n + 1 : 1 }; });
          A.streak = ns2; A.cid = cid;
        }
        A.rows.forEach((r) => (r.streak = (A.streak[r.sym] || { n: 1 }).n));
        A.all = {}; rows.forEach((r) => (A.all[r.sym] = r));
        QT.Paper.releaseLocks(A.all).forEach((s) => QT.Run.add(`${s}: trend reversed - re-entry lock released`));
        A.chains = chains;
        if (newBoundary) QT.Run.add(`Candle ${S.candleTf}m closed - ${A.rows.length} signal(s)` + (A.rows.length ? ': ' + A.rows.slice(0, 6).map((r) => `${r.sym} ${r.decision} ${r.conviction}`).join(', ') : ''));
        // alert: NEW SIGNAL once per day per trade, conviction >= threshold
        for (const r of A.rows) if (r.conviction >= S.alertMinConv) QT.Alerts.add(S, 'NEW SIGNAL', r.sym, `${r.decision} ${r.sym} (${r.stratName}) conviction ${r.conviction} | ${r.ticket.join(' | ')}`, 'sig|' + keyOf(r));
      }
      A.snap = { quotes: q.q, ind: A.ind, vix, today, sig: A.sig, hist: A.hist };
      // mark open paper positions
      // option prices of open positions are re-fetched on EVERY refresh (a failed fetch = no mark, never a stale one)
      const ch2 = { ...A.chains };
      const okeys = [...new Set(QT.Paper.open().map((t) => t.sym + '|' + t.expiry))].filter((k) => !(evaluated && A.chains[k]));
      await pool(okeys, 4, async (k) => { const [s, e] = k.split('|'); try { ch2[k] = await A.feed.chain(s, e); } catch (er) { delete ch2[k]; A.lastErr = er.message; } });
      A.chains = ch2;
      const ma = {}; SYMS.forEach((s) => { if (A.ind[s]) ma[s] = A.ind[s].ma20; });
      QT.Paper.markAll(S, q.q, ch2, today, A.sig, ma, vix).forEach((t) => { QT.Run.add(`EXIT ${t.sym} ${t.status}: net ${inr(t.pnl)}`); toast(`${t.sym} ${t.status}: ${inr(t.pnl)}`); QT.Alerts.add(S, t.status, t.sym, `${t.sym} ${t.stratName} ${t.status} @ spot ${t.exitSpot} | P&L ${inr(t.pnl)}`); });
      // AI tuning of filters from paper-trade history (only when enabled in Settings)
      const tuned = QT.Optimizer.autoTune(S);
      if (tuned.length) { saveS(); A.dirty = true; QT.Alerts.add(S, 'TUNING', '', 'AI tuning changed: ' + tuned.map((c) => `${c.label} (${c.reason})`).join(' | ')); toast('AI tuning applied ' + tuned.length + ' change(s)'); }
      // auto paper orders (only inside the trading time window)
      if (S.autoTrade && QT.canTrade(S, 'auto')) {
        let n = 0;
        for (const r of A.rows) {
          if (r.conviction < S.minConviction || (r.streak || 1) < S.confirmN) continue;
          const k = r.sym + '|' + A.cid; if (A.tried[k]) continue;
          if (QT.Paper.open().some((t) => t.sym === r.sym)) continue;
          if (QT.Paper.lockedFor(r, S)) { const lk = QT.Paper.lockedFor(r, S), kk = 'lock|' + r.sym + '|' + lk.tid; if (!A.tried[kk]) { A.tried[kk] = 1; QT.Run.add(`${r.sym}: re-entry locked after ${lk.why} - waiting for reversal`); } continue; }
          A.tried[k] = 1;
          const res = await placeOrder(r, 'auto');
          QT.Run.add(res.ok ? `ORDER ${r.sym} ${r.decision} ${r.stratName} ${res.trade.lots}L executed` : `ORDER ${r.sym} rejected: ${res.msg}`);
          if (res.ok) { n++; QT.Alerts.add(S, 'PAPER ENTRY', r.sym, `Auto-Registered ${r.decision} on ${r.sym} (${r.stratName}) @ Spot ${r.spot} | Ticket: ${r.ticket.join(' | ')} | Target Spot: ${r.targetSpot ?? '-'} | SL Spot: ${r.slSpot ?? '-'}`); }
        }
        if (n) toast(`Auto: ${n} paper order(s) executed`);
      }
      A.last = new Date(); A.status = '';
    } catch (e) { A.status = 'Error: ' + e.message; QT.Alerts.add(S, 'ERROR', 'Feed error', e.message, 'err|' + e.message.slice(0, 30) + '|' + Math.floor(Date.now() / 3600000)); }
    A.busy = false; render();
  }
  // compare the book's lot sizes with the exchange lot sizes (Upstox contract list); apply them only if Lot source = Upstox
  async function lotCheck(show) {
    if (S.mode !== 'live' || !A.feed || !A.feed.lotSize) { if (show) toast('Lot check needs the Upstox live feed'); return; }
    const diff = [];
    await pool(SYMS, 3, async (s) => { const l = await A.feed.lotSize(s); if (l) { QT.UNIVERSE[s].exch = l; if (l !== QT.UNIVERSE[s].wlot) diff.push(`${s}: book ${QT.UNIVERSE[s].wlot} vs exchange ${l}`); if (S.lotSource === 'upstox') { QT.UNIVERSE[s].lot = l; QT.UNIVERSE[s].live = true; } } });
    try { const m = {}; SYMS.forEach((s) => (m[s] = QT.UNIVERSE[s].exch || QT.UNIVERSE[s].lot)); localStorage.setItem('qt_lots', JSON.stringify({ d: QT.istDate(), m })); } catch (e) {}
    A.lotReport = { time: new Date().toISOString(), n: SYMS.filter((s) => QT.UNIVERSE[s].exch).length, diff };
    if (diff.length) { A.dirty = true; QT.Alerts.add(S, 'INFO', '', 'Lot size differs from the book for ' + diff.length + ' symbol(s): ' + diff.slice(0, 8).join(', '), 'lot|' + diff.length); }
    if (show) { toast(diff.length ? diff.length + ' lot size(s) differ from the book' : 'All lot sizes match the book'); render(); }
  }
  async function placeOrder(row, src) {
    let r = row, chain = null;
    try { chain = await A.feed.chain(row.sym, row.expiry); } catch (e) {}
    const spot = (S.spotOv[row.sym] > 0 ? +S.spotOv[row.sym] : A.snap.quotes[row.sym]) || row.spot;
    if (chain) { // re-price against the live chain and re-check the book rules at execution time
      const tr = QT.buildTrade({ sym: row.sym, spot, ind: A.ind[row.sym], vix: A.snap.vix, S, strat: row.strat, expiry: row.expiry, today: A.snap.today, lot: QT.UNIVERSE[row.sym].lot, chain });
      if (!tr.pass) { QT.Paper.logOrder({ sym: row.sym, stratName: row.stratName, src, lots: row.lots, qty: row.qty, expiry: row.expiry, signal: row.decision, status: 'REJECTED', reason: 'Book rules failed at execution: ' + tr.details, legs: [] }); QT.Paper.save(); return { ok: false, msg: 'Rules failed at execution' }; }
      r = { ...row, ...tr };
    }
    return QT.Paper.enter(r, S, A.snap.quotes, src, { candle: A.sigTs[row.sym], candleClose: A.sig && A.sig[row.sym], ma20: A.ind[row.sym].ma20, vix: A.snap.vix, sigRow: row });
  }
  function schedule() {
    clearInterval(A.timer);
    A.timer = setInterval(() => {
      if (S.mode !== 'demo' && QT.marketOpen() && A.lastOk && Date.now() - A.lastOk > 300000) QT.Alerts.add(S, 'DATA STALE', '', 'The data feed has not updated for more than 5 minutes during market hours.', 'stale|' + Math.floor(Date.now() / 3600000));
      if (S.mode === 'demo' || QT.marketOpen()) refresh();
    }, Math.max(15, S.refreshSec) * 1000);
  }
  function toast(m) { A.toast = m; paintToast(); setTimeout(() => { if (A.toast === m) { A.toast = ''; paintToast(); } }, 4000); }
  const paintToast = () => { const t = $('#toast'); t.textContent = A.toast; t.style.display = A.toast ? 'block' : 'none'; };

  const LOGO = '<svg class="logo" viewBox="0 0 64 64"><defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1e40af"/><stop offset="1" stop-color="#0ea5e9"/></linearGradient></defs><rect width="64" height="64" rx="15" fill="url(#lg)"/><path d="M10 46 L26 46 L40 22 L54 12" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" opacity=".9"/><rect x="14" y="28" width="6" height="16" rx="1.5" fill="#34d399"/><rect x="30" y="34" width="6" height="12" rx="1.5" fill="#f87171"/><rect x="45" y="18" width="6" height="14" rx="1.5" fill="#34d399"/></svg>';
  // ---------- header / nav ----------
  const IC = {
    watch: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
    agents: '<circle cx="8" cy="9" r="3"/><circle cx="17" cy="9" r="3"/><path d="M2 19c0-3 3-5 6-5s6 2 6 5M14 15c1-.6 2-1 3-1 3 0 5 2 5 5"/>',
    orders: '<path d="M5 4h14v16l-3-2-2 2-2-2-2 2-2-2-3 2z"/><path d="M9 9h6M9 13h6"/>',
    pos: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2M3 13h18"/>',
    hist: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  };
  const TABS = [['watch', 'Watch'], ['agents', 'Agents'], ['orders', 'Orders'], ['pos', 'Positions'], ['hist', 'History'], ['more', 'More']];
  function paintNav() { $('#nav').innerHTML = TABS.map(([k, l]) => `<button class="nb ${A.tab === k ? 'on' : ''}" data-tab="${k}"><svg viewBox="0 0 24 24">${IC[k]}</svg>${l}</button>`).join(''); }
  function dataMode() {
    if (S.mode === 'demo') return ['warn', '● DEMO'];
    const age = A.lastOk ? (Date.now() - A.lastOk) / 1000 : Infinity;
    return age <= S.maxAge && QT.marketOpen() ? ['on', '● LIVE'] : ['off', '● DELAYED'];
  }
  function paintHeader() {
    const s = A.snap, ph = QT.phase(S), [dc, dl] = dataMode();
    const nq = s ? s.quotes.NIFTY : null, nprev = s && A.ind.NIFTY ? A.ind.NIFTY.prevClose : null, nc = nq && nprev ? (nq / nprev - 1) * 100 : 0;
    const age = A.lastOk ? Math.round((Date.now() - A.lastOk) / 1000) : null;
    $('#hdr').innerHTML = `<div class="h1"><span class="brand">${LOGO} Options Desk</span><span><span class="pill ${dc}">${dl}${age != null && S.mode !== 'demo' ? ' ' + age + 's' : ''}</span> <button class="btn sm ghost" data-act="refresh">${A.busy ? '…' : '↻'}</button></span></div>
      <div class="idx"><span>NIFTY <b>${nq ? num(nq) : '-'}</b> <span class="${cls(nc)}">${nq ? (nc >= 0 ? '+' : '') + nc.toFixed(2) + '%' : ''}</span></span><span>VIX <b>${s ? s.vix.toFixed(2) : '-'}</b></span><span>Goal <b>${inr(S.profitGoal)}</b></span></div><div class="edu">Educational purpose only · not investment advice</div>
      <div class="st"><span class="pill ${ph.on ? 'on' : 'off'}">${esc(ph.label)}</span><span class="pill" id="phn">${ph.next ? esc(ph.next.label) + ' in --:--' : 'New orders ' + esc(S.tradeStart) + '–' + esc(S.tradeEnd)}</span><span class="pill">Candle ${S.candleTf}m · next close <b id="cd">--:--</b></span>${A.last ? `<span>upd ${A.last.toLocaleTimeString('en-IN', { hour12: false })}</span>` : ''}</div>
      ${A.status ? `<div class="sub ${/Error/.test(A.status) ? 'neg' : ''}">${esc(A.status)}</div>` : ''}`;
    tickClock();
  }
  function tickClock() {
    const ph = QT.phase(S), pe = $('#phn');
    if (pe && ph.next) { const sc = ph.next.secs; pe.textContent = `${ph.next.label} in ${String(Math.floor(sc / 3600)).padStart(2, '0')}:${String(Math.floor((sc % 3600) / 60)).padStart(2, '0')}:${String(sc % 60).padStart(2, '0')}`; }
    if (A.lastPhase !== ph.key) { if (A.lastPhase) QT.Run.add('Phase: ' + ph.label); A.lastPhase = ph.key; }
    const e = $('#cd'); if (e) { const sec = QT.nextCloseSecs(S.candleTf); e.textContent = String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0'); } }
  setInterval(tickClock, 1000);

  // ---------- helpers for views ----------
  function chgOf(sym) { const q = A.snap && A.snap.quotes[sym], p = A.ind[sym] && A.ind[sym].prevClose; return q && p ? { ltp: q, pct: (q / p - 1) * 100 } : { ltp: q, pct: 0 }; }
  const legHtml = (a, K, ty, px, pre) => `<span class="${ty === 'CE' ? 'ce' : 'pe'}">${pre ? pre + ' ' : ''}${a === 'B' ? 'BUY ' : 'SELL'} ${K} ${ty}${px != null ? ' @ ' + num(px) : ''}</span>`;
  const sideChips = (legs) => [...new Set(legs.map((l) => `${l.a === 'B' ? 'BUY' : 'SELL'} ${l.t}`))].map((x) => `<span class="chip ${x.endsWith('CE') ? 'CE' : 'PE'}">${x}</span>`).join(' ');
  const candleLine = (o) => (o.candle ? `<div class="sub">Closed ${o.tf || S.candleTf}m candle ${hhmm(o.candle)}${o.candleClose != null ? ' · close ' + num(o.candleClose) : ''}</div>` : '');
  const chip = (t, c) => `<span class="chip ${c || t}">${esc(t)}</span>`;
  const dec = (r) => (r.decision === 'NO DATA' ? 'NODATA' : r.decision);

  // why a triggered signal has / has not become an order (same checks, same order as the auto-trade loop)
  function whyOrder(r) {
    const P = QT.Paper, day = QT.istDate(), isT = (iso) => iso && new Date(new Date(iso).getTime() + 19800000).toISOString().slice(0, 10) === day;
    const op = P.open().find((t) => t.sym === r.sym);
    if (op) return { st: 'ORDERED', msg: `Order placed: ${op.id} (one symbol - one order)` };
    const lk = P.lockedFor(r, S); if (lk) return { st: 'LOCKED', msg: `Re-entry locked after ${lk.why}; waits for a trend reversal` };
    if (!S.autoTrade) return { st: 'MANUAL', msg: 'Auto-trade is OFF - place the order yourself' };
    if (!QT.canTrade(S, 'auto')) return { st: 'WAIT', msg: 'Not order time: ' + QT.phase(S).label };
    if (r.conviction < S.minConviction) return { st: 'BELOW', msg: `Conviction ${r.conviction} is below the minimum ${S.minConviction}` };
    if ((r.streak || 1) < S.confirmN) return { st: 'WAIT', msg: `Waiting for candle confirmation ${r.streak || 1}/${S.confirmN}` };
    if (P.open().length >= S.maxOpen) return { st: 'BLOCKED', msg: `Max open positions (${S.maxOpen}) reached` };
    if (P.st.trades.filter((t) => t.entryDay === day).length >= S.maxTradesPerDay) return { st: 'BLOCKED', msg: `Max trades per day (${S.maxTradesPerDay}) reached` };
    if (P.todayRealized() <= -P.equity(S) * S.dailyLossPct) return { st: 'BLOCKED', msg: 'Daily loss limit reached' };
    const sz = P.sizeInfo(r, S); if (sz.lots < 1) return { st: 'BLOCKED', msg: `Capital: book lots ${sz.wb} need margin ${sz.need}, allowed less - lots are never reduced` };
    const rej = P.st.orders.find((o) => o.sym === r.sym && o.status === 'REJECTED' && isT(o.time));
    if (rej) return { st: 'REJECTED', msg: 'Last order rejected: ' + rej.reason };
    return { st: 'READY', msg: 'Order will be placed on the next refresh' };
  }
  const wchip = (w) => `<span class="chip ${w.st === 'ORDERED' ? 'BUY' : w.st === 'READY' || w.st === 'WAIT' ? 'AUTO' : 'SELL'}">${w.st}</span>`;
  // ---------- Watchlist ----------
  function watch() {
    if (!A.snap) return `<div class="card">${A.busy ? 'Loading market data…' : 'Tap ↻ to load.'}<div class="sub">Demo mode works offline. For real prices add your Upstox token in More → Settings.</div></div>`;
    const sc = (s) => (isTrig(A.all[s]) ? A.all[s].conviction : -1);
    const tg = A.rows.filter((r) => r.decision !== 'NEUTRAL').length;
    let h = `<div class="card note sub">Triggered: <b>${A.rows.filter((r) => r.decision === 'BUY').length} BUY, ${A.rows.filter((r) => r.decision === 'SELL').length} SELL${A.rows.some((r) => r.decision === 'NEUTRAL') ? ', ' + A.rows.filter((r) => r.decision === 'NEUTRAL').length + ' NEUTRAL' : ''}</b> · Ignored ${A.ignored.filter((r) => r.decision === 'IGNORE').length} · No data ${A.ignored.filter((r) => r.decision === 'NO DATA').length}${tg || A.rows.length ? '' : ' — the plan is to stay out.'}</div>`;
    h += `<div class="seg">${[['sig', `Signals ${A.rows.length}`], ['all', 'All ' + SYMS.length], ['fav', '★ Favs']].map(([k, l]) => `<button class="${A.wl === k ? 'on' : ''}" data-act="wl" data-k="${k}">${l}</button>`).join('')}</div>`;
    h += `<input class="search" id="q" placeholder="Search symbol" value="${esc(A.q)}"><div id="wlist">${wlist(wlsyms())}</div>`;
    return h;
  }
  function wlsyms() {
    const q = A.q.trim().toUpperCase(); if (q) return SYMS.filter((s) => s.includes(q));
    if (A.wl === 'sig') return A.rows.map((r) => r.sym);
    if (A.wl === 'fav') return SYMS.filter((s) => S.favs.includes(s));
    return [...SYMS].sort((a, b) => (isTrig(A.all[b]) ? A.all[b].conviction : -1) - (isTrig(A.all[a]) ? A.all[a].conviction : -1) || SYMS.indexOf(a) - SYMS.indexOf(b));
  }
  function wlist(list) {
    return list.map((s) => {
      const c = chgOf(s), r = A.all[s], trig = isTrig(r);
      const sub = trig ? `${esc(r.stratName)} · conv ${r.conviction} · ${esc(whyOrder(r).msg)}` : r ? esc((r.reason || '').slice(0, 44)) : '';
      return `<div class="wr" data-act="sheet" data-s="${s}"><div><b>${S.favs.includes(s) ? '★ ' : ''}${QT.Paper.st.locks && QT.Paper.st.locks[s] ? '🔒 ' : ''}${s}</b> ${trig ? chip(r.decision) : ''}<span class="sub">${sub}</span></div><div class="rt"><b>${c.ltp ? num(c.ltp) : '-'}</b><span class="${cls(c.pct)}">${c.pct >= 0 ? '+' : ''}${c.pct.toFixed(2)}%</span></div></div>`;
    }).join('') || `<div class="card sub">${A.wl === 'fav' ? 'No favourites yet. Open a symbol and tap ★.' : A.wl === 'sig' ? 'No triggered signals on the last closed candle.' : 'No match'}</div>`;
  }

  // ---------- Symbol sheet: Agents debate + Judge + Planner + 11 rules ----------
  // plain-text agent transcript (Agent 1 -> Agent 2 -> Judge)
  function transcript(r) {
    const L = [`${r.sym}  spot ${num(r.spot)}  (closed ${S.candleTf}m candle ${r.sig != null ? num(r.sig) : '-'})`];
    if (r.ag) { L.push('', `AGENT 1 - BOOK RULES: planner strategy #${r.strat} ${r.stratName} (bias ${r.bias}); edge ${r.ag.edge > 0 ? '+' : ''}${r.ag.edge}; candidate ${r.candidate || 'none'}; book rules ${r.gate || '-'}`, '  ' + r.ag.bullTxt, '  ' + r.ag.bearTxt); if (r.details) L.push('  Rules: ' + r.details); }
    if (r.a2) { L.push('', `AGENT 2 - HISTORY & MOVEMENT: ${r.a2.opinion} ${r.a2.score >= 0 ? '+' : ''}${r.a2.score}/${r.a2.n}`); r.a2.checks.forEach((x) => L.push(`  ${x.vote > 0 ? '+' : x.vote < 0 ? '-' : '0'} ${x.name}: ${x.note}`)); }
    else L.push('', 'AGENT 2 - not run (' + (r.candidate ? 'Agent 1 book rules did not pass' : 'Agent 1 did not trigger') + ')');
    L.push('', `JUDGE: ${r.decision}${r.conviction ? ' (conviction ' + r.conviction + ')' : ''}`, '  ' + (r.verdict || r.reason || ''));
    return L.join('\n');
  }
  function ruleTable(r) {
    return r.rules && r.rules.length ? `<h4 style="margin-top:12px">Book rules gate · ${chip(r.gate || '', /FAIL/.test(r.gate) ? 'FAIL' : /warn/.test(r.gate) ? 'WARN' : 'PASS')}</h4>` + r.rules.map((x, i) => `<div class="rule"><span>${QT.RULE_LABELS[i]}<div class="n">${esc(x.note)}</div></span>${chip(x.res, x.res === 'n/a' ? 'IGNORE' : x.res)}</div>`).join('') + `<div class="sub" style="margin-top:6px">${esc(r.details)}</div>` : '';
  }
  function dots(ag) {
    return `<div class="dots">${ag.B.map((v, i) => `<span class="dt b ${v ? 'on' : ''}">B${i + 1}</span>`).join('')}<span class="dt gap"></span>${ag.R.map((v, i) => `<span class="dt r ${v ? 'on' : ''}">R${i + 1}</span>`).join('')}</div>`;
  }
  function sheet(sym) {
    const c = chgOf(sym), ind = A.ind[sym] || {}, r = A.all[sym], trig = isTrig(r), u = QT.UNIVERSE[sym];
    let h = `<div class="row"><span class="big">${sym}</span><span class="sp"></span><button class="star" data-act="fav" data-s="${sym}">${S.favs.includes(sym) ? '★' : '☆'}</button><button class="btn sm ghost" data-act="close-sheet">✕</button></div>
      <div class="row">${r && r.legs ? sideChips(r.legs) : ''}<span class="big">${num(c.ltp)}</span><span class="${cls(c.pct)}">${c.pct >= 0 ? '+' : ''}${c.pct.toFixed(2)}%</span></div>
      <div class="grid"><div>Prev close<b>${num(ind.prevClose)}</b></div><div>~20-DMA<b>${num(ind.ma20)}</b></div><div>~50-DMA<b>${num(ind.ma50)}</b></div><div>52W high / low<b>${num(ind.hi52, 0)} / ${num(ind.lo52, 0)}</b></div><div>60d high / low<b>${num(ind.hi60, 0)} / ${num(ind.lo60, 0)}</b></div><div>Lot (${u.live ? 'exchange' : 'book'}) · avg vol<b>${u.lot} · ${ind.avgVol ? Math.round(ind.avgVol / 1000) + 'k' : '-'}</b>${u.exch && u.exch !== u.lot ? `<span class="warn">⚠ exchange ${u.exch}</span>` : ''}</div></div>
      <div class="sub">Closed ${S.candleTf}m candle: <b>${A.sig && A.sig[sym] ? num(A.sig[sym]) : '-'}</b>${A.sigTs[sym] ? ' @ ' + hhmm(A.sigTs[sym]) : ''} · agents use this close, not the live tick</div>`;
    if (!r) return h;
    h += `<div class="card" style="margin-top:10px"><h4>Agent 1 · book rules (Bull vs Bear)</h4>`;
    if (r.ag) h += dots(r.ag) + `<div class="sub">Bull ${r.ag.bull}/6 · Bear ${r.ag.bear}/6 · edge ${r.ag.edge > 0 ? '+' : ''}${r.ag.edge} · trend score ${r.ag.ts} · planner bias ${r.bias || '-'} · candidate ${r.candidate || '—'} · book rules ${esc(r.gate || '-')}</div><div class="why"><b>${esc(r.ag.bullTxt)}</b><br><b>${esc(r.ag.bearTxt)}</b></div>`;
    h += `</div>`;
    if (r.a2) h += `<div class="card"><h4>Agent 2 · history &amp; movement</h4><div class="row">${chip(r.a2.opinion, r.a2.opinion === 'SUPPORT' ? 'PASS' : r.a2.opinion === 'OPPOSE' ? 'FAIL' : 'WARN')}<b>${r.a2.score >= 0 ? '+' : ''}${r.a2.score}/${r.a2.n}</b><span class="sub">(${r.a2.support} support · ${r.a2.oppose} oppose · min ${r.a2.min})</span></div>${r.a2.checks.map((x) => `<div class="rule"><span>${esc(x.name)}<div class="n">${esc(x.note)}</div></span>${chip(x.vote > 0 ? '+1' : x.vote < 0 ? '-1' : '0', x.vote > 0 ? 'PASS' : x.vote < 0 ? 'FAIL' : 'IGNORE')}</div>`).join('')}</div>`;
    else if (r.candidate && S.a2Enabled === false) h += '<div class="card sub">Agent 2 is switched off in Settings.</div>';
    else h += '<div class="card sub">Agent 2 runs only after Agent 1 (book) triggers and the book rules pass.</div>';
    if (trig) { const w = whyOrder(r); h += `<div class="card"><h4>Signal → order</h4><div class="row">${wchip(w)}<span>${esc(w.msg)}</span></div><div class="sub" style="margin-top:6px">Signal uses the last CLOSED ${S.candleTf}m candle and the book lots. The order is re-priced on the live option chain at the moment it is placed, so strike, price and lots can differ slightly (see the position card).</div></div>`; }
    h += `<div class="card"><div class="row"><b>JUDGE</b>${chip(r.decision === 'NO DATA' ? 'NO DATA' : r.decision, dec(r))}${trig ? chip('Conviction ' + r.conviction + (r.conv1 != null && r.a2 ? ` (A1 ${r.conv1} · A2 ${r.a2.conv2})` : ''), 'IGNORE') : ''}</div><div class="why">${esc(r.verdict || r.reason || '')}</div>
      <pre class="tx" id="txt-${sym}">${esc(transcript(r))}</pre><div class="btns"><button class="btn sm ghost" data-act="copytx" data-s="${sym}">Copy text</button></div></div>`;
    if (r.ticket) {
      h += `<div class="card"><h4>Trade planner · ${esc(r.stratName)} <span class="sub">(#${r.strat}${r.forced ? ' forced' : ''} · ${esc(r.view)})</span></h4><div class="tk">${r.legs.map((l) => legHtml(l.a, l.K, l.t, l.p, `${r.lots}L ${r.sym} ${QT.ddmmm(r.expiry)}`)).join('<br>')}</div>
      <div class="grid"><div>Lots · Qty<b>${r.lots} · ${r.qty}</b></div><div>Net prem/share<b>${num(Math.abs(r.net))} ${r.debit ? 'Dr' : 'Cr'}</b></div><div>Capital needed<b>${inr(r.capital)}</b></div><div>Exit @ target<b>${num(r.exitTarget)}</b></div><div>Exit @ SL<b>${num(r.exitSL)}</b></div><div>Max loss<b>${inr(r.maxLoss * r.qty)}</b></div><div>Profit @ target<b class="pos">${inr(r.profitAtTarget)}</b></div><div>Loss @ SL<b class="neg">${inr(-r.lossAtSL)}</b></div><div>Expiry · DTE<b>${r.expiry.slice(5)} · ${r.dte}d</b></div></div>
      <div class="kv">Buying area <b>${r.buyArea}</b></div><div class="kv">Underlying target / range <b>${esc(r.targetTxt)}</b></div><div class="kv">Underlying SL / exit rule <b>${esc(r.slTxt)}</b></div><div class="kv">Exit-by <b>${r.exitBy}</b> · Price source <b>${esc(r.src)}</b></div><div class="why"><b>TRADING PLAN</b> ${esc(r.plan)}</div>${ruleTable(r)}</div>`;
    }
    h += `<div class="card"><h4>Experiment (optional inputs from Trade Planner)</h4><label>Force strategy #<select data-force="${sym}"><option value="">Auto</option>${Object.entries(QT.STRATS).map(([n, s]) => `<option value="${n}" ${+S.force[sym] === +n ? 'selected' : ''}>${n}. ${s.name}</option>`).join('')}</select></label>
      <label>Spot override (₹)<input type="number" step="any" data-ov="${sym}" value="${S.spotOv[sym] || ''}" placeholder="blank = live"></label></div>`;
    if (trig) h += `<div class="btns"><button class="btn full" data-act="order" data-s="${sym}">Place paper order</button></div>`;
    return h;
  }

  // ---------- Agents tab: Debate / Planner / Rules ----------
  function agentsTab() {
    let h = `<div class="seg sm">${[['debate', 'Debate & Judge'], ['plan', 'Trade Planner'], ['rules', '10 Logics & Rules']].map(([k, l]) => `<button class="${A.ag === k ? 'on' : ''}" data-act="ag" data-k="${k}">${l}</button>`).join('')}</div>`;
    if (A.ag === 'rules') return h + rulesPage();
    if (!A.snap) return h + '<div class="card sub">Load data first (tap ↻).</div>';
    if (A.ag === 'debate') {
      const cnt = (d) => A.order.filter((r) => r.decision === d).length;
      h += `<div class="card sub">Each agent scores 0-6 from price evidence. CANDIDATE = one agent beats the other by ≥ ${S.minEdge} AND the planner strategy matches the direction. DECISION = candidate AND book rules do not FAIL. Conviction = edge/6 × 100 (rule-based, not a probability).<div class="lg" style="margin-top:6px"><b class="pos">B1</b> above 20-DMA · <b class="pos">B2</b> 20&gt;50 DMA · <b class="pos">B3</b> upper 52W half · <b class="pos">B4</b> up today · <b class="pos">B5</b> Nifty up · <b class="pos">B6</b> oversold &gt;4% · <b class="neg">R1</b> below 20-DMA · <b class="neg">R2</b> 20&lt;50 · <b class="neg">R3</b> lower 52W half · <b class="neg">R4</b> down today · <b class="neg">R5</b> Nifty down · <b class="neg">R6</b> stretched &gt;4%</div></div>`;
      h += `<div class="seg sm">${[['all', 'All'], ['BUY', 'BUY ' + cnt('BUY')], ['SELL', 'SELL ' + cnt('SELL')], ['NEUTRAL', 'NEUT ' + cnt('NEUTRAL')], ['IGNORE', 'IGNORE ' + cnt('IGNORE')], ['NO DATA', 'NO DATA']].map(([k, l]) => `<button class="${A.df === k ? 'on' : ''}" data-act="df" data-k="${k}">${l}</button>`).join('')}</div>`;
      const list = A.order.filter((r) => A.df === 'all' || r.decision === A.df).sort((a, b) => (b.conviction || -1) - (a.conviction || -1));
      h += list.map((r) => `<div class="card" data-act="sheet" data-s="${r.sym}"><div class="row"><b>${r.sym}</b>${chip(r.decision === 'NO DATA' ? 'NO DATA' : r.decision, dec(r))}${r.conviction ? chip('Conv ' + r.conviction, 'IGNORE') : ''}<span class="sp"></span>₹${num(r.spot)}</div>
        ${r.ag ? dots(r.ag) + `<div class="sub">Agent 1: Bull ${r.ag.bull} · Bear ${r.ag.bear} · edge ${r.ag.edge > 0 ? '+' : ''}${r.ag.edge} · bias ${r.bias} · ${esc(r.stratName)} · rules ${esc(r.gate || '-')}</div>${r.a2 ? `<div class="sub">Agent 2: ${r.a2.opinion} ${r.a2.score >= 0 ? '+' : ''}${r.a2.score}/${r.a2.n}</div>` : ''}` : ''}
        ${['BUY', 'SELL', 'NEUTRAL'].includes(r.decision) ? `<div class="sub">${wchip(whyOrder(r))} ${esc(whyOrder(r).msg)}</div>` : ''}
        <div class="why">${esc(r.verdict || r.reason || '')}</div></div>`).join('') || '<div class="card sub">None.</div>';
      return h;
    }
    h += `<input class="search" id="pq" placeholder="Search symbol" value="${esc(A.pq)}"><div class="sub" style="margin-bottom:8px">Planned trade for every symbol (like the Trade Planner sheet), whether or not it passes the Judge.</div><div id="plist">${plist()}</div>`;
    return h;
  }
  function plist() {
    const q = A.pq.trim().toUpperCase();
    return A.order.filter((r) => r.ticket && (!q || r.sym.includes(q))).map((r) => `<div class="card" data-act="sheet" data-s="${r.sym}"><div class="row"><b>${r.sym}</b><span class="chip">${esc(r.stratName)}</span><span class="sp"></span>${chip(r.decision, dec(r))}</div>
      <div class="sub">${esc(r.view)} · exp ${r.expiry} (${r.dte}d) · ${r.lots}L · ${num(Math.abs(r.net))} ${r.debit ? 'Dr' : 'Cr'} · exit ${num(r.exitTarget)} / ${num(r.exitSL)}</div>
      <div class="sub">Profit @T <b class="pos">${inr(r.profitAtTarget)}</b> · Loss @SL <b class="neg">${inr(-r.lossAtSL)}</b> · capital ${inr(r.capital)} · rules ${esc(r.gate)}</div></div>`).join('') || '<div class="card sub">No match.</div>';
  }
  function rulesPage() {
    let h = `<div class="card sub">The 10 strategy logics (Guy Cohen) with the workbook's trigger rules. Toggle a strategy ON/OFF here or in Settings — an OFF strategy is IGNOREd by the Judge. Current VIX threshold: ${S.vixThreshold}.</div>`;
    h += QT.LOGICS.map((x) => `<div class="card"><div class="row"><b>${x.n}. ${x.name}</b><span class="sp"></span><label class="tg" style="margin:0"><span class="sub">${S.strat[x.n] ? 'ON' : 'OFF'}</span><input type="checkbox" data-s="${x.n}" ${S.strat[x.n] ? 'checked' : ''}></label></div>
      <div class="sub">${esc(x.view)} · ${esc(x.risk)}</div>
      <div class="kv"><b>Trigger:</b> ${esc(x.trigger)}</div><div class="kv"><b>Stock selection:</b> ${esc(x.stock)}</div><div class="kv"><b>Strikes:</b> ${esc(x.strikes)}</div><div class="kv"><b>Expiry:</b> ${esc(x.expiry)}</div><div class="kv"><b>Time decay:</b> ${esc(x.decay)}</div><div class="kv"><b>Target / SL:</b> ${esc(QT.TARGET_SL_NOTE)}</div><div class="kv"><b>Book ref:</b> ${esc(x.ref)}</div></div>`).join('');
    h += `<div class="card"><h4>Thumb rules from the book — how the app applies each</h4>${QT.THUMB.map((t, i) => `<div class="kv"><b>${i + 1}. ${esc(t[0])}</b><br>${esc(t[1])}</div>`).join('')}</div>`;
    h += `<div class="card"><h4>Important limits</h4>${QT.LIMITS.map((t, i) => `<div class="kv">${i + 1}. ${esc(t)}</div>`).join('')}</div>`;
    return h;
  }

  // ---------- Orders / Positions / History ----------
  function orders() {
    const all = QT.Paper.st.orders, list = all.filter((o) => A.ord === 'all' || (A.ord === 'done' ? o.status === 'COMPLETE' : o.status === 'REJECTED'));
    let h = `<div class="seg">${[['all', 'All ' + all.length], ['done', 'Executed'], ['rej', 'Rejected']].map(([k, l]) => `<button class="${A.ord === k ? 'on' : ''}" data-act="ord" data-k="${k}">${l}</button>`).join('')}</div>`;
    h += list.map((o) => `<div class="card"><div class="row"><b>${o.sym}</b><span class="chip ${o.src === 'manual' ? 'MANUAL' : o.signal === 'EXIT' ? 'EXIT' : 'AUTO'}">${o.signal === 'EXIT' ? 'EXIT' : o.src.toUpperCase()}</span>${o.legs && o.legs.length ? sideChips(o.legs) : ''}<span class="sp"></span><span class="chip ${o.status}">${o.status}</span></div>
      <div class="sub">${dmy(o.time)} ${hhmm(o.time)} · ${o.id} · ${esc(o.stratName)} · ${o.lots}L</div>${candleLine(o)}
      ${o.legs && o.legs.length ? `<div class="tk">${o.legs.map((l) => legHtml(l.a, l.K, l.t, l.px, o.expiry)).join('<br>')}</div>` : ''}
      ${o.reason ? `<div class="${o.status === 'REJECTED' ? 'neg' : 'sub'}">${esc(o.reason)}</div>` : ''}</div>`).join('') || '<div class="card sub">No orders yet. Orders from triggered signals appear here with their status.</div>';
    return h;
  }
  function fundsTiles() {
    const P = QT.Paper, un = P.unrealized();
    return `<div class="tiles"><div>Equity<b>${inr(P.equity(S))}</b></div><div>Available<b>${inr(P.available(S))}</b></div><div>Margin used<b>${inr(P.margin())}</b></div><div>Realized<b class="${cls(P.st.realized)}">${inr(P.st.realized)}</b></div><div>Unrealized<b class="${cls(un)}">${inr(un)}</b></div><div>Total P&L<b class="${cls(P.st.realized + un)}">${inr(P.st.realized + un)}</b></div></div>`;
  }
  // ---------- Today: trading phase, allowed days, today's run ----------
  function todayPanel() {
    const P = QT.Paper, ph = QT.phase(S), day = QT.istDate(), wd = QT.istNow().getUTCDay(), m = QT.istMin();
    const isToday = (iso) => iso && new Date(new Date(iso).getTime() + 19800000).toISOString().slice(0, 10) === day;
    const ords = P.st.orders.filter((o) => isToday(o.time)), done = ords.filter((o) => o.status === 'COMPLETE' && o.signal !== 'EXIT'), rej = ords.filter((o) => o.status === 'REJECTED');
    const exits = P.closed().filter((t) => isToday(t.exitTime)), newT = P.st.trades.filter((t) => t.entryDay === day).length;
    const pc = (x) => Math.max(0, Math.min(100, ((x - 555) / 375) * 100)), lim = P.equity(S) * S.dailyLossPct, rt = P.todayRealized();
    const t0 = QT.hm(S.tradeStart), t1 = QT.hm(S.tradeEnd);
    let h = `<div class="card"><div class="row"><b>Today · ${QT.dayName(wd)} ${day}</b><span class="sp"></span><span class="pill ${ph.on ? 'on' : 'off'}">${esc(ph.label)}</span></div>
      <div class="tl"><div class="seg1 settle" style="left:0;width:${pc(t0)}%"></div><div class="seg1 win" style="left:${pc(t0)}%;width:${pc(t1) - pc(t0)}%"></div><div class="seg1 exit" style="left:${pc(t1)}%;width:${100 - pc(t1)}%"></div>${m >= 555 && m <= 930 ? `<div class="now" style="left:${pc(m)}%"></div>` : ''}</div>
      <div class="tll"><span>09:15</span><span>${esc(S.tradeStart)}</span><span>${esc(S.tradeEnd)}</span><span>15:30</span></div>
      <div class="sub">Monitor-only (grey) · new orders (green) · exit-only (amber). ${ph.next ? esc(ph.next.label) + '.' : ''}</div>
      <div class="days">${[1, 2, 3, 4, 5, 6, 0].filter((d) => d >= 1 && d <= 5 || S.days.includes(d)).map((d) => `<span class="dchip ${S.days.includes(d) ? 'on' : ''} ${d === wd ? 'today' : ''}">${S.days.includes(d) ? '✓' : '✗'} ${QT.dayName(d)}</span>`).join('')}</div>
      <div class="tiles"><div>Orders today<b>${done.length} done · ${rej.length} rej</b></div><div>New trades<b>${newT} / ${S.maxTradesPerDay}</b></div><div>Exits today<b>${exits.length}</b></div><div>Realized today<b class="${cls(rt)}">${inr(rt)}</b></div><div>Open now<b>${P.open().length} / ${S.maxOpen}</b></div><div>Loss limit used<b>${rt < 0 ? Math.min(100, (-rt / lim) * 100).toFixed(0) : 0}%</b></div></div>
      <div class="btns"><button class="btn sm ghost" data-act="newsession">Clear all old orders &amp; start fresh</button></div></div>`;
    const lks = Object.entries(P.st.locks || {});
    if (lks.length) h += `<div class="card"><h4>Re-entry locked (waiting for reversal)</h4>${lks.map(([sy, l]) => `<div class="kv"><b>🔒 ${esc(sy)}</b> ${l.dir === 'U' ? 'bullish' : l.dir === 'D' ? 'bearish' : 'neutral'} orders blocked since ${esc(l.why)} ${hhmm(l.since)}</div>`).join('')}</div>`;
    const lg = QT.Run.log.filter((x) => isToday(x.t)).slice(0, 14);
    h += `<div class="card"><h4>Today's run</h4>${lg.map((x) => `<div class="kv"><b>${hhmm(x.t)}</b> ${esc(x.msg)}</div>`).join('') || '<div class="sub">Nothing yet today.</div>'}</div>`;
    return h;
  }
  // exit rules in force for a position (information only - the engine exits per Settings)
  const BASIS = { premium: 'option premium', spot: 'underlying price', either: 'either', both: 'both' };
  function exitInfo(t) {
    const v = t.verify || {}, tb = v.tb || S.targetBasis, sb = v.sb || S.slBasis, dir = t.debit ? '≥' : '≤', sdir = t.debit ? '≤' : '≥', ok = (x) => (x ? '<b class="pos">✓ met</b>' : '<span class="sub">not yet</span>');
    const tgS = t.targetSpot ? `${t.bias === 'U' ? '≥' : '≤'} ${num(t.targetSpot)}` : '-', slS = t.slSpot ? `${t.bias === 'U' ? '≤' : '≥'} ${num(t.slSpot)}` : '-';
    return `<div class="why" style="margin-top:6px"><b>Exit rules (set in Settings, as per book)</b><br>
      Option now <b>${num(v.premNow ?? Math.abs(t.val))}</b>${v.est ? ' <span class="warn">(estimate - quote looks wrong)</span>' : ''}${v.stale ? ' <span class="warn">(no fresh price)</span>' : ''}<br>
      TARGET on ${BASIS[tb]}${tb === 'both' ? ' (both must hold)' : ''}: premium ${dir} ${num(t.exitTarget)} ${ok(v.premT)} · underlying ${tgS} ${t.targetSpot ? ok(v.spT) : ''} · verified ${v.tN || 0}/${v.tc || S.targetConfirm}<br>
      STOP on ${BASIS[sb]}${sb === 'both' ? ' (both must hold)' : ''}: premium ${sdir} ${num(t.exitSL)} ${ok(v.premS)} · underlying ${slS} ${t.slSpot ? ok(v.spS) : ''} · verified ${v.sN || 0}/${v.sc || S.slConfirm}<br>
      Exit-by <b>${t.exitBy}</b>${t.bias === 'U' ? ` · exit if spot closes below 20-DMA ${num(t.ma20)}` : t.bias === 'D' ? ` · exit if spot closes above 20-DMA ${num(t.ma20)}` : t.range ? ` · exit if spot leaves ${num(t.range[0], 0)}-${num(t.range[1], 0)}` : ' · exit if still flat at half time'}</div>`;
  }
  // what changed between the signal and the order that was actually filled
  function sigVsOrder(t) {
    const g = t.sigSnap; if (!g) return '';
    const sg = g.legs.map((l) => `${l.a === 'B' ? 'B' : 'S'} ${l.K}${l.t} @${num(l.p)}`).join(' / '), od = t.legs.map((l) => `${l.a === 'B' ? 'B' : 'S'} ${l.K}${l.t} @${num(l.fill)}`).join(' / ');
    const fl = [];
    if (g.legs.some((l, i) => t.legs[i] && l.K !== t.legs[i].K)) fl.push('strike changed (order re-priced on the live option chain, spot moved)');
    if (g.lots !== t.lots) fl.push(`lots ${g.lots} → ${t.lots} (book formula re-run at the new price)`);
    const slip = t.legs.map((l, i) => (g.legs[i] ? l.fill - g.legs[i].p : 0)).reduce((x, y) => x + Math.abs(y), 0);
    if (slip > 0.001) fl.push('fill follows the Entry fill setting (' + (S.fillMode === 'ltp' ? 'last traded price' : 'ask/bid') + ') on a fresher quote');
    if (g.spot && t.entrySpot && Math.abs(g.spot / t.entrySpot - 1) > 0.0005) fl.push(`spot ${num(g.spot)} (signal) → ${num(t.entrySpot)} (order)`);
    return `<div class="sub"><b>Signal</b> ${esc(sg)} · ${g.lots}L · spot ${num(g.spot)}<br><b>Order</b> ${esc(od)} · ${t.lots}L · spot ${num(t.entrySpot)}${fl.length ? '<br><span class="warn">' + esc(fl.join('; ')) + '</span>' : '<br><span class="ok">identical to the signal</span>'}</div>`;
  }
  function positions() {
    const P = QT.Paper, list = A.pos === 'open' ? P.open() : P.closed();
    let h = todayPanel() + fundsTiles() + `<div class="seg">${[['open', 'Open ' + P.open().length], ['closed', 'Closed ' + P.closed().length]].map(([k, l]) => `<button class="${A.pos === k ? 'on' : ''}" data-act="pos" data-k="${k}">${l}</button>`).join('')}</div>`;
    h += list.map((t) => {
      const pnl = t.status === 'OPEN' ? t.pnlGross || 0 : t.pnl;
      return `<div class="card"><div class="row"><b>${t.sym}</b>${sideChips(t.legs.map((l) => ({ a: l.a, t: l.t })))}<span class="chip">${esc(t.stratName)}</span><span class="sp"></span><b class="${cls(pnl)}">${inr(pnl)}</b></div>${t.status === 'OPEN' ? `<div class="sub" style="text-align:right">after entry charges ${inr((t.pnlGross || 0) - t.chEntry)}</div>` : ''}
      <div class="sub">${t.id} · ${t.lots}L (${t.qty}) · exp ${t.expiry} · ${t.status === 'OPEN' ? 'exit by ' + t.exitBy : t.status}</div>
      ${candleLine(t)}<div class="tk">${t.legs.map((l) => legHtml(l.a, l.K, l.t, l.fill) + (l.exitPx != null ? ' → ' + num(l.exitPx) : '')).join('<br>')}</div>
      <div class="sub">Spot ${num(t.entrySpot)} → ${num(t.status === 'OPEN' ? t.curSpot : t.exitSpot)}${t.targetSpot ? ` · T ${num(t.targetSpot)} · SL ${num(t.slSpot)}` : t.targetTxt ? ' · ' + esc(t.targetTxt) : ''} · margin ${inr(t.margin)}</div>
      ${sigVsOrder(t)}
      ${t.status === 'OPEN' ? exitInfo(t) : ''}
      ${t.status === 'OPEN' ? `<div class="btns"><button class="btn sm red" data-act="exit" data-id="${t.id}">Exit position</button></div>` : ''}</div>`;
    }).join('') || '<div class="card sub">Nothing here.</div>';
    return h;
  }
  function curve() {
    const c = QT.Paper.st.curve; if (c.length < 2) return '<div class="sub">Equity curve appears after a few refreshes.</div>';
    const ys = c.map((p) => p[1]), mn = Math.min(...ys), mx = Math.max(...ys), rg = mx - mn || 1;
    const pts = c.map((p, i) => `${(i / (c.length - 1)) * 300},${58 - ((p[1] - mn) / rg) * 54}`).join(' ');
    return `<svg class="curve" viewBox="0 0 300 60" preserveAspectRatio="none"><polyline fill="none" stroke="var(--ac)" stroke-width="1.6" points="${pts}"/></svg><div class="sub">Equity ${inr(ys[0])} → ${inr(ys[ys.length - 1])}</div>`;
  }
  function historyReg() {
    const P = QT.Paper, st = P.stats();
    let h = `<div class="tiles"><div>Total trades<b>${st.total}</b></div><div>Open / Closed<b>${st.open} / ${st.closed}</b></div><div>Win rate (target hits)<b>${st.targetWinRate.toFixed(0)}%</b></div><div>Target hit<b class="pos">${st.targetHits}</b></div><div>SL hit<b class="neg">${st.slHits}</b></div><div>Exit-by / other<b>${st.exitBy} / ${st.closed - st.targetHits - st.slHits - st.exitBy}</b></div><div>Profit factor<b>${st.pf === Infinity ? '∞' : st.pf.toFixed(2)}</b></div><div>Avg win / loss<b>${inr(st.avgWin)} / ${inr(st.avgLoss)}</b></div><div>Max drawdown<b class="neg">${inr(-st.maxDD)}</b></div></div>
      <div class="card">${curve()}<div class="sub">Charges paid: ${inr(st.charges)} · profitable trades ${st.winRate.toFixed(0)}%</div></div>`;
    const dw = P.daywise();
    if (dw.length) h += `<div class="card"><h4>Day-wise P&L</h4>${dw.slice(0, 14).map((d) => `<div class="row"><span>${d.d}</span><span class="sub">${d.n} trade(s)</span><span class="sp"></span><b class="${cls(d.pnl)}">${inr(d.pnl)}</b></div>`).join('')}</div>`;
    h += `<div class="row" style="margin:4px 0 8px"><h4 style="margin:0">Paper trade register</h4><span class="sp"></span><button class="btn sm" data-act="csv">Export CSV</button></div>
      <div class="seg sm">${[['all', 'All'], ['open', 'Open'], ['closed', 'Closed'], ['win', 'Wins'], ['loss', 'Losses']].map(([k, l]) => `<button class="${A.hf === k ? 'on' : ''}" data-act="hf" data-k="${k}">${l}</button>`).join('')}</div>`;
    const f = P.st.trades.filter((t) => A.hf === 'all' || (A.hf === 'open' && t.status === 'OPEN') || (A.hf === 'closed' && t.status !== 'OPEN') || (A.hf === 'win' && t.pnl > 0) || (A.hf === 'loss' && t.status !== 'OPEN' && t.pnl <= 0));
    h += f.map((t) => {
      const pnl = t.status === 'OPEN' ? null : t.pnl, o = A.open['t' + t.id];
      return `<div class="card" data-act="tog" data-k="t${t.id}"><div class="row"><b>${t.sym}</b>${chip(t.signal, t.signal)}<span class="chip ${/TARGET/.test(t.status) ? 'TARGET' : /SL/.test(t.status) ? 'SL' : ''}">${t.status}</span><span class="sp"></span><b class="${cls(pnl)}">${pnl == null ? 'open' : inr(pnl)}</b></div>
      <div class="sub">${t.id} · ${dmy(t.time)} ${hhmm(t.time)}${t.exitTime ? ' → ' + dmy(t.exitTime) + ' ' + hhmm(t.exitTime) : ''} · ${esc(t.stratName)} · conv ${t.conviction ?? '-'}</div>
      ${o ? `${candleLine(t)}<div class="tk">${t.legs.map((l) => legHtml(l.a, l.K, l.t, l.fill) + (l.exitPx != null ? ' → ' + num(l.exitPx) : '')).join('<br>')}</div>
      <div class="grid"><div>Order<b>${t.orderId}</b></div><div>Dr/Cr<b>${t.net > 0 ? 'Debit' : 'Credit'}</b></div><div>Lots · Qty<b>${t.lots} · ${t.qty}</b></div><div>Entry spot<b>${num(t.entrySpot)}</b></div><div>Target / SL spot<b>${t.targetSpot ? num(t.targetSpot, 1) + ' / ' + num(t.slSpot, 1) : '-'}</b></div><div>Expiry · exit-by<b>${t.expiry.slice(5)} · ${t.exitBy.slice(5)}</b></div><div>Entry prem<b>${num(Math.abs(t.net))}</b></div><div>Target / SL prem<b>${num(t.exitTarget)} / ${num(t.exitSL)}</b></div><div>Profit@T / Loss@SL<b>${inr(t.profitAtTarget)} / ${inr(-t.lossAtSL)}</b></div><div>Gross<b class="${cls(t.pnlGross)}">${inr(t.pnlGross)}</b></div><div>Charges<b>${inr((t.chEntry || 0) + (t.chExit || 0))}</b></div><div>Origin<b>${t.origin}</b></div></div>
      <div class="sub">Sizing: ${esc(t.sizeNote || '-')}</div><div class="sub">Book rules: ${esc(t.details || '')}</div><div class="why">${esc(t.why || '')}</div>` : ''}</div>`;
    }).join('') || '<div class="card sub">No trades in the register yet.</div>';
    return h + `<div class="btns"><button class="btn sm ghost" data-act="reset">Reset paper account</button></div>`;
  }

  function history() {
    const seg = `<div class="seg sm">${[['reg', 'Register'], ['win', 'Win rate'], ['ai', 'AI tuning']].map(([k, l]) => `<button class="${A.hseg === k ? 'on' : ''}" data-act="hseg" data-k="${k}">${l}</button>`).join('')}</div>`;
    return seg + (A.hseg === 'reg' ? historyReg() : A.hseg === 'win' ? winRate() : tuning());
  }
  function winRate() {
    const st = QT.Paper.stats(), T = QT.Optimizer.tables();
    let h = `<div class="card sub">Win = a closed paper trade with net profit after charges. Win rate by strategy, side, conviction, trade type, Agent 2 score, candle confirmation and how trades ended. With fewer than ~20 trades these numbers are noisy.</div>
      <div class="tiles"><div>Closed trades<b>${st.closed}</b></div><div>Win rate<b>${st.winRate.toFixed(0)}%</b></div><div>Profit factor<b>${st.pf === Infinity ? '∞' : st.pf.toFixed(2)}</b></div></div>`;
    for (const [title, rows] of Object.entries(T)) {
      h += `<div class="card"><h4>${title}</h4>` + rows.map((r) => `<div class="rule"><span><b>${esc(r.k)}</b><div class="n">${r.n} trades · target ${r.target} · SL ${r.sl} · other ${r.other}${r.n ? ' · avg ' + inr(r.avg) : ''}</div></span><span style="text-align:right"><b>${r.winRate == null ? '-' : r.winRate.toFixed(0) + '%'}</b><div class="n ${cls(r.total)}">${r.n ? inr(r.total) : ''}</div></span></div>`).join('') + '</div>';
    }
    return h;
  }
  function tuning() {
    const a = QT.Optimizer.analyze(S);
    let h = `<div class="card"><h4>AI tuning for win rate</h4><div class="sub">Learns from your closed paper trades which filters win more (strategies, minimum conviction, candle confirmation, Agent 2 strictness) and can adjust them. It never changes risk size, stop-loss or the book rules, and it cannot guarantee future results. Demo prices are random, so tuning on demo trades means nothing.</div>
      ${field(['autoTune', 'Auto-tune filters from trade history', 'bool'])}${field(['optMinTrades', 'Minimum closed trades before tuning', 'num'])}${field(['optTargetWin', 'Target win rate (%)', 'pct'])}</div>`;
    if (!a.ready) h += `<div class="card sub">Need ${S.optMinTrades} closed paper trades to analyse (have ${a.n}).</div>`;
    else if (!a.recs.length) h += `<div class="card">No change recommended from ${a.n} closed trades.</div>`;
    else h += `<div class="card"><h4>Recommended changes (${a.n} trades)</h4>${a.recs.map((r) => `<div class="rule"><span><b>${esc(r.label)}</b><div class="n">${esc(r.reason)}</div></span></div>`).join('')}<div class="btns"><button class="btn sm" data-act="apply-tune">Apply all</button></div></div>`;
    h += `<div class="btns"><button class="btn sm ghost" data-act="revert-tune">Undo last tuning</button></div>`;
    h += (S.tuneLog || []).map((l) => `<div class="card"><div class="sub">${dmy(l.time)} ${hhmm(l.time)}</div>${l.changes.map((c) => `<div class="kv"><b>${esc(c.label)}</b> — ${esc(c.reason)}</div>`).join('')}</div>`).join('');
    return h;
  }

  // ---------- More: Settings / Alerts / About ----------
  const SCHEMA = [
    ['Signal logic (closed candles)', [['strictBook', 'STRICT BOOK MODE: every measurable book rule is a hard FAIL (no warnings), lots exactly per book', 'bool'], ['closedCandle', 'Closed-candle check: signals use only fully closed candles', 'bool'], ['candleTf', 'Candle timeframe', 'sel', [[5, '5 minutes'], [15, '15 minutes'], [30, '30 minutes'], [60, '60 minutes']]], ['confirmN', 'Confirm on N consecutive closed candles', 'sel', [[1, '1 (act on first close)'], [2, '2 candles'], [3, '3 candles']]],
      ['neutralTrade', 'Neutral strategies 7-10 act as trades (workbook only plans them)', 'bool']]],
    ['Agent 2 · history & movement', [['a2Enabled', 'Agent 2 checks every book-triggered trade before the Judge decides', 'bool'], ['a2Strict', 'Judge strictness', 'ssel', [['lenient', 'Lenient (ignore if Agent 2 score < -2)'], ['normal', 'Normal (ignore if score < 0)'], ['strict', 'Strict (need score >= +2)']]], ['a2Weight', 'Agent 2 weight in final conviction (%)', 'pct']]],
    ['Money management', [['sizing', 'Lot sizing (strict mode always uses the book formula)', 'ssel', [['workbook', 'Book: lots = ROUNDUP(profit goal / (lot x profit per share))'], ['ai', 'AI: risk-based, scaled by conviction, within caps']]], ['capital', 'Starting capital (₹) – applies on Reset', 'num'], ['riskPct', 'Risk per trade at stop-loss (% of equity)', 'pct'], ['marginPerTradePct', 'Max margin per trade (% of equity)', 'pct'],
      ['maxUtilPct', 'Max capital utilised in total (%)', 'pct'], ['dailyLossPct', 'Stop new orders after daily loss of (% of capital)', 'pct'], ['maxTradesPerDay', 'Max new trades per day', 'num'], ['maxOpen', 'Max open positions', 'num']]],
    ['Paper account & orders', [['autoTrade', 'Auto paper-trade triggered signals', 'bool'], ['fillMode', 'Entry fill price', 'ssel', [['ltp', 'Last traded price (like a broker app)'], ['ask', 'Ask / bid - pay the whole spread (strictest)']]], ['minConviction', 'Min conviction to auto-trade', 'num'],
      ['charges', 'Apply brokerage & taxes', 'bool'], ['brokerage', 'Brokerage per order (₹)', 'num'], ['sttPct', 'STT on sell premium (%)', 'pct'], ['slipPct', 'Slippage on fills (%)', 'pct']]],
    ['Safety filters (bad quotes)', [['quoteGuard', 'Reject entries whose option price is far from fair value', 'bool']]],
    ['Target & exit rules (as per book)', [
      ['targetBasis', 'TARGET is met when', 'ssel', [['premium', 'Option premium reaches the book target premium'], ['spot', 'Underlying price reaches the target level'], ['either', 'Either one (whichever first)'], ['both', 'BOTH (verified on premium and underlying)']]],
      ['slBasis', 'STOP-LOSS is hit when', 'ssel', [['premium', 'Option premium falls to the book stop premium'], ['spot', 'Underlying price reaches the stop level'], ['either', 'Either one (whichever first)'], ['both', 'BOTH (verified on premium and underlying)']]],
      ['targetConfirm', 'Verify target on N consecutive refreshes', 'num'], ['slConfirm', 'Verify stop-loss on N consecutive refreshes', 'num'], ['bookPct', 'Book at this % of the target profit', 'pct'],
      ['targetPct', 'Underlying target (% of spot)', 'pct'], ['slPct', 'Underlying stop-loss (% of spot)', 'pct'], ['creditTP', 'Credit trades: take profit at % of credit', 'pct'],
      ['exitBefore', 'Exit-by: bought options N days before expiry', 'num'], ['holdDays', 'Assumed days to reach target (sets the target premium)', 'num'],
      ['maExit', 'Exit when the entry reason is gone (20-DMA close / range break)', 'bool'], ['closeExit', 'Underlying levels checked on closed candles', 'bool'], ['settleMin', 'No premium-based exits in first N minutes after 09:15', 'num'],
      ['reentryLock', 'After an exit, block the same-direction order until the trend reverses', 'ssel', [['target', 'After profit exits'], ['both', 'After any exit'], ['off', 'Off']]],
      ['lockProfit', 'Trailing profit lock (extra, not in the book)', 'bool'], ['lockAt', 'Lock arms at (% of target)', 'pct'], ['lockKeep', 'Exit if profit falls back to (% of target)', 'pct']]],
    ['Strategy parameters (Settings sheet)', [['profitGoal', 'Profit goal per trade (₹) – workbook sizing', 'num'], ['vixThreshold', 'VIX threshold debit/credit', 'num'], ['widthStock', 'Spread width – stocks (% of spot)', 'pct'], ['widthNifty', 'Spread width – Nifty (% of spot)', 'pct'], ['maxLots', 'Max lots per trade', 'num'], ['minEdge', 'Min agent edge (max 6)', 'num'], ['ivMult', 'Stock IV = VIX ×', 'num'], ['rf', 'Risk-free rate (%)', 'pct'], ['maxAge', 'Max data age counted as LIVE (sec)', 'num']]],
    ['Book rules (Settings sheet)', [['minOI', 'Min open interest per leg (contracts)', 'num'], ['minVol', 'Min avg daily volume (shares)', 'num'], ['maxBA', 'Max bid-ask spread (% of mid)', 'pct'], ['minYield', 'Min credit yield (credit / width)', 'pct'], ['minDTEBuy', 'Min days to expiry – BOUGHT options', 'num'],
      ['maxDTESell', 'Max days to expiry – SOLD options', 'num']]],
  ];
  const field = ([k, l, ty, opts]) => ty === 'bool' ? `<label class="tg"><span>${l}</span><input type="checkbox" data-k="${k}" ${S[k] ? 'checked' : ''}></label>`
    : ty === 'sel' ? `<label>${l}<select data-k="${k}" data-n="1">${opts.map(([v, t]) => `<option value="${v}" ${+S[k] === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>`
    : ty === 'ssel' ? `<label>${l}<select data-k="${k}">${opts.map(([v, t]) => `<option value="${v}" ${S[k] === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>`
    : ty === 'text' ? `<label>${l}<input type="text" data-k="${k}" value="${esc(S[k])}" autocomplete="off"></label>`
    : ty === 'pass' ? `<label>${l}<input type="password" data-k="${k}" value="${esc(S[k])}" autocomplete="off"></label>`
    : `<label>${l}<input type="number" step="any" data-k="${k}" data-t="${ty}" value="${ty === 'pct' ? +(S[k] * 100).toFixed(4) : S[k]}"></label>`;
  function settings() {
    const exp = A.expiries.stock, nm = ['near', 'next', 'far'];
    const eo = [['auto', 'AUTO – book rule (far for bought, near for sold)'], ...exp.map((d, i) => [d, `${nm[i] || ''} month – ${d}`])];
    const live = S.execMode !== 'paper';
    let h = `<div class="card"><h4>Data feed (prices, candles, option chain)</h4>${field(['mode', 'Feed provider', 'ssel', [['demo', 'Demo (offline synthetic)'], ['live', 'Live – Upstox API'], ['custom', 'Custom JSON feed (your own adapter)']]])}
      ${S.mode === 'live' ? `<label>Upstox Analytics token (read-only)<input type="password" id="tok" data-k="token" value="${esc(S.token)}" placeholder="Paste Analytics token" autocomplete="off"></label>` : ''}
      ${S.mode === 'custom' ? field(['feedUrl', 'Custom feed base URL', 'text']) + field(['feedHeaders', 'Custom feed headers (JSON)', 'text']) : ''}
      ${S.mode === 'live' ? field(['lotSource', 'Lot size source', 'ssel', [['book', 'Book / workbook list (strict)'], ['upstox', 'Exchange lot from Upstox']]]) + field(['lotSync', 'Compare book lots with exchange lots daily', 'bool']) + `<div class="btns"><button class="btn sm ghost" data-act="lotcheck">Check lot sizes now</button></div>` + (A.lotReport ? `<div class="sub">Checked ${A.lotReport.n} symbols at ${hhmm(A.lotReport.time)}: ${A.lotReport.diff.length ? A.lotReport.diff.length + ' differ from the book' : 'all match the book'}.${A.lotReport.diff.length ? '<br>' + A.lotReport.diff.map(esc).join('<br>') : ''}</div>` : '') : ''}
      <label>Refresh every (sec)<input type="number" data-k="refreshSec" value="${S.refreshSec}"></label>
      <div class="btns"><button class="btn sm" data-act="test">Test connection</button>${S.mode === 'live' ? '<button class="btn sm ghost" data-act="showtok">Show/hide</button>' : ''}</div><div class="sub" id="testres"></div></div>
      <div class="card"><h4>Order execution (separate from the feed)</h4>
      <div class="sub" style="margin-bottom:6px"><b class="neg">Real money warning.</b> Default is Paper only. Broker modes send REAL orders to your broker account when Dry run is off. Educational tool: you are fully responsible for any order sent.</div>
      ${field(['execMode', 'Order mode', 'ssel', [['paper', 'Paper only (no broker)'], ['manual', 'Broker – confirm each order'], ['auto', 'Broker – AUTO send']]])}
      ${live ? `${field(['orderBroker', 'Order broker', 'ssel', [['upstox', 'Upstox (built in)'], ['custom', 'Custom webhook (any broker / gateway)']]])}
      ${S.orderBroker === 'upstox' ? field(['brokerToken', 'Upstox TRADING access token (not the Analytics token)', 'pass']) + field(['algoId', 'Algo ID / name (only if your broker requires it)', 'text']) : field(['webhookUrl', 'Order webhook URL', 'text']) + field(['webhookHeaders', 'Webhook headers (JSON)', 'text']) + field(['webhookBody', 'Webhook body template ({sym} {expiry} {strike} {type} {side} {qty} {lots} {price} {key} {ordertype} {product})', 'text'])}
      ${field(['dryRun', 'Dry run: log orders but DO NOT send', 'bool'])}${field(['product', 'Product', 'ssel', [['D', 'Delivery / NRML (positional)'], ['I', 'Intraday (MIS)']]])}${field(['orderType', 'Order type', 'ssel', [['LIMIT', 'LIMIT at paper-fill price'], ['MARKET', 'MARKET']]])}${field(['maxOrderValue', 'Max value per order (₹)', 'num'])}${field(['maxLiveOrdersDay', 'Max live orders per day', 'num'])}
      <div class="btns"><button class="btn sm red" data-act="paperonly">Stop live orders (Paper only)</button></div>` : ''}</div>
      <div class="card"><h4>Trading time (IST) – new orders</h4><div class="sub" style="margin-bottom:4px">Days when new orders are allowed</div><div class="days">${[1, 2, 3, 4, 5, 6, 0].map((d) => `<label class="dchip ${S.days.includes(d) ? 'on' : ''}"><input type="checkbox" data-day="${d}" ${S.days.includes(d) ? 'checked' : ''}> ${QT.dayName(d)}</label>`).join('')}</div>
      <label>New orders allowed from<input type="time" data-k="tradeStart" value="${S.tradeStart}"></label><label>New orders allowed until<input type="time" data-k="tradeEnd" value="${S.tradeEnd}"></label>
      <label class="tg"><span>Demo mode ignores trading time</span><input type="checkbox" data-k="demoIgnoreHours" ${S.demoIgnoreHours ? 'checked' : ''}></label>
      <label class="tg"><span>Allow manual orders outside time</span><input type="checkbox" data-k="manualOutside" ${S.manualOutside ? 'checked' : ''}></label>
      <div class="sub">Weekdays only. New orders outside this window are not placed (manual ones are logged as REJECTED). Open positions are still monitored, and profit is booked or stops are hit, any time the market is open (09:15–15:30).</div></div>
      <div class="card"><h4>Option expiry</h4><label>Expiry<select data-k="expiryMode">${eo.map(([v, t]) => `<option value="${v}" ${S.expiryMode === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <div class="sub">${exp.length ? (A.expiries.fallback ? 'Computed with the last-Tuesday + holiday fallback (feed list unavailable).' : 'Dates fetched from the feed.') : 'Refresh once to load available expiries.'} A manual expiry turns the days-to-expiry book rules into warnings.</div>
      <label>Assumed NSE holidays (fallback only, comma separated)<input type="text" data-k="holidays" value="${esc(S.holidays)}"></label></div>
      <div class="card"><h4>The 10 strategy concepts</h4>${Object.entries(QT.STRATS).map(([n, s]) => `<label class="tg"><span>${n}. ${s.name} <i>(${s.bias === 'U' ? 'bullish' : s.bias === 'D' ? 'bearish' : 'neutral'}, ${s.risk === 'D' ? 'debit' : 'credit'})</i></span><input type="checkbox" data-s="${n}" ${S.strat[n] ? 'checked' : ''}></label>`).join('')}</div>`;
    SCHEMA.forEach(([t, f]) => (h += `<div class="card"><h4>${t}</h4>${f.map(field).join('')}</div>`));
    return h + `<div class="card"><h4>AI tuning</h4>${field(['autoTune', 'Auto-tune filters from trade history for a better win rate', 'bool'])}<div class="sub">Details and recommendations: History → AI tuning.</div></div>
      <div class="card"><label>Theme<select data-k="theme"><option value="light" ${S.theme === 'light' ? 'selected' : ''}>Light</option><option value="dark" ${S.theme === 'dark' ? 'selected' : ''}>Dark</option></select></label><div class="btns"><button class="btn sm ghost" data-act="defaults">Restore defaults</button></div><div class="sub" style="margin-top:8px">Educational purpose only. Not investment advice.</div></div>`;
  }
  function alertsPage() {
    let h = `<div class="card"><h4>Alert settings</h4><label class="tg"><span>Phone notifications</span><input type="checkbox" data-k="notify" ${S.notify ? 'checked' : ''}></label>
      <label>Alert only if conviction is at least (0-100)<input type="number" data-k="alertMinConv" value="${S.alertMinConv}"></label>
      <label>Telegram bot token<input type="password" data-k="tgToken" value="${esc(S.tgToken)}" placeholder="from @BotFather" autocomplete="off"></label>
      <label>Telegram chat id<input type="text" data-k="tgChat" value="${esc(S.tgChat)}" placeholder="your chat id"></label>
      <div class="btns"><button class="btn sm" data-act="tgtest">Send test</button><button class="btn sm ghost" data-act="notiperm">Allow notifications</button></div><div class="sub" id="tgres"></div>
      <div class="sub">Alerts fire: NEW SIGNAL (once per day per trade), PAPER ENTRY, TARGET HIT / SL HIT / EXIT-BY DUE / ENTRY REASON GONE, DATA STALE (feed silent for 5 minutes during market hours) and feed errors. They work while the app is open; the app cannot run in the background. Email alerts are not available in the app.</div></div>
      <div class="row" style="margin:6px 0"><h4 style="margin:0">Alert log</h4><span class="sp"></span><button class="btn sm ghost" data-act="clearlog">Clear</button></div>`;
    h += QT.Alerts.log.map((a) => `<div class="card"><div class="row"><span class="chip ${/TARGET|NEW|ENTRY/.test(a.type) && !/GONE/.test(a.type) ? 'BUY' : /SL|ERROR|STALE|GONE/.test(a.type) ? 'SELL' : ''}">${esc(a.type)}</span><b>${esc(a.sym)}</b><span class="sp"></span><span class="sub">${dmy(a.time)} ${hhmm(a.time)}</span></div><div class="why">${esc(a.msg)}</div><div class="sub">Delivered via ${esc(a.via)}</div></div>`).join('') || '<div class="card sub">No alerts yet.</div>';
    return h;
  }
  function about() {
    return `<div class="card"><h4>What is automatic</h4><div class="kv"><b>Prices</b> Live Upstox data (Analytics token) each refresh; DELAYED label if data is older than ${S.maxAge}s or the market is closed.</div><div class="kv"><b>VIX, expiry</b> Automatic. Far month for bought options, near month for sold options (book rule).</div><div class="kv"><b>Option premiums</b> Real bid/ask from the live option chain for candidate trades (BUY at ask, SELL at bid); Black-Scholes model otherwise, labelled 'MODEL prices - verify'.</div><div class="kv"><b>Book thumb rules</b> Every trade is checked against 11 rules; a FAIL removes it from the Signals list.</div><div class="kv"><b>Only input you need</b> Your profit goal (default ₹4,500).</div></div>
      <div class="card"><h4>How to use</h4><div class="kv">1. Read Watch → Signals (only BUY/SELL/NEUTRAL that passed the agents AND book rules, best first).</div><div class="kv">2. Open a symbol or Agents → Debate to read Bull, Bear and Judge.</div><div class="kv">3. Before any real order, check the same strikes in your broker's option chain: price, open interest, bid-ask.</div><div class="kv">4. Follow the TRADING PLAN for exits. Use Force strategy / Spot override in a symbol's sheet to experiment.</div></div>
      <div class="card"><h4>Important limits</h4>${QT.LIMITS.map((t, i) => `<div class="kv">${i + 1}. ${esc(t)}</div>`).join('')}</div>`;
  }
  function more() {
    const seg = `<div class="seg sm">${[['set', 'Settings'], ['alerts', 'Alerts ' + QT.Alerts.log.length], ['about', 'About']].map(([k, l]) => `<button class="${A.more === k ? 'on' : ''}" data-act="more" data-k="${k}">${l}</button>`).join('')}</div>`;
    return seg + (A.more === 'set' ? settings() : A.more === 'alerts' ? alertsPage() : about());
  }

  function render() {
    document.documentElement.dataset.theme = S.theme;
    paintHeader(); paintNav(); paintToast(); renderModal();
    const ae = document.activeElement, typing = ae && ae.tagName === 'INPUT' && ae.type !== 'checkbox';
    if (typing && ((A.tab === 'more') || (ae.id === 'q' || ae.id === 'pq'))) { renderSheet(); return; }
    const v = $('#view'), sc = v.scrollTop;
    v.innerHTML = { watch, agents: agentsTab, orders, pos: positions, hist: history, more }[A.tab]();
    v.scrollTop = sc; renderSheet();
  }
  const mq = [];
  function pushModal(m) { if (A.modal) mq.push(m); else A.modal = m; renderModal(); }
  function nextModal() { A.modal = mq.shift() || null; renderModal(); }
  function renderModal() {
    const el = $('#modal'), m = A.modal;
    if (!m) { el.style.display = 'none'; return; }
    let h = '';
    if (m.kind === 'edu') h = `<h3>Educational purpose only</h3><p>Options Desk is a learning and paper-trading tool. It is <b>not investment advice</b>, not a recommendation to buy or sell, and results are not guaranteed. SEBI studies found most individual F&amp;O traders lose money. Paper-trading results do not predict real results. You alone are responsible for any real order.</p><div class="btns"><button class="btn full" data-act="edu-ok">I understand</button></div>`;
    else if (m.kind === 'ack') h = `<h3>Real-money orders</h3><p>You are enabling <b>${m.want === 'auto' ? 'AUTO' : 'confirm-each'}</b> broker orders. When Dry run is OFF, real orders go to your broker and can lose real money. Educational tool, no advice, no guarantee. Dry run stays ON until you switch it off.</p><label>Type <b>I UNDERSTAND</b> to continue<input type="text" id="ackin" autocomplete="off"></label><div class="btns"><button class="btn red" data-act="ack-ok">Enable</button><button class="btn ghost" data-act="modal-no">Cancel</button></div>`;
    else if (m.kind === 'broker') h = `<h3>${m.type === 'entry' ? 'Send entry to broker?' : 'Send exit to broker?'}</h3><p>${esc(m.trade.sym)} · ${esc(m.trade.stratName)} · ${m.trade.lots} lot(s)</p><div class="tk">${QT.Broker.preview(S, m.trade, m.type).map(esc).join('<br>')}</div><p class="sub">${S.dryRun ? 'Dry run is ON: nothing will be sent, only logged.' : '<b class="neg">Dry run is OFF: this sends REAL orders.</b>'}</p><div class="btns"><button class="btn" data-act="broker-send">${S.dryRun ? 'Log (dry run)' : 'Send to broker'}</button><button class="btn ghost" data-act="modal-no">Skip</button></div>`;
    el.innerHTML = `<div class="mbox">${h}</div>`; el.style.display = 'flex';
  }
  function renderSheet() {
    const sh = $('#sheet'), ae = document.activeElement;
    if (A.sheet) { if (!(ae && sh.contains(ae) && ae.tagName === 'INPUT')) { const sc = sh.scrollTop; sh.innerHTML = sheet(A.sheet); sh.scrollTop = sc; } sh.style.display = 'block'; $('#sheetbg').style.display = 'block'; }
    else { sh.style.display = 'none'; $('#sheetbg').style.display = 'none'; }
  }

  // ---------- events ----------
  document.addEventListener('input', (e) => {
    if (e.target.id === 'q') { A.q = e.target.value; $('#wlist').innerHTML = wlist(wlsyms()); }
    else if (e.target.id === 'pq') { A.pq = e.target.value; $('#plist').innerHTML = plist(); }
  });
  document.addEventListener('click', async (e) => {
    if (e.target.id === 'sheetbg') { A.sheet = null; return renderSheet(); }
    if (e.target.id === 'modal') return;
    const t = e.target.closest('[data-tab],[data-act]'); if (!t) return;
    if (t.dataset.tab) { A.tab = t.dataset.tab; A.sheet = null; return render(); }
    const a = t.dataset.act, k = t.dataset.k;
    if (a === 'refresh') refresh();
    else if (a === 'wl') { A.wl = k; A.q = ''; render(); } else if (a === 'ord') { A.ord = k; render(); } else if (a === 'pos') { A.pos = k; render(); } else if (a === 'hf') { A.hf = k; render(); }
    else if (a === 'ag') { A.ag = k; render(); } else if (a === 'df') { A.df = k; render(); } else if (a === 'more') { A.more = k; render(); }
    else if (a === 'tog') { A.open[k] = !A.open[k]; render(); }
    else if (a === 'hseg') { A.hseg = k; render(); }
    else if (a === 'lotcheck') { await lotCheck(true); }
    else if (a === 'newsession') { if (confirm('Delete ALL old orders, trades and logs and start a fresh paper account?')) { QT.Paper.reset(S.capital); QT.Alerts.log = []; QT.Alerts.seen = {}; QT.Alerts.save(); QT.Run.clear(); A.tried = {}; toast('Fresh start: only new orders from now'); render(); } }
    else if (a === 'edu-ok') { S.eduAccepted = true; saveS(); nextModal(); }
    else if (a === 'modal-no') { nextModal(); }
    else if (a === 'ack-ok') { if (($('#ackin').value || '').trim().toUpperCase() === 'I UNDERSTAND') { S.liveAck = true; S.execMode = A.modal.want; S.dryRun = true; saveS(); nextModal(); toast('Broker mode enabled in DRY RUN. Switch Dry run off only when you are ready.'); render(); } else toast('Type I UNDERSTAND exactly'); }
    else if (a === 'broker-send') { const m = A.modal; nextModal(); const r = await QT.Broker.send(S, m.trade, m.type, m.src); toast(r.ok ? (r.dry ? 'Dry run logged' : 'Broker order sent') : 'Broker: ' + r.msg); render(); }
    else if (a === 'paperonly') { S.execMode = 'paper'; saveS(); toast('Live orders stopped: Paper only'); render(); }
    else if (a === 'copytx') { try { await navigator.clipboard.writeText($('#txt-' + t.dataset.s).textContent); toast('Agent text copied'); } catch (er) { toast('Copy failed'); } }
    else if (a === 'apply-tune') { const an = QT.Optimizer.analyze(S), ch = QT.Optimizer.apply(S, an.recs); saveS(); A.dirty = true; if (ch.length) QT.Alerts.add(S, 'TUNING', '', 'Applied: ' + ch.map((c) => c.label).join(' | ')); toast(ch.length + ' change(s) applied'); render(); refresh(); }
    else if (a === 'revert-tune') { const n = QT.Optimizer.revert(S); saveS(); A.dirty = true; toast(n ? 'Last tuning undone' : 'Nothing to undo'); render(); }
    else if (a === 'sheet') { A.sheet = t.dataset.s; renderSheet(); }
    else if (a === 'close-sheet') { A.sheet = null; renderSheet(); }
    else if (a === 'fav') { const s = t.dataset.s; S.favs = S.favs.includes(s) ? S.favs.filter((x) => x !== s) : [...S.favs, s]; saveS(); render(); }
    else if (a === 'order') {
      const r = A.all[t.dataset.s]; t.disabled = true; const res = await placeOrder(r, 'manual');
      toast(res.ok ? `Order ${res.order.id} executed` : 'Rejected: ' + res.msg); A.sheet = null; render();
    }
    else if (a === 'exit') {
      if (!QT.marketOpen() && !(S.mode === 'demo' && S.demoIgnoreHours)) return toast('Market is closed - exit when it opens (09:15-15:30)');
      const tr = QT.Paper.open().find((x) => x.id === t.dataset.id); let ch = A.chains[tr.sym + '|' + tr.expiry];
      if (!ch) { try { ch = await A.feed.chain(tr.sym, tr.expiry); } catch (er) {} }
      if (!ch) return toast('No option prices available');
      QT.Paper.close(tr, 'MANUAL', S, ch); toast(`${tr.sym} exited ${inr(tr.pnl)}`); render();
    }
    else if (a === 'reset') { if (confirm('Reset paper account and clear all orders & trades?')) { QT.Paper.reset(S.capital); render(); } }
    else if (a === 'clearlog') { QT.Alerts.log = []; QT.Alerts.save(); render(); }
    else if (a === 'csv') {
      const csv = QT.Paper.csv(), Sh = globalThis.Capacitor && globalThis.Capacitor.Plugins && globalThis.Capacitor.Plugins.Share;
      if (Sh) { try { await Sh.share({ title: 'Trade register', text: csv, dialogTitle: 'Export trade register' }); return; } catch (er) {} }
      try { await navigator.clipboard.writeText(csv); toast('CSV copied to clipboard'); } catch (er) { toast('Export failed'); }
    }
    else if (a === 'showtok') { const i = $('#tok'); i.type = i.type === 'password' ? 'text' : 'password'; }
    else if (a === 'defaults') { if (confirm('Restore all settings (keeps token, favourites, Telegram)?')) { S = { ...QT.DEFAULTS, strat: { ...QT.DEFAULTS.strat }, token: S.token, favs: S.favs, tgToken: S.tgToken, tgChat: S.tgChat, force: {}, spotOv: {} }; saveS(); A.dirty = true; render(); } }
    else if (a === 'tgtest') { $('#tgres').textContent = 'Sending…'; $('#tgres').textContent = await QT.Alerts.test(S); }
    else if (a === 'notiperm') { const LN = globalThis.Capacitor && globalThis.Capacitor.Plugins && globalThis.Capacitor.Plugins.LocalNotifications; $('#tgres').textContent = LN ? JSON.stringify(await LN.requestPermissions().catch((x) => ({ error: x.message }))) : 'Notifications are available in the installed Android app only'; }
    else if (a === 'test') {
      const out = $('#testres'); out.textContent = 'Testing…';
      try { const f = QT.makeFeed({ ...S, mode: 'live' }); const q = await f.quotes(); const c = await f.closed('SBIN', S.candleTf).catch((x) => ({ err: x.message }));
        out.textContent = `OK – Nifty ${q.q.NIFTY}, VIX ${q.vix}, ${Object.keys(q.q).length}/51 quotes · intraday: ${c && c.close ? 'OK' : c && c.err ? c.err : 'no closed candle yet'}`; }
      catch (er) { out.textContent = 'Failed: ' + er.message; }
    }
  });
  let rt = null;
  const later = () => { A.dirty = true; clearTimeout(rt); rt = setTimeout(() => refresh(), 800); };
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (el.dataset.day !== undefined) { const d = +el.dataset.day; S.days = el.checked ? [...new Set([...S.days, d])] : S.days.filter((x) => x !== d); saveS(); render(); return; }
    if (el.dataset.s) { S.strat[el.dataset.s] = el.checked; saveS(); later(); render(); return; }
    if (el.dataset.force !== undefined) { if (el.value) S.force[el.dataset.force] = +el.value; else delete S.force[el.dataset.force]; saveS(); later(); return; }
    if (el.dataset.ov !== undefined) { const v = parseFloat(el.value); if (v > 0) S.spotOv[el.dataset.ov] = v; else delete S.spotOv[el.dataset.ov]; saveS(); later(); return; }
    const k = el.dataset.k; if (!k) return;
    if (k === 'execMode' && el.value !== 'paper' && !S.liveAck) { S.execMode = 'paper'; pushModal({ kind: 'ack', want: el.value }); render(); return; }
    if (el.type === 'checkbox') S[k] = el.checked;
    else if (el.type === 'number') { const v = parseFloat(el.value); if (isNaN(v)) return; S[k] = el.dataset.t === 'pct' ? v / 100 : v; }
    else S[k] = el.dataset.n ? +el.value : el.value;
    saveS(); if (k === 'refreshSec') schedule();
    if (k === 'mode' || k === 'token' || k === 'feedUrl') { A.feed = null; A.snap = null; }
    if (!['theme', 'refreshSec', 'token', 'mode', 'tradeStart', 'tradeEnd', 'autoTrade', 'capital', 'demoIgnoreHours', 'manualOutside', 'notify', 'alertMinConv', 'tgToken', 'tgChat', 'maxAge', 'execMode', 'orderBroker', 'brokerToken', 'algoId', 'dryRun', 'product', 'orderType', 'maxOrderValue', 'maxLiveOrdersDay', 'webhookUrl', 'webhookHeaders', 'webhookBody', 'feedHeaders', 'autoTune', 'optMinTrades', 'optTargetWin', 'bookPct', 'lockProfit', 'lockAt', 'lockKeep', 'riskPct', 'marginPerTradePct', 'maxUtilPct', 'dailyLossPct', 'maxTradesPerDay', 'maxOpen', 'capital', 'brokerage', 'sttPct', 'slipPct'].includes(k)) later();
    if (el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'time') render(); else paintHeader();
  });

  QT.Paper.onEnter = (t, row) => {
    if (S.execMode === 'paper') return;
    if (S.execMode === 'auto') QT.Broker.send(S, t, 'entry', t.origin).then((r) => { toast(r.ok ? (r.dry ? 'Dry run logged: ' + t.sym : 'Broker order sent: ' + t.sym) : 'Broker: ' + r.msg); render(); });
    else pushModal({ kind: 'broker', type: 'entry', trade: t, src: t.origin });
  };
  QT.Paper.onClose = (t) => {
    if (S.execMode === 'paper' || !(t.live || t.dry)) return;
    if (S.execMode === 'auto') QT.Broker.send(S, t, 'exit', 'auto').then(() => render());
    else pushModal({ kind: 'broker', type: 'exit', trade: t, src: 'auto' });
  };
  QT.app = { S: () => S, A, refresh };
  setInterval(() => { if (!A.busy) paintHeader(); }, 5000);
  document.addEventListener('DOMContentLoaded', () => { if (freshStart) setTimeout(() => toast('New session: all old orders cleared'), 500); if (!S.eduAccepted) A.modal = { kind: 'edu' }; render(); schedule(); if (S.mode === 'demo' || S.token) refresh(); });
})();

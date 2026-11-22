/* Options Desk v2 - broker-style UI, closed-candle signals, paper order book */
(function () {
  const QT = globalThis.QT;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const inr = (x) => (x == null || isNaN(x) ? '-' : (x < 0 ? '-' : '') + '₹' + Math.abs(Math.round(x)).toLocaleString('en-IN'));
  const num = (x, d = 2) => (x == null || isNaN(x) ? '-' : Number(x).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const cls = (x) => (x > 0 ? 'pos' : x < 0 ? 'neg' : '');
  const hhmm = (iso) => new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
  const dmy = (iso) => new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: 'Asia/Kolkata' });

  let S = { ...QT.DEFAULTS, strat: { ...QT.DEFAULTS.strat }, favs: [] };
  try { const j = JSON.parse(localStorage.getItem('qt_cfg2')); if (j) S = { ...S, ...j, strat: { ...S.strat, ...(j.strat || {}) } }; } catch (e) {}
  const saveS = () => localStorage.setItem('qt_cfg2', JSON.stringify(S));
  QT.Paper.load();

  const A = { tab: 'watch', wl: 'sig', q: '', ord: 'all', pos: 'open', hf: 'all', feed: null, snap: null, rows: [], ignored: [], all: {}, expiries: { stock: [], index: [] },
    status: '', last: null, busy: false, toast: '', chains: {}, open: {}, sheet: null, ind: {}, sig: null, sigTs: {}, streak: {}, tried: {}, cid: null, dirty: false };

  // ---------- data refresh ----------
  async function pool(items, n, fn) {
    let i = 0;
    await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; try { await fn(items[k]); } catch (e) { A.lastErr = e.message; } } }));
  }
  const keyOf = (r) => r.sym + '|' + r.decision + '|' + r.strat;

  async function refresh() {
    if (A.busy) return; A.busy = true; A.status = 'Updating…'; paintHeader();
    try {
      if (S.mode === 'live' && !S.token.trim()) throw new Error('Add your Upstox token in Settings, or switch to Demo');
      const want = S.mode === 'live' ? 'LIVE' : 'DEMO';
      if (!A.feed || A.feed.name !== want || (want === 'LIVE' && A.feed.token !== S.token.trim())) {
        A.feed = QT.makeFeed(S); A.ind = {}; A.indDay = null; A.sig = null; A.expiries = { stock: [], index: [] }; A.cid = null; A.streak = {};
      }
      A.feed.tf = S.candleTf;
      const today = QT.istDate(), syms = Object.keys(QT.UNIVERSE);
      if (A.indDay !== today) { A.ind = {}; A.indDay = today; }
      const q = await A.feed.quotes();
      await pool(syms.filter((s) => !A.ind[s]), 5, async (s) => { A.ind[s] = QT.indicators(await A.feed.candles(s)); });
      if (!A.expiries.stock.length) {
        const [st, ix] = await Promise.all([A.feed.expiries('RELIANCE'), A.feed.expiries('NIFTY')]);
        A.expiries = { stock: QT.monthly(st, today), index: QT.monthly(ix, today) };
      }
      const vix = q.vix || (A.snap && A.snap.vix) || QT.DEMO_VIX;
      const cid = QT.candleId(S.candleTf);
      const newBoundary = A.cid !== cid || A.tfUsed !== S.candleTf;
      if (newBoundary || A.dirty || !A.sig) {
        // CLOSED-CANDLE LOGIC: signals are computed only from the last fully closed candle
        const sig = {}, sigTs = {};
        await pool(syms, 5, async (s) => { const c = await A.feed.closed(s, S.candleTf); if (c) { sig[s] = c.close; sigTs[s] = c.ts; } });
        A.sig = sig; A.sigTs = sigTs; A.tfUsed = S.candleTf; A.dirty = false;
        if (newBoundary) A.tried = {};
        const snap = { quotes: q.q, ind: A.ind, vix, today, sig, niftyTS: 0 };
        const ns = sig.NIFTY || q.q.NIFTY;
        if (A.ind.NIFTY && ns) snap.niftyTS = QT.agents('NIFTY', ns, A.ind.NIFTY, 0).ts;
        let rows = syms.map((s) => QT.evaluate(s, snap, S, null, A.expiries));
        const cands = rows.filter((r) => r.expiry && r.decision !== 'NO DATA' && (['BUY', 'SELL', 'NEUTRAL'].includes(r.decision) || /book rule/.test(r.reason || '')));
        const chains = {};
        await pool(cands, 4, async (r) => { chains[r.sym + '|' + r.expiry] = await A.feed.chain(r.sym, r.expiry); });
        rows = syms.map((s) => QT.evaluate(s, snap, S, chains, A.expiries));
        A.rows = rows.filter((r) => ['BUY', 'SELL', 'NEUTRAL'].includes(r.decision)).sort((a, b) => b.conviction - a.conviction);
        A.ignored = rows.filter((r) => !['BUY', 'SELL', 'NEUTRAL'].includes(r.decision));
        if (newBoundary) { // consecutive-closed-candle confirmation counter
          const ns2 = {};
          A.rows.forEach((r) => { const p = A.streak[r.sym]; ns2[r.sym] = { key: keyOf(r), n: p && p.key === keyOf(r) ? p.n + 1 : 1 }; });
          A.streak = ns2; A.cid = cid;
        }
        A.rows.forEach((r) => (r.streak = (A.streak[r.sym] || { n: 1 }).n));
        A.all = {}; rows.forEach((r) => (A.all[r.sym] = r));
        A.chains = chains;
      }
      A.snap = { quotes: q.q, ind: A.ind, vix, today, sig: A.sig };
      // mark open paper positions
      const ch2 = { ...A.chains };
      const need = [...new Set(QT.Paper.open().map((t) => t.sym + '|' + t.expiry))].filter((k) => !ch2[k]);
      await pool(need, 4, async (k) => { const [s, e] = k.split('|'); ch2[k] = await A.feed.chain(s, e); });
      A.chains = ch2;
      QT.Paper.markAll(S, q.q, ch2, today, A.sig).forEach((t) => toast(`${t.sym} ${t.status}: ${inr(t.pnl)}`));
      // auto paper orders from triggered, closed-candle-confirmed signals (only inside trading time)
      if (S.autoTrade && QT.canTrade(S, 'auto')) {
        let n = 0;
        for (const r of A.rows) {
          if (r.conviction < S.minConviction || (r.streak || 1) < S.confirmN) continue;
          const k = r.sym + '|' + A.cid; if (A.tried[k]) continue;
          if (!S.allowDup && QT.Paper.open().some((t) => t.sym === r.sym)) continue;
          A.tried[k] = 1;
          const res = await placeOrder(r, 'auto'); if (res.ok) n++;
        }
        if (n) toast(`Auto: ${n} paper order(s) executed`);
      }
      A.last = new Date(); A.status = '';
    } catch (e) { A.status = 'Error: ' + e.message; }
    A.busy = false; render();
  }
  async function placeOrder(row, src) {
    let r = row, chain = null;
    try { chain = await A.feed.chain(row.sym, row.expiry); } catch (e) {}
    const spot = A.snap.quotes[row.sym] || row.spot;
    if (chain) { // re-price against the live chain at execution time
      const tr = QT.buildTrade({ sym: row.sym, spot, ind: A.ind[row.sym], ag: row.ag, vix: A.snap.vix, S, strat: row.strat, expiry: row.expiry, today: A.snap.today, lot: QT.UNIVERSE[row.sym].lot, chain });
      if (!tr.pass) { QT.Paper.logOrder({ sym: row.sym, stratName: row.stratName, src, lots: row.lots, qty: row.qty, expiry: row.expiry, signal: row.decision, status: 'REJECTED', reason: 'Book rules failed at execution: ' + tr.fails.join('; '), legs: [] }); QT.Paper.save(); return { ok: false, msg: 'Rules failed at execution' }; }
      r = { ...row, ...tr };
    }
    return QT.Paper.enter(r, S, A.snap.quotes, src, { candle: A.sigTs[row.sym] });
  }
  function schedule() {
    clearInterval(A.timer);
    A.timer = setInterval(() => { if (S.mode === 'demo' || QT.marketOpen()) refresh(); }, Math.max(15, S.refreshSec) * 1000);
  }
  function toast(m) { A.toast = m; paintToast(); setTimeout(() => { if (A.toast === m) { A.toast = ''; paintToast(); } }, 4000); }
  const paintToast = () => { const t = $('#toast'); t.textContent = A.toast; t.style.display = A.toast ? 'block' : 'none'; };

  // ---------- header / nav ----------
  const IC = {
    watch: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
    orders: '<path d="M5 4h14v16l-3-2-2 2-2-2-2 2-2-2-3 2z"/><path d="M9 9h6M9 13h6"/>',
    pos: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2M3 13h18"/>',
    hist: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    set: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>',
  };
  const TABS = [['watch', 'Watchlist'], ['orders', 'Orders'], ['pos', 'Positions'], ['hist', 'History'], ['set', 'Settings']];
  function paintNav() { $('#nav').innerHTML = TABS.map(([k, l]) => `<button class="nb ${A.tab === k ? 'on' : ''}" data-tab="${k}"><svg viewBox="0 0 24 24">${IC[k]}</svg>${l}</button>`).join(''); }
  function paintHeader() {
    const s = A.snap, win = QT.canTrade(S, 'auto');
    const nq = s ? s.quotes.NIFTY : null, nprev = s && A.ind.NIFTY ? A.ind.NIFTY.prevClose : null;
    const nc = nq && nprev ? (nq / nprev - 1) * 100 : 0;
    $('#hdr').innerHTML = `<div class="h1"><span class="brand">Options Desk</span><span><span class="pill ${S.mode === 'live' ? 'on' : 'warn'}">${S.mode === 'live' ? '● LIVE' : '● DEMO'}</span> <button class="btn sm ghost" data-act="refresh">${A.busy ? '…' : '↻'}</button></span></div>
      <div class="idx"><span>NIFTY <b>${nq ? num(nq) : '-'}</b> <span class="${cls(nc)}">${nq ? (nc >= 0 ? '+' : '') + nc.toFixed(2) + '%' : ''}</span></span><span>VIX <b>${s ? s.vix.toFixed(2) : '-'}</b></span></div>
      <div class="st"><span class="pill ${win ? 'on' : 'off'}">${win ? 'Orders OPEN' : 'Orders CLOSED'} ${esc(S.tradeStart)}–${esc(S.tradeEnd)}</span><span class="pill">Candle ${S.candleTf}m · next close <b id="cd">--:--</b></span>${A.last ? `<span>upd ${A.last.toLocaleTimeString('en-IN', { hour12: false })}</span>` : ''}</div>
      ${A.status ? `<div class="sub ${/Error/.test(A.status) ? 'neg' : ''}">${esc(A.status)}</div>` : ''}`;
    tickClock();
  }
  function tickClock() { const e = $('#cd'); if (e) { const sec = QT.nextCloseSecs(S.candleTf); e.textContent = String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0'); } }
  setInterval(tickClock, 1000);

  // ---------- views ----------
  function chgOf(sym) { const q = A.snap && A.snap.quotes[sym], p = A.ind[sym] && A.ind[sym].prevClose; return q && p ? { ltp: q, pct: (q / p - 1) * 100 } : { ltp: q, pct: 0 }; }
  const isTrig = (r) => r && ['BUY', 'SELL', 'NEUTRAL'].includes(r.decision);
  function watch() {
    if (!A.snap) return `<div class="card">${A.busy ? 'Loading market data…' : 'Tap ↻ to load.'}<div class="sub">Demo mode works offline. For real prices add your Upstox token in Settings.</div></div>`;
    const syms = Object.keys(QT.UNIVERSE), q = A.q.trim().toUpperCase();
    let list = A.wl === 'sig' ? A.rows.map((r) => r.sym) : A.wl === 'fav' ? syms.filter((s) => S.favs.includes(s)) : syms;
    if (q) list = syms.filter((s) => s.includes(q));
    const sc = (s) => (isTrig(A.all[s]) ? A.all[s].conviction : -1);
    if (A.wl === 'all') list = [...list].sort((a, b) => sc(b) - sc(a) || a.localeCompare(b));
    let h = `<div class="seg">${[['sig', `Signals ${A.rows.length}`], ['all', 'All ' + syms.length], ['fav', '★ Favs']].map(([k, l]) => `<button class="${A.wl === k ? 'on' : ''}" data-act="wl" data-k="${k}">${l}</button>`).join('')}</div>`;
    h += `<input class="search" id="q" placeholder="Search symbol" value="${esc(A.q)}"><div id="wlist">${wlist(list)}</div>`;
    return h;
  }
  function wlist(list) {
    return list.map((s) => {
      const c = chgOf(s), r = A.all[s], trig = isTrig(r);
      const sub = trig ? `${esc(r.stratName)} · conv ${r.conviction}${S.confirmN > 1 ? ` · ${r.streak}/${S.confirmN} candles` : ''}` : r ? esc((r.reason || '').slice(0, 44)) : '';
      return `<div class="wr" data-act="sheet" data-s="${s}"><div><b>${S.favs.includes(s) ? '★ ' : ''}${s}</b> ${trig ? `<span class="chip ${r.decision}">${r.decision}</span>` : ''}<span class="sub">${sub}</span></div><div class="rt"><b>${c.ltp ? num(c.ltp) : '-'}</b><span class="${cls(c.pct)}">${c.pct >= 0 ? '+' : ''}${c.pct.toFixed(2)}%</span></div></div>`;
    }).join('') || `<div class="card sub">${A.wl === 'fav' ? 'No favourites yet. Open a symbol and tap ★.' : A.wl === 'sig' ? 'No triggered signals on the last closed candle.' : 'No match'}</div>`;
  }
  function sheet(sym) {
    const c = chgOf(sym), ind = A.ind[sym] || {}, r = A.all[sym], trig = isTrig(r), u = QT.UNIVERSE[sym];
    let h = `<div class="row"><span class="big">${sym}</span><span class="sp"></span><button class="star" data-act="fav" data-s="${sym}">${S.favs.includes(sym) ? '★' : '☆'}</button><button class="btn sm ghost" data-act="close-sheet">✕</button></div>
      <div class="row"><span class="big">${num(c.ltp)}</span><span class="${cls(c.pct)}">${c.pct >= 0 ? '+' : ''}${c.pct.toFixed(2)}%</span></div>
      <div class="grid"><div>Prev close<b>${num(ind.prevClose)}</b></div><div>20-DMA<b>${num(ind.ma20)}</b></div><div>50-DMA<b>${num(ind.ma50)}</b></div><div>52W high<b>${num(ind.hi52)}</b></div><div>52W low<b>${num(ind.lo52)}</b></div><div>Lot size<b>${u.lot}</b></div></div>
      <div class="sub">Closed ${S.candleTf}m candle: <b>${A.sig && A.sig[sym] ? num(A.sig[sym]) : '-'}</b>${A.sigTs[sym] ? ' @ ' + hhmm(A.sigTs[sym]) : ''} · signals use this close, not the live tick</div>`;
    if (!r) return h;
    h += `<div class="card" style="margin-top:10px"><div class="row"><span class="chip ${trig ? r.decision : ''}">${trig ? r.decision : 'NO TRADE'}</span><b>${esc(r.stratName || '')}</b>${trig ? `<span class="sp"></span><span class="chip">Conviction ${r.conviction}</span>` : ''}</div>`;
    if (r.ag) h += `<div class="sub">Bull ${r.ag.bull}/6 · Bear ${r.ag.bear}/6 · edge ${r.ag.edge > 0 ? '+' : ''}${r.ag.edge} · trend score ${r.ag.ts}</div>`;
    if (!trig) h += `<div class="warn" style="margin-top:6px">${esc(r.reason || '')}</div>`;
    if (r.ticket) h += `<div class="tk">${r.ticket.map(esc).join('<br>')}</div><div class="grid"><div>Expiry<b>${r.expiry}</b></div><div>${r.debit ? 'Debit' : 'Credit'}/share<b>${num(Math.abs(r.net))}</b></div><div>Lots<b>${r.lots}</b></div><div>Profit @ target<b class="pos">${inr(r.profitAtTarget)}</b></div><div>Loss @ SL<b class="neg">${inr(-r.lossAtSL)}</b></div><div>Margin<b>${inr(r.margin)}</b></div></div>`;
    if (r.fails && r.fails.length) h += `<div class="warn">FAIL: ${esc(r.fails.join('; '))}</div>`;
    if (r.warns && r.warns.length) h += `<div class="warn">WARN: ${esc(r.warns.join('; '))}</div>`;
    if (trig) h += `<div class="why">${esc(r.plan)}<br><b>BULL</b> ${esc(r.ag.bullTxt)}<br><b>BEAR</b> ${esc(r.ag.bearTxt)}<br><b>JUDGE</b> ${esc(r.verdict)}</div><div class="btns"><button class="btn full" data-act="order" data-s="${sym}">Place paper order</button></div>`;
    return h + '</div>';
  }
  function orders() {
    const all = QT.Paper.st.orders, list = all.filter((o) => A.ord === 'all' || (A.ord === 'done' ? o.status === 'COMPLETE' : o.status === 'REJECTED'));
    let h = `<div class="seg">${[['all', 'All ' + all.length], ['done', 'Executed'], ['rej', 'Rejected']].map(([k, l]) => `<button class="${A.ord === k ? 'on' : ''}" data-act="ord" data-k="${k}">${l}</button>`).join('')}</div>`;
    h += list.map((o) => `<div class="card"><div class="row"><b>${o.sym}</b><span class="chip ${o.src === 'manual' ? 'MANUAL' : o.signal === 'EXIT' ? 'EXIT' : 'AUTO'}">${o.signal === 'EXIT' ? 'EXIT' : o.src.toUpperCase()}</span><span class="sp"></span><span class="chip ${o.status}">${o.status}</span></div>
      <div class="sub">${dmy(o.time)} ${hhmm(o.time)} · ${o.id} · ${esc(o.stratName)} · ${o.lots}L${o.candle ? ' · candle ' + hhmm(o.candle) : ''}</div>
      ${o.legs && o.legs.length ? `<div class="tk">${o.legs.map((l) => `${l.a === 'B' ? 'BUY ' : 'SELL'} ${o.expiry} ${l.K} ${l.t} @ ${num(l.px)}`).join('<br>')}</div>` : ''}
      ${o.reason ? `<div class="${o.status === 'REJECTED' ? 'neg' : 'sub'}">${esc(o.reason)}</div>` : ''}</div>`).join('') || '<div class="card sub">No orders yet. Orders from triggered signals appear here with their status.</div>';
    return h;
  }
  function fundsTiles() {
    const P = QT.Paper, un = P.unrealized();
    return `<div class="tiles"><div>Equity<b>${inr(P.equity(S))}</b></div><div>Available<b>${inr(P.available(S))}</b></div><div>Margin used<b>${inr(P.margin())}</b></div><div>Realized<b class="${cls(P.st.realized)}">${inr(P.st.realized)}</b></div><div>Unrealized<b class="${cls(un)}">${inr(un)}</b></div><div>Total P&L<b class="${cls(P.st.realized + un)}">${inr(P.st.realized + un)}</b></div></div>`;
  }
  function positions() {
    const P = QT.Paper, list = A.pos === 'open' ? P.open() : P.closed();
    let h = fundsTiles() + `<div class="seg">${[['open', 'Open ' + P.open().length], ['closed', 'Closed ' + P.closed().length]].map(([k, l]) => `<button class="${A.pos === k ? 'on' : ''}" data-act="pos" data-k="${k}">${l}</button>`).join('')}</div>`;
    h += list.map((t) => {
      const pnl = t.status === 'OPEN' ? (t.pnlGross || 0) - t.chEntry : t.pnl;
      return `<div class="card"><div class="row"><b>${t.sym}</b><span class="chip">${esc(t.stratName)}</span><span class="sp"></span><b class="${cls(pnl)}">${inr(pnl)}</b></div>
      <div class="sub">${t.id} · ${t.lots}L (${t.qty}) · exp ${t.expiry} · ${t.status === 'OPEN' ? 'exit by ' + t.exitBy : t.status}</div>
      <div class="tk">${t.legs.map((l) => `${l.a === 'B' ? 'BUY ' : 'SELL'} ${l.K} ${l.t} @ ${num(l.fill)}${l.exitPx != null ? ' → ' + num(l.exitPx) : ''}`).join('<br>')}</div>
      <div class="sub">Spot ${num(t.entrySpot)} → ${num(t.status === 'OPEN' ? t.curSpot : t.exitSpot)}${t.targetSpot ? ` · T ${num(t.targetSpot)} · SL ${num(t.slSpot)}` : ''} · margin ${inr(t.margin)}</div>
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
  function history() {
    const P = QT.Paper, st = P.stats();
    let h = `<div class="tiles"><div>Trades<b>${st.total}</b></div><div>Win rate<b>${st.winRate.toFixed(0)}%</b></div><div>Profit factor<b>${st.pf === Infinity ? '∞' : st.pf.toFixed(2)}</b></div><div>Avg win<b class="pos">${inr(st.avgWin)}</b></div><div>Avg loss<b class="neg">${inr(st.avgLoss)}</b></div><div>Max drawdown<b class="neg">${inr(-st.maxDD)}</b></div></div>
      <div class="card">${curve()}</div>`;
    const dw = P.daywise();
    if (dw.length) h += `<div class="card"><h4>Day-wise P&L</h4>${dw.slice(0, 14).map((d) => `<div class="row"><span>${d.d}</span><span class="sub">${d.n} trade(s)</span><span class="sp"></span><b class="${cls(d.pnl)}">${inr(d.pnl)}</b></div>`).join('')}</div>`;
    h += `<div class="row" style="margin:4px 0 8px"><h4 style="margin:0">Trade register</h4><span class="sp"></span><button class="btn sm" data-act="csv">Export CSV</button></div>
      <div class="seg">${[['all', 'All'], ['open', 'Open'], ['closed', 'Closed'], ['win', 'Wins'], ['loss', 'Losses']].map(([k, l]) => `<button class="${A.hf === k ? 'on' : ''}" data-act="hf" data-k="${k}">${l}</button>`).join('')}</div>`;
    const f = P.st.trades.filter((t) => A.hf === 'all' || (A.hf === 'open' && t.status === 'OPEN') || (A.hf === 'closed' && t.status !== 'OPEN') || (A.hf === 'win' && t.pnl > 0) || (A.hf === 'loss' && t.status !== 'OPEN' && t.pnl <= 0));
    h += f.map((t) => {
      const pnl = t.status === 'OPEN' ? null : t.pnl, o = A.open['t' + t.id];
      return `<div class="card" data-act="tog" data-k="t${t.id}"><div class="row"><b>${t.sym}</b><span class="chip ${/TARGET/.test(t.status) ? 'TARGET' : /SL/.test(t.status) ? 'SL' : ''}">${t.status}</span><span class="sp"></span><b class="${cls(pnl)}">${pnl == null ? 'open' : inr(pnl)}</b></div>
      <div class="sub">${t.id} · ${dmy(t.time)} ${hhmm(t.time)}${t.exitTime ? ' → ' + dmy(t.exitTime) + ' ' + hhmm(t.exitTime) : ''} · ${esc(t.stratName)}</div>
      ${o ? `<div class="tk">${t.legs.map((l) => `${l.a === 'B' ? 'BUY ' : 'SELL'} ${l.K} ${l.t} @ ${num(l.fill)}${l.exitPx != null ? ' → ' + num(l.exitPx) : ''}`).join('<br>')}</div>
      <div class="grid"><div>Order<b>${t.orderId}</b></div><div>Origin<b>${t.origin}</b></div><div>Expiry<b>${t.expiry}</b></div><div>Qty<b>${t.qty}</b></div><div>Gross<b class="${cls(t.pnlGross)}">${inr(t.pnlGross)}</b></div><div>Charges<b>${inr((t.chEntry || 0) + (t.chExit || 0))}</b></div></div><div class="why">${esc(t.why || '')}</div>` : ''}</div>`;
    }).join('') || '<div class="card sub">No trades in the register yet.</div>';
    return h + `<div class="btns"><button class="btn sm ghost" data-act="reset">Reset paper account</button></div>`;
  }

  const SCHEMA = [
    ['Signal logic (closed candles)', [['candleTf', 'Candle timeframe', 'sel', [[5, '5 minutes'], [15, '15 minutes'], [30, '30 minutes'], [60, '60 minutes']]], ['confirmN', 'Confirm on N consecutive closed candles', 'sel', [[1, '1 (act on first close)'], [2, '2 candles'], [3, '3 candles']]],
      ['closeExit', 'Spot target/SL checked on candle close only', 'bool']]],
    ['Paper account & orders', [['autoTrade', 'Auto paper-trade triggered signals', 'bool'], ['capital', 'Starting capital (₹) – applies on Reset', 'num'], ['minConviction', 'Min conviction to auto-trade', 'num'], ['maxOpen', 'Max open positions', 'num'],
      ['allowDup', 'Allow duplicate symbol', 'bool'], ['charges', 'Apply brokerage & taxes', 'bool'], ['brokerage', 'Brokerage per order (₹)', 'num'], ['sttPct', 'STT on sell premium (%)', 'pct'], ['slipPct', 'Slippage on fills (%)', 'pct']]],
    ['Strategy parameters', [['profitGoal', 'Profit goal per trade (₹)', 'num'], ['vixThreshold', 'VIX threshold debit/credit', 'num'], ['targetPct', 'Underlying target (%)', 'pct'], ['slPct', 'Underlying stop-loss (%)', 'pct'],
      ['widthStock', 'Spread width – stocks (%)', 'pct'], ['widthNifty', 'Spread width – Nifty (%)', 'pct'], ['maxLots', 'Max lots', 'num'], ['minEdge', 'Min agent edge (max 6)', 'num'], ['holdDays', 'Assumed days to target', 'num'], ['ivMult', 'Stock IV = VIX ×', 'num'], ['rf', 'Risk-free rate (%)', 'pct']]],
    ['Book rules', [['minOI', 'Min open interest / leg (contracts)', 'num'], ['minVol', 'Min avg volume (shares)', 'num'], ['maxBA', 'Max bid-ask (% of mid)', 'pct'], ['minYield', 'Min credit yield (% of width)', 'pct'], ['minDTEBuy', 'Min days to expiry – bought', 'num'],
      ['maxDTESell', 'Max days to expiry – sold', 'num'], ['exitBefore', 'Exit bought options N days before expiry', 'num'], ['creditTP', 'Credit: take profit at % of credit', 'pct']]],
  ];
  const field = ([k, l, ty, opts]) => ty === 'bool' ? `<label class="tg"><span>${l}</span><input type="checkbox" data-k="${k}" ${S[k] ? 'checked' : ''}></label>`
    : ty === 'sel' ? `<label>${l}<select data-k="${k}" data-n="1">${opts.map(([v, t]) => `<option value="${v}" ${+S[k] === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>`
    : `<label>${l}<input type="number" step="any" data-k="${k}" data-t="${ty}" value="${ty === 'pct' ? +(S[k] * 100).toFixed(4) : S[k]}"></label>`;
  function settings() {
    const exp = A.expiries.stock, nm = ['near', 'next', 'far'];
    const eo = [['auto', 'AUTO – book rule (far for bought, near for sold)'], ...exp.map((d, i) => [d, `${nm[i] || ''} month – ${d}`])];
    let h = `<div class="card"><h4>Data feed</h4><label>Mode<select data-k="mode"><option value="demo" ${S.mode === 'demo' ? 'selected' : ''}>Demo (offline synthetic)</option><option value="live" ${S.mode === 'live' ? 'selected' : ''}>Live – Upstox API</option></select></label>
      <label>Upstox API token<input type="password" id="tok" data-k="token" value="${esc(S.token)}" placeholder="Paste Analytics (read-only) token" autocomplete="off"></label>
      <label>Refresh every (sec)<input type="number" data-k="refreshSec" value="${S.refreshSec}"></label>
      <div class="btns"><button class="btn sm" data-act="test">Test connection</button><button class="btn sm ghost" data-act="showtok">Show/hide</button></div><div class="sub" id="testres"></div></div>
      <div class="card"><h4>Trading time (IST)</h4><label>Orders allowed from<input type="time" data-k="tradeStart" value="${S.tradeStart}"></label><label>Orders allowed until<input type="time" data-k="tradeEnd" value="${S.tradeEnd}"></label>
      <label class="tg"><span>Demo mode ignores trading time</span><input type="checkbox" data-k="demoIgnoreHours" ${S.demoIgnoreHours ? 'checked' : ''}></label>
      <label class="tg"><span>Allow manual orders outside time</span><input type="checkbox" data-k="manualOutside" ${S.manualOutside ? 'checked' : ''}></label>
      <div class="sub">Weekdays only. Orders outside this window are not placed (manual ones are logged as REJECTED). Open positions are still monitored and exited during market hours 09:15–15:30.</div></div>
      <div class="card"><h4>Option expiry</h4><label>Expiry<select data-k="expiryMode">${eo.map(([v, t]) => `<option value="${v}" ${S.expiryMode === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label><div class="sub">${exp.length ? 'Dates fetched from the feed.' : 'Refresh once to load available expiries.'} A manual expiry turns DTE book rules into warnings.</div></div>
      <div class="card"><h4>The 10 strategy concepts</h4>${Object.entries(QT.STRATS).map(([n, s]) => `<label class="tg"><span>${n}. ${s.name} <i>(${s.bias === 'U' ? 'bullish' : s.bias === 'D' ? 'bearish' : 'neutral'}, ${s.risk === 'D' ? 'debit' : 'credit'})</i></span><input type="checkbox" data-s="${n}" ${S.strat[n] ? 'checked' : ''}></label>`).join('')}</div>`;
    SCHEMA.forEach(([t, f]) => (h += `<div class="card"><h4>${t}</h4>${f.map(field).join('')}</div>`));
    return h + `<div class="card"><label>Theme<select data-k="theme"><option value="dark" ${S.theme === 'dark' ? 'selected' : ''}>Dark</option><option value="light" ${S.theme === 'light' ? 'selected' : ''}>Light</option></select></label><div class="btns"><button class="btn sm ghost" data-act="defaults">Restore defaults</button></div><div class="sub">Educational tool, not investment advice. Paper trading only – no real orders are ever placed.</div></div>`;
  }

  function render() {
    document.documentElement.dataset.theme = S.theme;
    paintHeader(); paintNav(); paintToast();
    const ae = document.activeElement;
    if (A.tab === 'set' && ae && ae.tagName === 'INPUT' && ae.type !== 'checkbox') return; // don't rebuild while typing
    if (A.tab === 'watch' && ae && ae.id === 'q') { renderSheet(); return; }
    const v = $('#view'), sc = v.scrollTop;
    v.innerHTML = { watch, orders, pos: positions, hist: history, set: settings }[A.tab]();
    v.scrollTop = sc; renderSheet();
  }
  function renderSheet() { const sh = $('#sheet'); if (A.sheet) { sh.innerHTML = sheet(A.sheet); sh.style.display = 'block'; $('#sheetbg').style.display = 'block'; } else { sh.style.display = 'none'; $('#sheetbg').style.display = 'none'; } }

  // ---------- events ----------
  document.addEventListener('input', (e) => {
    if (e.target.id !== 'q') return;
    A.q = e.target.value; const q = A.q.trim().toUpperCase(), syms = Object.keys(QT.UNIVERSE);
    const list = q ? syms.filter((s) => s.includes(q)) : A.wl === 'sig' ? A.rows.map((r) => r.sym) : A.wl === 'fav' ? syms.filter((s) => S.favs.includes(s)) : syms;
    $('#wlist').innerHTML = wlist(list);
  });
  document.addEventListener('click', async (e) => {
    if (e.target.id === 'sheetbg') { A.sheet = null; return renderSheet(); }
    const t = e.target.closest('[data-tab],[data-act]'); if (!t) return;
    if (t.dataset.tab) { A.tab = t.dataset.tab; A.sheet = null; return render(); }
    const a = t.dataset.act, k = t.dataset.k;
    if (a === 'refresh') refresh();
    else if (a === 'wl') { A.wl = k; A.q = ''; render(); } else if (a === 'ord') { A.ord = k; render(); } else if (a === 'pos') { A.pos = k; render(); } else if (a === 'hf') { A.hf = k; render(); }
    else if (a === 'tog') { A.open[k] = !A.open[k]; render(); }
    else if (a === 'sheet') { A.sheet = t.dataset.s; renderSheet(); }
    else if (a === 'close-sheet') { A.sheet = null; renderSheet(); }
    else if (a === 'fav') { const s = t.dataset.s; S.favs = S.favs.includes(s) ? S.favs.filter((x) => x !== s) : [...S.favs, s]; saveS(); render(); }
    else if (a === 'order') {
      const r = A.all[t.dataset.s]; t.disabled = true; const res = await placeOrder(r, 'manual');
      toast(res.ok ? `Order ${res.order.id} executed` : 'Rejected: ' + res.msg); A.sheet = null; render();
    }
    else if (a === 'exit') {
      const tr = QT.Paper.open().find((x) => x.id === t.dataset.id); let ch = A.chains[tr.sym + '|' + tr.expiry];
      if (!ch) { try { ch = await A.feed.chain(tr.sym, tr.expiry); } catch (er) {} }
      if (!ch) return toast('No option prices available');
      QT.Paper.close(tr, 'MANUAL', S, ch); toast(`${tr.sym} exited ${inr(tr.pnl)}`); render();
    }
    else if (a === 'reset') { if (confirm('Reset paper account and clear all orders & trades?')) { QT.Paper.reset(S.capital); render(); } }
    else if (a === 'csv') {
      const csv = QT.Paper.csv(), Sh = globalThis.Capacitor && globalThis.Capacitor.Plugins && globalThis.Capacitor.Plugins.Share;
      if (Sh) { try { await Sh.share({ title: 'Trade register', text: csv, dialogTitle: 'Export trade register' }); return; } catch (er) {} }
      try { await navigator.clipboard.writeText(csv); toast('CSV copied to clipboard'); } catch (er) { toast('Export failed'); }
    }
    else if (a === 'showtok') { const i = $('#tok'); i.type = i.type === 'password' ? 'text' : 'password'; }
    else if (a === 'defaults') { if (confirm('Restore all settings (keeps token & favourites)?')) { S = { ...QT.DEFAULTS, strat: { ...QT.DEFAULTS.strat }, token: S.token, favs: S.favs }; saveS(); A.dirty = true; render(); } }
    else if (a === 'test') {
      const out = $('#testres'); out.textContent = 'Testing…';
      try { const f = QT.makeFeed({ ...S, mode: 'live' }); const q = await f.quotes(); const c = await f.closed('SBIN', S.candleTf).catch((x) => ({ err: x.message }));
        out.textContent = `OK – Nifty ${q.q.NIFTY}, VIX ${q.vix}, ${Object.keys(q.q).length}/51 quotes · intraday: ${c && c.close ? 'OK' : c && c.err ? c.err : 'no closed candle yet'}`; }
      catch (er) { out.textContent = 'Failed: ' + er.message; }
    }
  });
  let rt = null;
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (el.dataset.s) { S.strat[el.dataset.s] = el.checked; saveS(); A.dirty = true; clearTimeout(rt); rt = setTimeout(() => refresh(), 800); return; }
    const k = el.dataset.k; if (!k) return;
    if (el.type === 'checkbox') S[k] = el.checked;
    else if (el.type === 'number') { const v = parseFloat(el.value); if (isNaN(v)) return; S[k] = el.dataset.t === 'pct' ? v / 100 : v; }
    else S[k] = el.dataset.n ? +el.value : el.value;
    saveS(); if (k === 'refreshSec') schedule();
    if (k === 'mode' || k === 'token') { A.feed = null; A.snap = null; }
    if (!['theme', 'refreshSec', 'token', 'mode', 'tradeStart', 'tradeEnd', 'autoTrade', 'capital', 'demoIgnoreHours', 'manualOutside'].includes(k)) { A.dirty = true; clearTimeout(rt); rt = setTimeout(() => refresh(), 800); }
    if (el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'time') render(); else paintHeader();
  });

  QT.app = { S: () => S, A, refresh };
  document.addEventListener('DOMContentLoaded', () => { render(); schedule(); if (S.mode === 'demo' || S.token) refresh(); });
})();

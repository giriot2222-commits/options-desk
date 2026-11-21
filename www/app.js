/* App: refresh loop + UI */
(function () {
  const QT = globalThis.QT;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const inr = (x) => (x == null ? '-' : (x < 0 ? '-' : '') + '₹' + Math.abs(Math.round(x)).toLocaleString('en-IN'));
  const cls = (x) => (x > 0 ? 'pos' : x < 0 ? 'neg' : '');

  let S = { ...QT.DEFAULTS, strat: { ...QT.DEFAULTS.strat } };
  try { const j = JSON.parse(localStorage.getItem('qt_cfg')); if (j) S = { ...S, ...j, strat: { ...S.strat, ...(j.strat || {}) } }; } catch (e) {}
  const saveS = () => localStorage.setItem('qt_cfg', JSON.stringify(S));
  QT.Paper.load();

  const A = { tab: 'dash', feed: null, snap: null, rows: [], ignored: [], expiries: { stock: [], index: [] }, status: '', last: null, busy: false, timer: null, toast: '', chains: {}, open: {} };

  // ---------- refresh ----------
  async function pool(items, n, fn) {
    const out = []; let i = 0;
    await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch (e) { out[k] = null; A.lastErr = e.message; } } }));
    return out;
  }
  async function refresh(manual) {
    if (A.busy) return; A.busy = true; A.status = 'Refreshing…'; render();
    try {
      if (S.mode === 'live' && !S.token) throw new Error('Add your Upstox API token in Settings (or switch to Demo mode).');
      if (!A.feed || A.feed.name !== (S.mode === 'live' ? 'LIVE' : 'DEMO') || (S.mode === 'live' && A.feed.token !== S.token.trim())) { A.feed = QT.makeFeed(S); A.snap = null; A.cdl = {}; A.expiries = { stock: [], index: [] }; }
      const today = QT.istDate(), syms = Object.keys(QT.UNIVERSE);
      A.cdl = A.cdl || {}; A.indDay = A.indDay || {};
      if (A.indDay.date !== today || A.indDay.mode !== A.feed.name) { A.ind = {}; A.indDay = { date: today, mode: A.feed.name }; }
      const q = await A.feed.quotes();
      const need = syms.filter((s) => !A.ind[s]);
      await pool(need, 5, async (s) => { A.ind[s] = QT.indicators(await A.feed.candles(s)); });
      if (!A.expiries.stock.length) {
        const [st, ix] = await Promise.all([A.feed.expiries('RELIANCE'), A.feed.expiries('NIFTY')]);
        A.expiries = { stock: QT.monthly(st, today), index: QT.monthly(ix, today) };
      }
      const vix = q.vix || A.snap?.vix || QT.DEMO_VIX;
      const snap = { quotes: q.q, ind: A.ind, vix, today, niftyTS: 0 };
      if (snap.ind.NIFTY && snap.quotes.NIFTY) snap.niftyTS = QT.agents('NIFTY', snap.quotes.NIFTY, snap.ind.NIFTY, 0).ts;
      A.snap = snap;
      // stage 1: model pass
      let rows = syms.map((s) => QT.evaluate(s, snap, S, null, A.expiries));
      // stage 2: fetch chains for candidates & re-evaluate with live bid/ask/OI
      const cands = rows.filter((r) => r.expiry && r.decision !== 'NO DATA' && (r.decision === 'BUY' || r.decision === 'SELL' || r.decision === 'NEUTRAL' || /book rule/.test(r.reason || '')));
      const chains = {};
      await pool(cands, 4, async (r) => { chains[r.sym + '|' + r.expiry] = await A.feed.chain(r.sym, r.expiry); });
      rows = syms.map((s) => QT.evaluate(s, snap, S, chains, A.expiries));
      A.chains = chains;
      A.rows = rows.filter((r) => r.decision === 'BUY' || r.decision === 'SELL' || r.decision === 'NEUTRAL').sort((a, b) => b.conviction - a.conviction);
      A.ignored = rows.filter((r) => r.decision !== 'BUY' && r.decision !== 'SELL' && r.decision !== 'NEUTRAL');
      // paper: mark open trades (need chains for their expiries), then auto-trade
      const ch2 = { ...chains };
      const openKeys = [...new Set(QT.Paper.open().map((t) => t.sym + '|' + t.expiry))].filter((k) => !ch2[k]);
      await pool(openKeys, 4, async (k) => { const [s, e] = k.split('|'); ch2[k] = await A.feed.chain(s, e); });
      const closed = QT.Paper.markAll(S, snap.quotes, ch2, today);
      closed.forEach((t) => toast(`${t.sym} ${t.status}: ${inr(t.pnl)}`));
      if (S.autoTrade) {
        let n = 0;
        for (const r of A.rows) {
          if (r.conviction < S.minConviction || r.decision === 'NEUTRAL' && false) continue;
          const res = QT.Paper.enter(r, S, snap.quotes);
          if (res.ok) n++; else if (/Max open|margin|closed/i.test(res.msg)) break;
        }
        if (n) toast(`Auto-trade: ${n} new paper trade(s)`);
      }
      A.last = new Date(); A.status = (A.feed.name === 'LIVE' ? 'LIVE' : 'DEMO') + (QT.marketOpen() ? '' : ' · market closed'); A.lastErr = A.lastErr && manual ? A.lastErr : null;
    } catch (e) { A.status = 'Error: ' + e.message; }
    A.busy = false; render();
  }
  function schedule() {
    clearInterval(A.timer);
    A.timer = setInterval(() => { if (S.mode === 'demo' || QT.marketOpen()) refresh(); }, Math.max(15, S.refreshSec) * 1000);
  }
  function toast(m) { A.toast = m; render(); setTimeout(() => { if (A.toast === m) { A.toast = ''; render(); } }, 4000); }

  // ---------- views ----------
  function header() {
    const s = A.snap;
    return `<div class="hdr"><div><b>Options Desk</b><div class="sub">${s ? `Nifty ${s.quotes.NIFTY?.toLocaleString('en-IN')} · VIX ${s.vix.toFixed(2)}` : 'No data yet'}</div>
      <div class="sub ${/Error/.test(A.status) ? 'neg' : ''}">${esc(A.status)}${A.last ? ' · ' + A.last.toLocaleTimeString() : ''}</div></div>
      <button class="btn" data-act="refresh">${A.busy ? '…' : '↻'}</button></div>`;
  }
  function dash() {
    if (!A.snap) return `<div class="card">Tap ↻ to load. Demo mode works offline; for live data add your Upstox token in Settings.</div>`;
    const reg = A.snap.vix < S.vixThreshold ? 'BUY options (low VIX)' : 'SELL defined-risk spreads (high VIX)';
    let h = `<div class="card note">Triggered: <b>${A.rows.length}</b> · Ignored: ${A.ignored.length} · Regime: ${reg} · Goal ${inr(S.profitGoal)}</div>`;
    h += A.rows.map((r, i) => {
      const op = A.open['d' + i];
      return `<div class="card"><div class="row"><b>${i + 1}. ${esc(r.sym)}</b><span class="chip ${r.decision}">${r.decision}</span><span class="chip">Conv ${r.conviction}</span><span class="sp"></span>₹${r.spot}</div>
      <div class="sub">${esc(r.stratName)} · exp ${r.expiry} (${r.dte}d) · ${esc(r.src)}</div>
      <div class="tk">${r.ticket.map(esc).join('<br>')}</div>
      <div class="grid"><div>Lots<b>${r.lots}</b></div><div>${r.debit ? 'Debit' : 'Credit'}<b>${Math.abs(r.net)}</b></div><div>Profit@T<b class="pos">${inr(r.profitAtTarget)}</b></div><div>Loss@SL<b class="neg">${inr(-r.lossAtSL)}</b></div><div>Max loss<b>${inr(r.maxLoss * r.qty)}</b></div><div>Margin<b>${inr(r.margin)}</b></div></div>
      ${r.targetSpot ? `<div class="sub">Buy area ${r.buyArea} · target ${r.targetSpot} · SL ${r.slSpot}</div>` : ''}
      ${r.warns.length ? `<div class="warn">WARN: ${esc(r.warns.join('; '))}</div>` : '<div class="ok">Book rules: PASS</div>'}
      <div class="btns"><button class="btn sm" data-act="paper" data-i="${i}">Paper trade</button><button class="btn sm ghost" data-act="tog" data-k="d${i}">${op ? 'Less' : 'Why?'}</button></div>
      ${op ? `<div class="why">${esc(r.plan)}<br><b>BULL:</b> ${esc(r.ag.bullTxt)}<br><b>BEAR:</b> ${esc(r.ag.bearTxt)}<br><b>JUDGE:</b> ${esc(r.verdict)}</div>` : ''}</div>`;
    }).join('') || '<div class="card">No trade passes the rules right now.</div>';
    h += `<div class="card"><a data-act="tog" data-k="ign" class="lnk">${A.open.ign ? '▾' : '▸'} Ignored (${A.ignored.length})</a>${A.open.ign ? A.ignored.map((r) => `<div class="sub"><b>${esc(r.sym)}</b> ${esc(r.reason || '')}</div>`).join('') : ''}</div>`;
    return h;
  }
  function paper() {
    const P = QT.Paper, st = P.stats(), un = P.unrealized();
    let h = `<div class="tiles"><div>Equity<b>${inr(P.equity(S))}</b></div><div>Available<b>${inr(P.available(S))}</b></div><div>Realized<b class="${cls(P.st.realized)}">${inr(P.st.realized)}</b></div><div>Unrealized<b class="${cls(un)}">${inr(un)}</b></div><div>Win rate<b>${st.winRate.toFixed(0)}%</b></div><div>Open / Closed<b>${st.open} / ${st.closed}</b></div></div>`;
    h += `<div class="card note">Auto-trade: <b>${S.autoTrade ? 'ON' : 'OFF'}</b> · min conviction ${S.minConviction} · expiry: ${S.expiryMode}</div><h4>Open positions</h4>`;
    h += P.open().map((t) => `<div class="card"><div class="row"><b>${t.sym}</b><span class="chip">${esc(t.stratName)}</span><span class="sp"></span><b class="${cls(t.pnlGross - t.chEntry)}">${inr((t.pnlGross || 0) - t.chEntry)}</b></div>
      <div class="sub">${t.id} · ${t.lots}L · exp ${t.expiry} · exit by ${t.exitBy}</div>
      <div class="tk">${t.legs.map((l) => `${l.a === 'B' ? 'BUY' : 'SELL'} ${l.K} ${l.t} @ ${l.fill}`).join('<br>')}</div>
      <div class="sub">Spot ${t.entrySpot} → ${t.curSpot}${t.targetSpot ? ` · T ${t.targetSpot} · SL ${t.slSpot}` : ''} · margin ${inr(t.margin)}</div>
      <div class="btns"><button class="btn sm ghost" data-act="close" data-id="${t.id}">Close now</button></div></div>`).join('') || '<div class="card">No open positions.</div>';
    return h;
  }
  function log() {
    const c = QT.Paper.closed();
    return `<div class="btns"><button class="btn sm" data-act="csv">Copy CSV</button><button class="btn sm ghost" data-act="reset">Reset account</button></div>` +
      c.map((t) => `<div class="card"><div class="row"><b>${t.sym}</b><span class="chip ${/TARGET/.test(t.status) ? 'BUY' : /SL/.test(t.status) ? 'SELL' : ''}">${t.status}</span><span class="sp"></span><b class="${cls(t.pnl)}">${inr(t.pnl)}</b></div>
      <div class="sub">${t.id} · ${esc(t.stratName)} · ${t.lots}L · gross ${inr(t.pnlGross)} · charges ${inr(t.chEntry + t.chExit)}</div></div>`).join('') || '<div class="card">No closed trades yet.</div>';
  }

  const SCHEMA = [
    ['Paper trading', [
      ['autoTrade', 'Auto paper-trade triggered signals', 'bool'], ['capital', 'Starting capital (₹) – applies on Reset', 'num'], ['minConviction', 'Min conviction to auto-trade', 'num'],
      ['maxOpen', 'Max open trades', 'num'], ['allowDup', 'Allow duplicate symbol', 'bool'], ['allowOffHours', 'Allow entries when market closed (live)', 'bool'],
      ['charges', 'Apply brokerage & taxes', 'bool'], ['brokerage', 'Brokerage per order (₹)', 'num'], ['sttPct', 'STT on sell premium (%)', 'pct'], ['slipPct', 'Slippage on fills (%)', 'pct']]],
    ['Strategy parameters', [
      ['profitGoal', 'Profit goal per trade (₹)', 'num'], ['vixThreshold', 'VIX threshold debit/credit', 'num'], ['targetPct', 'Underlying target (%)', 'pct'], ['slPct', 'Underlying stop-loss (%)', 'pct'],
      ['widthStock', 'Spread width – stocks (%)', 'pct'], ['widthNifty', 'Spread width – Nifty (%)', 'pct'], ['maxLots', 'Max lots', 'num'], ['minEdge', 'Min agent edge (max 6)', 'num'],
      ['holdDays', 'Assumed days to target', 'num'], ['ivMult', 'Stock IV = VIX ×', 'num'], ['rf', 'Risk-free rate (%)', 'pct']]],
    ['Book rules', [
      ['minOI', 'Min open interest / leg (contracts)', 'num'], ['minVol', 'Min avg volume (shares)', 'num'], ['maxBA', 'Max bid-ask (% of mid)', 'pct'], ['minYield', 'Min credit yield (% of width)', 'pct'],
      ['minDTEBuy', 'Min days to expiry – bought', 'num'], ['maxDTESell', 'Max days to expiry – sold', 'num'], ['exitBefore', 'Exit bought options N days before expiry', 'num'], ['creditTP', 'Credit: take profit at % of credit', 'pct']]],
  ];
  function settings() {
    const exp = A.expiries.stock;
    const names = ['near', 'next', 'far'];
    const opts = [['auto', 'AUTO – book rule (far for bought, near for sold)'], ...exp.map((d, i) => [d, `${names[i] || ''} month – ${d}`])];
    let h = `<div class="card"><h4>Data feed</h4>
      <label>Mode<select data-k="mode"><option value="demo" ${S.mode === 'demo' ? 'selected' : ''}>Demo (offline synthetic)</option><option value="live" ${S.mode === 'live' ? 'selected' : ''}>Live – Upstox API</option></select></label>
      <label>Upstox API token<input type="password" id="tok" data-k="token" value="${esc(S.token)}" placeholder="Paste Analytics (read-only) token" autocomplete="off"></label>
      <label>Refresh every (sec)<input type="number" data-k="refreshSec" value="${S.refreshSec}"></label>
      <div class="btns"><button class="btn sm" data-act="test">Test connection</button><button class="btn sm ghost" data-act="showtok">Show/hide</button></div><div class="sub" id="testres"></div></div>`;
    h += `<div class="card"><h4>Option expiry (paper trades)</h4><label>Expiry<select data-k="expiryMode">${opts.map(([v, l]) => `<option value="${v}" ${S.expiryMode === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <div class="sub">${exp.length ? 'Dates fetched from the feed.' : 'Tap ↻ on the dashboard to load available expiries.'} With a manual expiry, DTE book rules become warnings and exit-by date adapts.</div></div>`;
    h += `<div class="card"><h4>The 10 strategy concepts</h4>${Object.entries(QT.STRATS).map(([n, s]) => `<label class="tg"><span>${n}. ${s.name} <i>(${s.bias === 'U' ? 'bullish' : s.bias === 'D' ? 'bearish' : 'neutral'}, ${s.risk === 'D' ? 'debit' : 'credit'})</i></span><input type="checkbox" data-s="${n}" ${S.strat[n] ? 'checked' : ''}></label>`).join('')}</div>`;
    SCHEMA.forEach(([t, f]) => {
      h += `<div class="card"><h4>${t}</h4>${f.map(([k, l, ty]) => ty === 'bool' ? `<label class="tg"><span>${l}</span><input type="checkbox" data-k="${k}" ${S[k] ? 'checked' : ''}></label>` : `<label>${l}<input type="number" step="any" data-k="${k}" data-t="${ty}" value="${ty === 'pct' ? +(S[k] * 100).toFixed(4) : S[k]}"></label>`).join('')}</div>`;
    });
    return h + `<div class="card"><button class="btn sm ghost" data-act="defaults">Restore defaults</button><div class="sub">Educational tool, not investment advice. Paper trading only – no orders are ever placed.</div></div>`;
  }
  function render() {
    const v = A.tab === 'dash' ? dash() : A.tab === 'paper' ? paper() : A.tab === 'log' ? log() : settings();
    const keep = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.k;
    if (A.tab === 'settings' && keep && document.activeElement.tagName === 'INPUT' && document.activeElement.type !== 'checkbox') { $('#hdr').innerHTML = header(); return; } // don't rebuild while typing
    $('#hdr').innerHTML = header();
    const sc = $('#view').scrollTop; $('#view').innerHTML = v; $('#view').scrollTop = sc;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === A.tab));
    $('#toast').textContent = A.toast; $('#toast').style.display = A.toast ? 'block' : 'none';
  }

  // ---------- events ----------
  document.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-tab],[data-act]'); if (!t) return;
    if (t.dataset.tab) { A.tab = t.dataset.tab; return render(); }
    const a = t.dataset.act;
    if (a === 'refresh') refresh(true);
    else if (a === 'tog') { A.open[t.dataset.k] = !A.open[t.dataset.k]; render(); }
    else if (a === 'paper') { const r = A.rows[+t.dataset.i], res = QT.Paper.enter(r, { ...S, allowOffHours: true }, A.snap.quotes); toast(res.ok ? `Paper trade ${res.trade.id} opened` : res.msg); }
    else if (a === 'close') {
      const tr = QT.Paper.open().find((x) => x.id === t.dataset.id), ch = A.chains[tr.sym + '|' + tr.expiry] || (A.feed && await A.feed.chain(tr.sym, tr.expiry).catch(() => null));
      if (!ch) return toast('No option prices available to close');
      QT.Paper.close(tr, 'MANUAL', S, ch); toast(`${tr.sym} closed ${inr(tr.pnl)}`);
    }
    else if (a === 'reset') { if (confirm('Reset paper account and clear all trades?')) { QT.Paper.reset(S.capital); render(); } }
    else if (a === 'csv') {
      const c = QT.Paper.closed(), csv = ['id,symbol,strategy,lots,expiry,status,gross,charges,net'].concat(c.map((t) => [t.id, t.sym, t.stratName, t.lots, t.expiry, t.status, t.pnlGross, t.chEntry + t.chExit, t.pnl].join(','))).join('\n');
      try { await navigator.clipboard.writeText(csv); toast('CSV copied'); } catch (e2) { toast('Copy failed'); }
    }
    else if (a === 'showtok') { const i = $('#tok'); i.type = i.type === 'password' ? 'text' : 'password'; }
    else if (a === 'defaults') { if (confirm('Restore all settings (keeps token)?')) { const tk = S.token; S = { ...QT.DEFAULTS, strat: { ...QT.DEFAULTS.strat }, token: tk }; saveS(); render(); } }
    else if (a === 'test') {
      const out = $('#testres'); out.textContent = 'Testing…';
      try { const f = QT.makeFeed({ ...S, mode: 'live' }); const q = await f.quotes(); out.textContent = `OK – Nifty ${q.q.NIFTY}, VIX ${q.vix}, ${Object.keys(q.q).length}/51 quotes`; }
      catch (er) { out.textContent = 'Failed: ' + er.message; }
    }
  });
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (el.dataset.s) { S.strat[el.dataset.s] = el.checked; saveS(); return; }
    const k = el.dataset.k; if (!k) return;
    if (el.type === 'checkbox') S[k] = el.checked;
    else if (el.type === 'number') { let v = parseFloat(el.value); if (isNaN(v)) return; S[k] = el.dataset.t === 'pct' ? v / 100 : v; }
    else S[k] = el.value;
    saveS(); if (k === 'refreshSec') schedule();
    if (k === 'mode' || k === 'token') { A.feed = null; A.snap = null; }
    if (el.tagName === 'SELECT' || el.type === 'checkbox') render();
  });

  QT.app = { S: () => S, A, refresh };
  document.addEventListener('DOMContentLoaded', () => { render(); schedule(); if (S.mode === 'demo' || S.token) refresh(); });
})();

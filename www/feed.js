/* Data feeds: Upstox (live) and Demo (synthetic, offline) */
(function () {
  const QT = (globalThis.QT = globalThis.QT || {});
  const BASE = 'https://api.upstox.com/v2';
  const U = () => QT.UNIVERSE;

  class UpstoxFeed {
    constructor(token) { this.token = (token || '').trim(); this.name = 'LIVE'; }
    get3(path, params) { return this.get(path, params, 'https://api.upstox.com/v3'); }
    async get(path, params, base) {
      const qs = params ? '?' + Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&') : '';
      const r = await fetch((base || BASE) + path + qs, { headers: { Authorization: 'Bearer ' + this.token, Accept: 'application/json' } });
      const txt = await r.text();
      let j; try { j = JSON.parse(txt); } catch (e) { throw new Error('Bad response (' + r.status + ')'); }
      if (!r.ok || j.status === 'error') {
        const m = (j.errors && j.errors[0] && j.errors[0].message) || r.status;
        throw new Error('Upstox: ' + m);
      }
      return j.data;
    }
    async quotes() {
      const keys = ['NSE_INDEX|India VIX', ...Object.values(U()).map((x) => x.key)];
      const data = await this.get('/market-quote/quotes', { instrument_key: keys.join(',') });
      const byTok = {}, out = { q: {}, vix: null };
      Object.values(data).forEach((d) => { if (d.instrument_token) byTok[d.instrument_token] = d; });
      const find = (key) => byTok[key] || data[key.replace('|', ':')] || null;
      for (const [sym, u] of Object.entries(U())) { const d = find(u.key) || data['NSE_EQ:' + sym] || (sym === 'NIFTY' && data['NSE_INDEX:Nifty 50']); if (d && d.last_price) out.q[sym] = d.last_price; }
      const v = find('NSE_INDEX|India VIX') || data['NSE_INDEX:India VIX'];
      out.vix = v ? v.last_price : null;
      return out;
    }
    async candles(sym) {
      const to = QT.istDate(), from = QT.addDays(to, -380);
      const d = await this.get(`/historical-candle/${encodeURIComponent(U()[sym].key)}/day/${to}/${from}`);
      return d.candles; // newest first
    }
    async lotSize(sym) {
      const d = await this.get('/option/contract', { instrument_key: U()[sym].key });
      const c = (d || []).find((x) => x.lot_size > 0); return c ? +c.lot_size : null;
    }
    // last fully CLOSED intraday candle at timeframe tf (minutes) -> {ts, close} or null
    async closed(sym, tf) {
      const d = await this.get3(`/historical-candle/intraday/${encodeURIComponent(U()[sym].key)}/minutes/${tf}`);
      const now = Date.now();
      const done = (d.candles || []).filter((k) => new Date(k[0]).getTime() + tf * 60000 <= now);
      return done.length ? { ts: done[0][0], close: done[0][4], hist: done.slice(0, 8).map((k) => k[4]) } : null;
    }
    async expiries(sym) {
      const d = await this.get('/option/contract', { instrument_key: U()[sym].key });
      return d.map((c) => c.expiry).filter(Boolean).map((e) => String(e).slice(0, 10));
    }
    async chain(sym, expiry) {
      const d = await this.get('/option/chain', { instrument_key: U()[sym].key, expiry_date: expiry });
      const m = new Map();
      const side = (o) => o && { key: o.instrument_key, ltp: o.market_data.ltp || 0, bid: o.market_data.bid_price || 0, ask: o.market_data.ask_price || 0, oi: o.market_data.oi || 0, vol: o.market_data.volume || 0 };
      d.forEach((r) => m.set(r.strike_price, { CE: side(r.call_options), PE: side(r.put_options) }));
      return m;
    }
  }

  // ---------- Demo feed ----------
  function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
  function hash(s) { let h = 7; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }
  class DemoFeed {
    constructor() {
      this.name = 'DEMO'; this.spot = {}; this.vix = QT.DEMO_VIX; this.cdl = {}; this.r = rng(Date.now() & 0xffffff);
      for (const [s, u] of Object.entries(U())) this.spot[s] = u.ltp;
    }
    async quotes() {
      // random walk step per refresh (~0.35% / tick) so demo trades can reach targets/stops
      for (const s of Object.keys(this.spot)) this.spot[s] = Math.round(this.spot[s] * (1 + (this.r() - 0.5) * 0.007) * 20) / 20;
      this.vix = Math.max(11, this.vix + (this.r() - 0.5) * 0.3);
      this.track();
      return { q: { ...this.spot }, vix: this.vix };
    }
    // demo candle builder: wall-clock buckets; the previous bucket's last price is the CLOSED candle
    track() {
      const id = QT.candleId(this.tf || 15); this.bk = this.bk || {};
      for (const s of Object.keys(this.spot)) {
        const b = this.bk[s], u = U()[s];
        if (!b) { const h = []; let p = u.ltp; for (let i = 0; i < 6; i++) { h.push(p); p = p * (1 + (this.r() - 0.5) * 0.004); } this.bk[s] = { id, last: this.spot[s], hist: h, closed: { ts: new Date().toISOString(), close: h[0], hist: h } }; }
        else if (b.id !== id) { b.hist = [b.last, ...b.hist].slice(0, 8); this.bk[s] = { id, last: this.spot[s], hist: b.hist, closed: { ts: new Date().toISOString(), close: b.last, hist: b.hist } }; }
        else b.last = this.spot[s];
      }
    }
    async closed(sym, tf) { this.tf = tf; if (!this.bk) this.track(); return this.bk[sym].closed; }
    async candles(sym) {
      if (this.cdl[sym]) return this.cdl[sym];
      const u = U()[sym], r = rng(hash(sym)), n = 260, out = [];
      let p = u.ltp, drift = (r() - 0.45) * 0.0012;
      const today = QT.istDate();
      for (let i = 0; i < n; i++) {
        const d = QT.addDays(today, -i - 1), dd = new Date(d + 'T00:00:00Z').getUTCDay();
        if (dd === 0 || dd === 6) continue;
        const prev = i === 0 ? u.prev : p;
        const hi = prev * (1 + r() * 0.008), lo = prev * (1 - r() * 0.008);
        out.push([d + 'T00:00:00+05:30', prev, hi, lo, prev, u.vol * (0.7 + r() * 0.6)]);
        p = prev / (1 + drift + (r() - 0.5) * 0.02);
      }
      return (this.cdl[sym] = out);
    }
    async expiries() { return QT.fallbackExpiries(QT.istDate(), this.holidays); }
    async chain(sym, expiry) {
      const spot = this.spot[sym], step = QT.strikeStep(sym, spot), atm = Math.round(spot / step) * step;
      const T = Math.max(QT.daysBetween(QT.istDate(), expiry), 1) / 365, iv = (this.vix / 100) * 1.3, r = rng(hash(sym + expiry));
      const m = new Map(), lot = U()[sym].lot;
      for (let i = -14; i <= 14; i++) {
        const K = atm + i * step, row = {};
        for (const t of ['CE', 'PE']) {
          const mid = Math.max(0.1, QT.bs(t, spot, K, T, 0.065, iv)), sp = Math.max(0.05, mid * (0.01 + r() * 0.025));
          row[t] = { key: `DEMO|${sym}|${expiry}|${K}|${t}`, ltp: mid, bid: Math.max(0.05, mid - sp / 2), ask: mid + sp / 2, oi: Math.round(lot * (200 + r() * 3000)), vol: 1000 };
        }
        m.set(K, row);
      }
      return m;
    }
  }

  // Custom JSON feed: your own adapter server that returns the formats documented in the README
  class CustomFeed {
    constructor(url, headers) { this.base = String(url || '').replace(/\/$/, ''); this.name = 'LIVE'; this.token = this.base; try { this.h = JSON.parse(headers || '{}'); } catch (e) { this.h = {}; } }
    async get(path, params) {
      if (!this.base) throw new Error('Custom feed URL is empty (Settings > Data feed)');
      const qs = params ? '?' + Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&') : '';
      const r = await fetch(this.base + path + qs, { headers: { Accept: 'application/json', ...this.h } });
      if (!r.ok) throw new Error('Custom feed ' + path + ' -> HTTP ' + r.status);
      return r.json();
    }
    async quotes() { const j = await this.get('/quotes'); return { q: j.quotes || {}, vix: j.vix ?? null }; }
    async candles(sym) { return (await this.get('/candles', { symbol: sym, tf: 'day' })).candles; }
    async closed(sym, tf) { const j = await this.get('/closed', { symbol: sym, tf }); return j && j.close ? { ts: j.ts, close: j.close, hist: j.hist || [j.close] } : null; }
    async expiries(sym) { return (await this.get('/expiries', { symbol: sym })).expiries || []; }
    async chain(sym, expiry) {
      const j = await this.get('/chain', { symbol: sym, expiry }), m = new Map();
      (j.rows || []).forEach((r) => m.set(r.strike, { CE: r.CE, PE: r.PE }));
      return m;
    }
  }
  QT.makeFeed = (S) => { const f = S.mode === 'live' ? new UpstoxFeed(S.token) : S.mode === 'custom' ? new CustomFeed(S.feedUrl, S.feedHeaders) : new DemoFeed(); f.holidays = S.holidays; return f; };
})();

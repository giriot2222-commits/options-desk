/* AI tuning: learns from closed paper trades which filters win more, and (optionally) adjusts them. No guarantee of future results. */
(function () {
  const QT = (globalThis.QT = globalThis.QT || {});
  const pct = (x) => (x == null ? '-' : x.toFixed(0) + '%');
  const wr = (a) => (a.length ? (100 * a.filter((t) => t.pnl > 0).length) / a.length : null);

  const O = (QT.Optimizer = {
    tables() {
      const P = QT.Paper, labels = Object.keys(QT.STRATS);
      const nm = (k) => `${k}. ${QT.STRATS[k].name}`;
      const strat = P.group((t) => String(t.strat), labels).map((r) => ({ ...r, k: nm(r.k) }));
      const side = P.group((t) => (t.ctx && t.ctx.side) || t.signal, ['BUY', 'SELL', 'NEUTRAL']);
      const conv = P.group((t) => (t.conviction >= 84 ? '84-100' : t.conviction >= 67 ? '67-83' : '50-66'), ['50-66', '67-83', '84-100']);
      const kind = P.group((t) => (t.net > 0 ? 'Debit (buy options)' : 'Credit (sell spreads)'), ['Debit (buy options)', 'Credit (sell spreads)']);
      const a2 = P.group((t) => (t.ctx && t.ctx.a2 != null ? (t.ctx.a2 >= 2 ? 'Agent 2 score >= +2' : t.ctx.a2 >= 0 ? 'Agent 2 score 0..+1' : 'Agent 2 score < 0') : null), ['Agent 2 score >= +2', 'Agent 2 score 0..+1', 'Agent 2 score < 0']);
      const streak = P.group((t) => (t.ctx ? ((t.ctx.streak || 1) >= 2 ? '2+ candles confirmed' : '1 candle') : null), ['1 candle', '2+ candles confirmed']);
      const exits = P.group((t) => t.status, ['TARGET HIT', 'PROFIT LOCK', 'SL HIT', 'ENTRY REASON GONE', 'EXIT-BY DUE', 'FLAT AT 1/2 TIME', 'MANUAL']);
      return { Strategy: strat, 'Signal side': side, Conviction: conv, 'Trade type': kind, 'Agent 2 score': a2, 'Candle confirmation': streak, 'How trades ended': exits };
    },
    analyze(S) {
      const P = QT.Paper, closed = P.closed(), n = closed.length, recs = [];
      if (n < S.optMinTrades) return { n, recs, ready: false };
      const tgt = S.optTargetWin * 100;
      // 1. switch off strategies that lose
      let left = Object.keys(S.strat).filter((k) => S.strat[k]).length;
      for (const k of Object.keys(S.strat).filter((k) => S.strat[k])) {
        const a = closed.filter((t) => String(t.strat) === k);
        if (a.length >= 8 && wr(a) < 35 && a.reduce((x, t) => x + t.pnl, 0) < 0 && left > 2) { left--; recs.push({ key: 'strat.' + k, to: false, label: `Switch OFF #${k} ${QT.STRATS[k].name}`, reason: `win rate ${pct(wr(a))} over ${a.length} trades, net ${Math.round(a.reduce((x, t) => x + t.pnl, 0))}` }); }
      }
      // 2. minimum conviction
      const cand = [50, 67, 84].map((thr) => { const a = closed.filter((t) => t.conviction >= thr); return { thr, n: a.length, w: wr(a) }; }).filter((c) => c.n >= 8);
      if (cand.length) {
        const ok = cand.find((c) => c.w >= tgt), best = [...cand].sort((a, b) => b.w - a.w)[0], pick = ok || best, cur = cand.find((c) => c.thr === S.minConviction) || cand[0];
        if (pick.thr !== S.minConviction && pick.w - cur.w >= 5) recs.push({ key: 'minConviction', to: pick.thr, label: `Min conviction ${S.minConviction} -> ${pick.thr}`, reason: `trades with conviction >= ${pick.thr}: win rate ${pct(pick.w)} (${pick.n}) vs ${pct(cur.w)} now` });
      }
      // 3. candle confirmation
      const s1 = closed.filter((t) => t.ctx && (t.ctx.streak || 1) < 2), s2 = closed.filter((t) => t.ctx && (t.ctx.streak || 1) >= 2);
      if (s1.length >= 8 && s2.length >= 8) {
        if (wr(s2) - wr(s1) >= 8 && S.confirmN < 2) recs.push({ key: 'confirmN', to: 2, label: 'Require 2 closed candles', reason: `confirmed signals win ${pct(wr(s2))} vs ${pct(wr(s1))}` });
        if (wr(s1) - wr(s2) >= 8 && S.confirmN > 1) recs.push({ key: 'confirmN', to: 1, label: 'Act on the first closed candle', reason: `1-candle signals win ${pct(wr(s1))} vs ${pct(wr(s2))}` });
      }
      // 4. Agent 2 strictness
      const hi = closed.filter((t) => t.ctx && t.ctx.a2 != null && t.ctx.a2 >= 2), lo = closed.filter((t) => t.ctx && t.ctx.a2 != null && t.ctx.a2 < 2);
      if (hi.length >= 8 && lo.length >= 8) {
        if (wr(hi) - wr(lo) >= 10 && S.a2Strict !== 'strict') recs.push({ key: 'a2Strict', to: 'strict', label: 'Agent 2 strictness -> strict', reason: `strong Agent 2 support wins ${pct(wr(hi))} vs ${pct(wr(lo))}` });
        if (wr(lo) >= wr(hi) && S.a2Strict === 'strict') recs.push({ key: 'a2Strict', to: 'normal', label: 'Agent 2 strictness -> normal', reason: `strict filter is not helping (${pct(wr(hi))} vs ${pct(wr(lo))})` });
      }
      return { n, recs, ready: true };
    },
    apply(S, recs) {
      const changes = [];
      recs.forEach((r) => {
        let from;
        if (r.key.startsWith('strat.')) { const k = r.key.slice(6); from = S.strat[k]; if (from === r.to) return; S.strat[k] = r.to; }
        else { from = S[r.key]; if (from === r.to) return; S[r.key] = r.to; }
        changes.push({ key: r.key, from, to: r.to, reason: r.reason, label: r.label });
      });
      if (changes.length) { S.tuneLog = [{ time: new Date().toISOString(), changes }, ...(S.tuneLog || [])].slice(0, 30); S.lastTuneN = QT.Paper.closed().length; }
      return changes;
    },
    revert(S) {
      const last = (S.tuneLog || [])[0]; if (!last) return 0;
      last.changes.forEach((c) => { if (c.key.startsWith('strat.')) S.strat[c.key.slice(6)] = c.from; else S[c.key] = c.from; });
      S.tuneLog = S.tuneLog.slice(1); return last.changes.length;
    },
    autoTune(S) {
      if (!S.autoTune) return [];
      const n = QT.Paper.closed().length;
      if (n < S.optMinTrades || n - (S.lastTuneN || 0) < 5) return [];
      const a = O.analyze(S); if (!a.recs.length) { S.lastTuneN = n; return []; }
      return O.apply(S, a.recs);
    },
  });
})();

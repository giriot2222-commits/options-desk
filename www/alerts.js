/* Alerts: in-app Alert Log + phone notification + Telegram (mirrors the workbook's Alerts / Alert Log sheets) */
(function () {
  const QT = (globalThis.QT = globalThis.QT || {});
  const LS = () => (typeof localStorage !== 'undefined' ? localStorage : { getItem() {}, setItem() {} });
  // Today's run log (what the app did today), cleared automatically each new day
  const R = (QT.Run = {
    log: [], day: '',
    load() { try { const j = JSON.parse(LS().getItem('qt_run')); if (j && j.day === QT.istDate()) { R.log = j.log || []; R.day = j.day; } } catch (e) {} },
    add(msg) { const d = QT.istDate(); if (R.day !== d) { R.day = d; R.log = []; } R.log.unshift({ t: new Date().toISOString(), msg }); if (R.log.length > 200) R.log.pop(); try { LS().setItem('qt_run', JSON.stringify({ day: R.day, log: R.log })); } catch (e) {} },
    clear() { R.log = []; try { LS().setItem('qt_run', JSON.stringify({ day: QT.istDate(), log: [] })); } catch (e) {} },
  });
  const A = (QT.Alerts = {
    log: [], seen: {},
    load() { try { const j = JSON.parse(LS().getItem('qt_alerts')); if (j) { A.log = j.log || []; A.seen = j.seen || {}; } } catch (e) {} },
    save() { try { LS().setItem('qt_alerts', JSON.stringify({ log: A.log.slice(0, 300), seen: A.seen })); } catch (e) {} },
    // type: NEW SIGNAL | PAPER ENTRY | TARGET HIT | SL HIT | EXIT-BY DUE | ENTRY REASON GONE | DATA STALE | ERROR
    async add(S, type, sym, msg, onceKey) {
      if (onceKey) { const k = QT.istDate() + '|' + onceKey; if (A.seen[k]) return; A.seen[k] = 1; }
      const via = ['App log'];
      if (S.notify) {
        const LN = globalThis.Capacitor && globalThis.Capacitor.Plugins && globalThis.Capacitor.Plugins.LocalNotifications;
        if (LN) { try { await LN.schedule({ notifications: [{ id: Math.floor(Math.random() * 2e9), title: `${type} ${sym || ''}`.trim(), body: msg.slice(0, 240), schedule: { at: new Date(Date.now() + 400) } }] }); via.push('Phone'); } catch (e) {} }
      }
      if (S.tgToken && S.tgChat) {
        try { const r = await fetch(`https://api.telegram.org/bot${S.tgToken.trim()}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: S.tgChat.trim(), text: `${type}${sym ? ' | ' + sym : ''}\n${msg}` }) }); if (r.ok) via.push('Telegram'); } catch (e) {}
      }
      A.log.unshift({ time: new Date().toISOString(), type, sym: sym || '', msg, via: via.join(', ') });
      if (A.log.length > 300) A.log.pop();
      A.save();
    },
    async test(S) {
      if (!S.tgToken || !S.tgChat) return 'Add Telegram bot token and chat id first';
      try { const r = await fetch(`https://api.telegram.org/bot${S.tgToken.trim()}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: S.tgChat.trim(), text: 'Options Desk test alert' }) }); return r.ok ? 'Telegram OK - check your phone' : 'Telegram failed (' + r.status + ')'; } catch (e) { return 'Telegram failed: ' + e.message; }
    },
  });
})();

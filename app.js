/* Slowwave UI. Talks to window.Engine (native Android or the browser engine). */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const DEFAULTS = { session: 'night', volume: 35, delayMin: 30, windowMin: 180, pattern: 'rhythm', lull: false, lullVol: 30, blind: false, keepScreen: true,
    alarmOn: false, alarmTime: '09:30', napDelayMin: 10, napMin: 30 };

  function load(k, d) { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v == null ? d : v; } catch (e) { return d; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  const cfg = Object.assign({}, DEFAULTS, load('sw.cfg', {}));
  const isWeb = Engine.kind === 'web';
  let pollTimer = null;

  const fmtClock = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  function fmtDur(ms) {
    ms = Math.max(0, ms);
    const m = Math.round(ms / 60000), h = Math.floor(m / 60), mm = m % 60;
    return h ? `${h}h ${String(mm).padStart(2, '0')}m` : `${m} min`;
  }
  function fmtMin(m) {
    if (m === 0) return 'right away';
    const h = Math.floor(m / 60), mm = m % 60;
    return h ? (mm ? `${h} h ${mm} min` : `${h} h`) : `${m} min`;
  }
  const isNap = c => (c || cfg).session === 'nap';
  // the settings this session really runs with
  function runCfg() { return Object.assign({}, cfg, isNap() ? { blind: false, alarmOn: false } : {}); }
  function toast(msg, ms) {
    const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), ms || 2600);
  }

  /* ---------- setup screen ---------- */
  function setRange(el, v) { el.value = v; el.style.setProperty('--p', ((v - el.min) / (el.max - el.min) * 100) + '%'); }
  function persist() { save('sw.cfg', cfg); renderSetup(); }

  function renderSetup() {
    setRange($('vol'), cfg.volume);
    $('vol-val').textContent = cfg.volume <= 20 ? `${cfg.volume} · whisper` : cfg.volume <= 45 ? `${cfg.volume} · quiet` : cfg.volume <= 70 ? `${cfg.volume} · medium` : `${cfg.volume} · loud`;
    setRange($('lullvol'), cfg.lullVol);
    document.querySelectorAll('input.num').forEach(el => setRange(el, cfg[el.dataset.key]));
    document.querySelectorAll('[data-val]').forEach(el => { el.textContent = fmtMin(cfg[el.dataset.val]); });
    document.body.classList.toggle('mode-nap', isNap());
    $('plan-title').textContent = isNap() ? 'This nap' : 'Tonight';
    $('btn-start').textContent = isNap() ? 'Start nap' : 'Start night';
    setSwitch($('sw-alarm'), cfg.alarmOn);
    $('alarm-field').classList.toggle('hidden', !cfg.alarmOn);
    if ($('alarm-time').value !== cfg.alarmTime) $('alarm-time').value = cfg.alarmTime;
    $('lull-val').textContent = String(cfg.lullVol);
    document.querySelectorAll('.chips').forEach(g => {
      const key = g.dataset.key;
      g.querySelectorAll('button').forEach(b => b.classList.toggle('on', String(cfg[key]) === b.dataset.v));
    });
    $('pattern-hint').textContent = cfg.pattern === 'rhythm'
      ? '5 soft bursts at slow-wave pace (0.8 per second), then 10 s of silence.'
      : '2 soft bursts a second apart, then 13 s of silence. Sparser and gentler.';
    setSwitch($('sw-lull'), cfg.lull);
    $('lull-vol-field').classList.toggle('hidden', !cfg.lull);
    setSwitch($('sw-blind'), cfg.blind);
    setSwitch($('sw-screen'), cfg.keepScreen);
    renderTimeline();
  }
  function setSwitch(el, on) { el.setAttribute('aria-checked', on ? 'true' : 'false'); }

  function renderTimeline() {
    const plan = SW.makePlan(runCfg(), Date.now()), min = ms => Math.max(0, ms) / 60000;
    const delay = min(plan.burstStart - plan.start), burst = min(plan.burstEnd - plan.burstStart);
    const quiet = plan.wakeAt != null ? min(plan.wakeAt - plan.burstEnd) : 120; // no alarm: 2 h of "quiet", just for scale
    const total = Math.max(1, delay + burst + quiet);
    $('seg-delay').style.flex = delay / total; $('seg-delay').classList.toggle('hidden', delay === 0);
    $('seg-burst').style.flex = burst / total; $('seg-burst').classList.toggle('hidden', burst === 0);
    $('seg-quiet').style.flex = quiet / total; $('seg-quiet').classList.toggle('hidden', quiet === 0);
    $('seg-wake').classList.toggle('hidden', plan.wakeAt == null);
    const bursts = burst ? `bursts <b>${fmtClock(plan.burstStart)}</b> → <b>${fmtClock(plan.burstEnd)}</b>` : 'no bursts (too short)';
    const tail = plan.wakeAt != null ? `alarm <b>${fmtClock(plan.wakeAt)}</b>` : 'then silent';
    $('times').innerHTML = `<span>Start now</span><span>${bursts}</span><span>${tail}</span>`;
  }

  function bindSetup() {
    $('vol').addEventListener('input', e => { cfg.volume = +e.target.value; persist(); });
    $('lullvol').addEventListener('input', e => { cfg.lullVol = +e.target.value; persist(); });
    document.querySelectorAll('input.num').forEach(el => el.addEventListener('input', () => { cfg[el.dataset.key] = +el.value; persist(); }));
    $('sw-alarm').addEventListener('click', () => { cfg.alarmOn = !cfg.alarmOn; persist(); });
    $('alarm-time').addEventListener('change', e => { if (/^\d{1,2}:\d{2}$/.test(e.target.value)) { cfg.alarmTime = e.target.value; persist(); } });
    document.querySelectorAll('.chips').forEach(g => g.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      const v = b.dataset.v; cfg[g.dataset.key] = isNaN(+v) ? v : +v; persist();
    }));
    $('sw-lull').addEventListener('click', () => { cfg.lull = !cfg.lull; persist(); });
    $('sw-blind').addEventListener('click', () => { cfg.blind = !cfg.blind; persist(); });
    $('sw-screen').addEventListener('click', () => { cfg.keepScreen = !cfg.keepScreen; persist(); });
    $('btn-test').addEventListener('click', () => {
      const r = Engine.test(cfg);
      if (r && r.ok) animatePips(r.bursts, r.intervalMs);
    });
    $('btn-start').addEventListener('click', startNight);
    $('btn-about').addEventListener('click', () => openSheet('sheet-about'));
    $('btn-log').addEventListener('click', () => { renderLog(); openSheet('sheet-log'); });
    $('scrim').addEventListener('click', closeSheets);
    document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeSheets));
    setInterval(() => { if (!$('setup').classList.contains('hidden')) renderTimeline(); }, 30000);
  }

  function animatePips(n, interval) {
    const box = $('pips');
    for (let k = 0; k < n; k++) setTimeout(() => {
      const d = document.createElement('div'); d.className = 'pip';
      d.style.left = (20 + k * (60 / Math.max(1, n - 1))) + '%';
      box.appendChild(d); setTimeout(() => d.remove(), 1300);
    }, k * interval + 80);
  }

  /* ---------- sheets ---------- */
  function openSheet(id) { $('scrim').classList.remove('hidden'); $(id).classList.remove('hidden'); }
  function closeSheets() {
    let closed = false;
    document.querySelectorAll('.sheet').forEach(s => { if (!s.classList.contains('hidden')) closed = true; s.classList.add('hidden'); });
    $('scrim').classList.add('hidden');
    return closed;
  }
  // Android back button: close the top sheet; return true if handled.
  window.onBack = function () { return closeSheets(); };

  /* ---------- night ---------- */
  function startNight() {
    const r = Engine.start(runCfg());
    if (!r || !r.ok) { toast((r && r.error) || 'Could not start'); return; }
    showNight();
  }
  function showNight() {
    $('setup').classList.add('hidden'); $('night').classList.remove('hidden');
    document.documentElement.style.background = '#000';
    tick(); clearInterval(pollTimer); pollTimer = setInterval(tick, 1000);
  }
  function showSetup() {
    clearInterval(pollTimer); pollTimer = null;
    $('night').classList.add('hidden'); $('setup').classList.remove('hidden');
    document.documentElement.style.background = '';
    renderMorning(); renderSetup();
  }
  function tick() {
    const s = Engine.status();
    if (!s || s.state === 'idle') { showSetup(); if (s && s.interrupted) toast('It was interrupted (the app was closed).', 4000); return; }
    const now = Date.now(), p = s.plan, wake = p.wakeAt != null, pct = (a, b) => Math.min(100, Math.max(0, (now - a) / Math.max(1, b - a) * 100)) + '%';
    const alarmTxt = wake ? ` Alarm at ${fmtClock(p.wakeAt)}.` : '';
    const ringing = s.state === 'waking';
    $('night').classList.toggle('waking', ringing);
    $('hold-label').textContent = ringing ? 'Hold to stop the alarm' : 'Hold to stop';
    if (ringing) {
      $('n-phase').textContent = 'Wake up';
      $('n-big').textContent = fmtClock(now);
      $('n-sub').textContent = isNap(s.cfg) ? 'Nap done. Hold the button to stop the alarm.' : 'Good morning. Hold the button to stop the alarm.';
      $('n-bar').style.width = '100%';
      $('n-stats').textContent = '';
    } else if (s.state === 'waiting') {
      $('n-phase').textContent = isNap(s.cfg) ? 'Nap · falling asleep' : 'Falling asleep';
      $('n-big').textContent = fmtDur(p.burstStart - now);
      $('n-sub').textContent = (p.burstEnd > p.burstStart ? `Soft bursts start at ${fmtClock(p.burstStart)}.` : 'No bursts this time.') + (wake ? alarmTxt : ' Nothing to do, just sleep.');
      $('n-bar').style.width = pct(p.start, wake ? p.wakeAt : p.burstStart);
      $('n-stats').textContent = s.cfg.lull ? 'pink noise on, fades out before the bursts' : '';
    } else if (s.state === 'bursting') {
      $('n-phase').textContent = isNap(s.cfg) ? 'Nap · bursting' : 'Bursting';
      $('n-big').textContent = fmtClock(wake ? p.wakeAt : p.burstEnd);
      $('n-sub').textContent = wake ? `Bursts until ${fmtClock(p.burstEnd)}.${alarmTxt}` : `Stops by itself at ${fmtClock(p.burstEnd)}, then everything stays silent.`;
      $('n-bar').style.width = wake ? pct(p.start, p.wakeAt) : pct(p.burstStart, p.burstEnd);
      $('n-stats').textContent = s.cfg.blind ? 'blind test: you find out in the morning' : `${s.blocks || 0} groups played`;
    } else { // quiet: bursts done, waiting for the alarm
      $('n-phase').textContent = isNap(s.cfg) ? 'Nap · quiet' : 'Quiet';
      $('n-big').textContent = fmtClock(p.wakeAt);
      $('n-sub').textContent = `No more bursts.${alarmTxt}`;
      $('n-bar').style.width = pct(p.start, p.wakeAt);
      $('n-stats').textContent = s.cfg.blind ? '' : `${s.blocks || 0} groups played`;
    }
    const w = $('n-warn');
    if (s.pausedAt) { w.textContent = `The ${isWeb ? 'browser' : 'phone'} paused the sound at about ${fmtClock(s.pausedAt)}. Keep the screen on next time.`; w.classList.remove('hidden'); }
    else w.classList.add('hidden');
  }

  function bindHold() {
    const b = $('btn-stop'); let t = null;
    const start = e => { e.preventDefault(); b.classList.add('holding'); $('n-warn').classList.add('hidden');
      t = setTimeout(() => { b.classList.remove('holding'); const ringing = $('night').classList.contains('waking'); Engine.stop(); showSetup(); toast(ringing ? 'Alarm off. Morning!' : 'Stopped'); }, 1200); };
    const cancel = () => { clearTimeout(t); b.classList.remove('holding'); };
    b.addEventListener('pointerdown', start);
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => b.addEventListener(ev, cancel));
    b.addEventListener('contextmenu', e => e.preventDefault());
  }

  /* ---------- morning + log ---------- */
  let rating = 0;
  function renderMorning() {
    const last = Engine.peekLastSession();
    const card = $('morning');
    if (!last) { card.classList.add('hidden'); return; }
    const mins = Math.round((last.end - last.start) / 60000);
    $('morning-title').textContent = isNap(last.cfg) ? 'Last nap' : 'Last night';
    let txt = `${fmtClock(last.start)} → ${fmtClock(last.end)} (${fmtDur(last.end - last.start)})`;
    if (last.endedBy === 'stopped') txt += ', stopped by you';
    if (last.endedBy === 'woke') txt += ', woke up with the alarm';
    if (last.endedBy === 'interrupted') txt += ', interrupted';
    if (!last.cfg.blind) txt += last.blocks ? `, ${last.blocks} groups of bursts.` : ', ended before the bursts started.';
    else txt += '. Blind test: rate first, then you see if it was real.';
    if (last.audioPaused) txt += ` Sound was paused by the device at ${fmtClock(last.audioPaused)}.`;
    if (mins < 1) txt = 'Very short session.';
    $('morning-summary').textContent = txt;
    rating = 0; $('morning-save').disabled = true; $('morning-note').value = '';
    $('rate').querySelectorAll('button').forEach(b => b.classList.remove('on'));
    card.classList.remove('hidden');
  }
  function bindMorning() {
    $('rate').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      rating = +b.dataset.r;
      $('rate').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      $('morning-save').disabled = false;
    });
    const finish = rated => {
      const last = Engine.takeLastSession(); if (!last) return;
      const log = load('sw.log', []);
      log.unshift({ start: last.start, end: last.end, endedBy: last.endedBy, rating: rated ? rating : null,
        note: rated ? $('morning-note').value.trim() : '', blind: !!last.cfg.blind, sham: !!last.sham,
        blocks: last.blocks || 0, volume: last.cfg.volume, pattern: last.cfg.pattern, paused: last.audioPaused || null, nap: isNap(last.cfg) });
      save('sw.log', log.slice(0, 400));
      $('morning').classList.add('hidden');
      if (last.cfg.blind) toast(last.sham ? 'Reveal: last night was the silent (fake) one.' : 'Reveal: last night had real bursts.', 4500);
      else if (rated) toast('Saved');
    };
    $('morning-save').addEventListener('click', () => finish(true));
    $('morning-skip').addEventListener('click', () => finish(false));
  }
  function renderLog() {
    const log = load('sw.log', []);
    const list = $('log-list'); list.innerHTML = '';
    if (!log.length) { $('log-summary').textContent = 'No nights yet. Rate the morning after a night and it shows up here.'; return; }
    const avg = a => a.length ? (a.reduce((s, x) => s + x, 0) / a.length).toFixed(1) : '–';
    const nights = log.filter(n => !n.nap);
    const real = nights.filter(n => n.rating && !n.sham && n.blocks > 0).map(n => n.rating);
    const fake = nights.filter(n => n.rating && n.blind && n.sham).map(n => n.rating);
    $('log-summary').textContent = fake.length
      ? `Average sleep rating: real nights ${avg(real)} (${real.length}), silent nights ${avg(fake)} (${fake.length}). Needs many nights before it means anything.`
      : `Average sleep rating with bursts: ${avg(real)} over ${real.length} night(s).`;
    log.forEach(n => {
      const li = document.createElement('li');
      const d = new Date(n.start).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
      const kind = (n.nap ? 'nap · ' : '') + (n.blind ? (n.sham ? 'blind · silent' : 'blind · real') : (n.blocks ? `${n.blocks} groups` : 'no bursts'));
      li.innerHTML = `<span class="d"></span><span class="r"></span><span class="m"></span>`;
      li.children[0].textContent = d;
      li.children[1].textContent = n.rating ? `${n.rating}/5` : '–';
      li.children[2].textContent = `${kind} · vol ${n.volume} · ${n.pattern}${n.note ? ' · ' + n.note : ''}`;
      list.appendChild(li);
    });
  }

  /* ---------- boot ---------- */
  if (isWeb) {
    $('screen-row').classList.remove('hidden');
    if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  bindSetup(); bindHold(); bindMorning();
  const s0 = Engine.status();
  const live = s => s && s.state && s.state !== 'idle';
  if (live(s0)) showNight();
  else { renderSetup(); renderMorning(); if (s0 && s0.interrupted) toast('Last night was interrupted (the app was closed).', 4000); }
  function refresh() {
    if (pollTimer) { tick(); return; }
    const s = Engine.status();
    if (live(s)) showNight(); else renderMorning();
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
  window.addEventListener('sw-resume', refresh);
  window.__sw = { cfg, renderSetup, runCfg }; // for tests
})();

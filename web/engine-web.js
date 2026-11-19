/* Slowwave sound engine shared definitions + the browser (PWA / iPad) engine.
 * On Android the native engine (SleepService.java) does the same thing with AudioTrack;
 * keep PATTERNS and the volume curve in sync with Engine.java. */
(function () {
  'use strict';

  const PATTERNS = {
    // groups of 5 bursts at 0.8 Hz (slow-oscillation pace), then a rest
    rhythm: { bursts: 5, intervalMs: 1250, restMs: 10000 },
    // two bursts 1 s apart, then a longer rest (sparser, closer to closed-loop studies)
    pairs: { bursts: 2, intervalMs: 1000, restMs: 13000 },
  };
  const BURST_MS = 50;
  const RAMP_MS = 5;

  function periodMs(p) { return p.bursts * p.intervalMs + p.restMs; }
  // slider 1..100 -> peak level in dBFS. 35 -> about -47 dBFS (very quiet), 100 -> -12 dBFS.
  function burstGain(v) { return Math.pow(10, (-66 + 0.54 * v) / 20); }
  function hissGain(v) { return Math.pow(10, (-72 + 0.5 * v) / 20); }

  // Next time the clock shows hh:mm, at least a minute after t0.
  function nextClock(t0, hhmm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '')) || [0, 9, 30];
    const d = new Date(t0); d.setHours(+m[1], +m[2], 0, 0);
    if (d.getTime() <= t0 + 60000) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  const ALARM_MIN = 5;          // the alarm rings for up to 5 minutes, then gives up
  const NIGHT_QUIET_MS = 10 * 60000; // bursts stop at least 10 min before a night alarm
  // Plan of one session. Night: bursts in a window after the fall-asleep delay, optional alarm at a
  // clock time. Nap: bursts during the nap, alarm when the nap length is up.
  function makePlan(cfg, t0) {
    const nap = cfg.session === 'nap';
    let burstStart = t0 + (nap ? (cfg.napDelayMin != null ? cfg.napDelayMin : 10) : cfg.delayMin) * 60000;
    let burstEnd, wakeAt = null;
    if (nap) {
      const len = (cfg.napMin || 30) * 60000;
      wakeAt = burstStart + len;
      burstEnd = wakeAt - Math.min(5 * 60000, len / 6);
    } else {
      burstEnd = burstStart + cfg.windowMin * 60000;
      if (cfg.alarmOn) { wakeAt = nextClock(t0, cfg.alarmTime); burstEnd = Math.min(burstEnd, wakeAt - NIGHT_QUIET_MS); }
    }
    if (wakeAt != null && burstStart > wakeAt) burstStart = wakeAt;
    burstEnd = Math.max(burstStart, burstEnd);
    const end = wakeAt != null ? wakeAt + (cfg.alarmMin || ALARM_MIN) * 60000 : burstEnd;
    return { start: t0, burstStart, burstEnd, wakeAt, end };
  }
  function stateAt(plan, t) {
    if (plan.end == null) plan.end = plan.burstEnd; // session started by 0.1.0
    if (t >= plan.end) return 'idle';
    if (plan.wakeAt != null && t >= plan.wakeAt) return 'waking';
    if (t < plan.burstStart) return 'waiting';
    if (t < plan.burstEnd) return 'bursting';
    return 'quiet';
  }
  function blocksUntil(plan, cfg, t) {
    const p = PATTERNS[cfg.pattern] || PATTERNS.rhythm;
    const upto = Math.min(t, plan.burstEnd) - plan.burstStart;
    if (upto <= 0) return 0;
    return Math.ceil(upto / periodMs(p));
  }

  // Pink noise, Paul Kellet's refined filter (-3 dB/octave), output roughly in [-1, 1].
  function pinkSource() {
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    return function () {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520; b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.0168980;
      const out = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
      b6 = w * 0.115926;
      return out * 0.11;
    };
  }
  // One 50 ms burst with 5 ms raised-cosine ramps, peak-normalised to 1.
  function renderBurst(rate) {
    const n = Math.round(rate * BURST_MS / 1000), ramp = Math.round(rate * RAMP_MS / 1000);
    const pink = pinkSource(), out = new Float32Array(n);
    for (let i = 0; i < 200; i++) pink(); // let the filter settle
    let peak = 1e-9;
    for (let i = 0; i < n; i++) { out[i] = pink(); peak = Math.max(peak, Math.abs(out[i])); }
    for (let i = 0; i < n; i++) {
      let g = 1 / peak;
      if (i < ramp) g *= 0.5 - 0.5 * Math.cos(Math.PI * i / ramp);
      else if (i >= n - ramp) g *= 0.5 - 0.5 * Math.cos(Math.PI * (n - 1 - i) / ramp);
      out[i] *= g;
    }
    return out;
  }

  // Alarm: a soft rising four-note chime every 4 s, getting louder over 90 s (-32 to -10 dBFS).
  const CHIME_PERIOD_MS = 4000;
  function alarmGain(elapsedMs) { return Math.pow(10, (-32 + 22 * Math.min(1, elapsedMs / 90000)) / 20); }
  function renderChime(rate) {
    const notes = [[523.25, 0], [659.25, 0.28], [783.99, 0.56], [1046.5, 0.84]];
    const n = Math.round(rate * 2.8), out = new Float32Array(n);
    notes.forEach(([f, at]) => {
      for (let i = Math.round(at * rate); i < n; i++) {
        const t = i / rate - at, env = t < 0.008 ? t / 0.008 : Math.exp(-(t - 0.008) / 0.5);
        out[i] += env * (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(4 * Math.PI * f * t));
      }
    });
    let peak = 1e-9; for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
    for (let i = 0; i < n; i++) out[i] /= peak;
    const fade = Math.round(rate * 0.05); for (let i = 0; i < fade; i++) out[n - 1 - i] *= i / fade;
    return out;
  }

  window.SW = { PATTERNS, BURST_MS, ALARM_MIN, CHIME_PERIOD_MS, periodMs, burstGain, hissGain, alarmGain, nextClock, makePlan, stateAt, blocksUntil, renderBurst, renderChime, pinkSource };

  /* ---------- browser engine ----------
   * Everything for the night is scheduled up front on the AudioContext clock, so nothing in
   * JS has to run while the screen is locked. If the OS suspends the AudioContext anyway,
   * the clock stops; we compare it with the wall clock to tell the user. */
  const KEY = 'sw.webSession', LAST = 'sw.lastSession';
  let ctx = null, nodes = [], beat = null, wakeLock = null, keepOn = false, silentEl = null;

  function store(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function load(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }

  function ensureCtx() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC();
    }
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) {}
    if (ctx.state !== 'running') ctx.resume();
    return ctx;
  }
  function buffersFor(c) {
    const bufs = [];
    for (let k = 0; k < 8; k++) {
      const data = renderBurst(c.sampleRate);
      const b = c.createBuffer(1, data.length, c.sampleRate);
      b.getChannelData(0).set(data);
      bufs.push(b);
    }
    return bufs;
  }
  function hissBuffer(c) {
    const n = c.sampleRate * 4, pink = pinkSource(), b = c.createBuffer(1, n, c.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = pink();
    // crossfade the loop seam
    const f = Math.round(c.sampleRate * 0.05);
    for (let i = 0; i < f; i++) { const g = i / f; d[i] = d[i] * g + d[n - f + i] * (1 - g); }
    return b;
  }
  function scheduleBlock(c, bufs, at, gain, p, out) {
    for (let k = 0; k < p.bursts; k++) {
      const s = c.createBufferSource();
      s.buffer = bufs[(Math.random() * bufs.length) | 0];
      s.connect(out);
      s.start(at + k * p.intervalMs / 1000);
      nodes.push(s);
    }
  }
  // iOS keeps a page's audio session alive more reliably while a media element is playing.
  function startSilentKeepAlive() {
    try {
      if (!silentEl) {
        const rate = 8000, n = rate, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
        const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
        w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
        v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
        v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
        w(36, 'data'); v.setUint32(40, n * 2, true);
        silentEl = new Audio(URL.createObjectURL(new Blob([buf], { type: 'audio/wav' })));
        silentEl.loop = true; silentEl.setAttribute('playsinline', '');
      }
      silentEl.play().catch(() => {});
    } catch (e) {}
  }
  async function lockScreen(on) {
    keepOn = on;
    try {
      if (on && 'wakeLock' in navigator) { wakeLock = await navigator.wakeLock.request('screen'); }
      else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch (e) {}
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && keepOn && load(KEY)) lockScreen(true);
  });

  function finish(sess, endedBy, at) {
    const last = {
      start: sess.plan.start, end: at, endedBy, cfg: sess.cfg, sham: sess.sham,
      plan: sess.plan, blocks: sess.sham ? 0 : SW.blocksUntil(sess.plan, sess.cfg, at),
      audioPaused: sess.pausedAt || null, platform: 'web',
    };
    store(LAST, last);
    store(KEY, null);
  }
  function teardown() {
    nodes.forEach(n => { try { n.stop(); } catch (e) {} try { n.disconnect(); } catch (e) {} });
    nodes = [];
    clearInterval(beat); beat = null;
    if (silentEl) try { silentEl.pause(); } catch (e) {}
    lockScreen(false);
  }

  const WebEngine = {
    kind: 'web',
    start(cfg) {
      const c = ensureCtx();
      teardown();
      const t0 = Date.now(), plan = makePlan(cfg, t0);
      const sham = cfg.blind && cfg.session !== 'nap' ? Math.random() < 0.5 : false;
      const p = PATTERNS[cfg.pattern] || PATTERNS.rhythm;
      const c0 = c.currentTime + 0.1;
      const toCtx = ms => c0 + (ms - t0) / 1000;

      if (cfg.lull) {
        const g = c.createGain(), src = c.createBufferSource();
        src.buffer = hissBuffer(c); src.loop = true;
        const hissEnd = Math.max(c0 + 1, toCtx(plan.burstStart));
        const fadeStart = Math.max(c0, hissEnd - 120), top = Math.min(c0 + 3, fadeStart);
        g.gain.setValueAtTime(0, c0);
        g.gain.linearRampToValueAtTime(hissGain(cfg.lullVol), top);
        g.gain.setValueAtTime(hissGain(cfg.lullVol), fadeStart);
        g.gain.linearRampToValueAtTime(0, hissEnd);
        src.connect(g).connect(c.destination);
        src.start(c0); src.stop(hissEnd + 1);
        nodes.push(src);
      }
      if (!sham) {
        const out = c.createGain();
        out.gain.value = burstGain(cfg.volume);
        out.connect(c.destination);
        const bufs = buffersFor(c), per = periodMs(p);
        for (let t = plan.burstStart; t < plan.burstEnd; t += per) scheduleBlock(c, bufs, toCtx(t), 1, p, out);
      }
      if (plan.wakeAt != null) {
        const data = renderChime(c.sampleRate);
        const cb = c.createBuffer(1, data.length, c.sampleRate); cb.getChannelData(0).set(data);
        for (let t = plan.wakeAt; t < plan.end; t += CHIME_PERIOD_MS) {
          const g = c.createGain(), s = c.createBufferSource();
          g.gain.value = alarmGain(t - plan.wakeAt);
          s.buffer = cb; s.connect(g).connect(c.destination); s.start(toCtx(t));
          nodes.push(s);
        }
      }
      startSilentKeepAlive();
      if (cfg.keepScreen) lockScreen(true);
      const sess = { cfg, plan, sham, ctxStart: c0, wallStart: t0 };
      store(KEY, sess);
      beat = setInterval(() => WebEngine.status(), 15000);
      return { ok: true, plan };
    },
    stop() {
      const sess = load(KEY);
      teardown();
      if (sess) finish(sess, stateAt(sess.plan, Date.now()) === 'waking' ? 'woke' : 'stopped', Date.now());
    },
    status() {
      const sess = load(KEY);
      if (!sess) return { state: 'idle' };
      const now = Date.now();
      if (sess.plan.end == null) sess.plan.end = sess.plan.burstEnd;
      if (!ctx || !nodes.length && !sess.sham) {
        // page was reloaded / killed: the scheduled sound is gone
        if (now < sess.plan.end) { sess.pausedAt = sess.pausedAt || now; }
        store(KEY, sess); teardown(); finish(sess, 'interrupted', now);
        return { state: 'idle', interrupted: true };
      }
      // audio clock vs wall clock: if the context was suspended, it falls behind
      const audioElapsed = (ctx.currentTime - sess.ctxStart) * 1000, wallElapsed = now - sess.wallStart;
      if (!sess.pausedAt && wallElapsed - audioElapsed > 20000) {
        sess.pausedAt = sess.wallStart + audioElapsed; store(KEY, sess);
      }
      const state = stateAt(sess.plan, now);
      if (state === 'idle') { teardown(); finish(sess, 'done', sess.plan.end); return { state: 'idle', justFinished: true }; }
      return { state, plan: sess.plan, cfg: sess.cfg, blocks: sess.sham ? null : blocksUntil(sess.plan, sess.cfg, now), pausedAt: sess.pausedAt || null };
    },
    test(cfg) {
      const c = ensureCtx(), p = PATTERNS[cfg.pattern] || PATTERNS.rhythm;
      const out = c.createGain(); out.gain.value = burstGain(cfg.volume); out.connect(c.destination);
      const bufs = buffersFor(c), at = c.currentTime + 0.08;
      for (let k = 0; k < p.bursts; k++) {
        const s = c.createBufferSource(); s.buffer = bufs[k % bufs.length]; s.connect(out); s.start(at + k * p.intervalMs / 1000);
      }
      return { ok: true, bursts: p.bursts, intervalMs: p.intervalMs };
    },
    takeLastSession() { const l = load(LAST); store(LAST, null); return l; },
    peekLastSession() { return load(LAST); },
    keepScreenOn(on) { lockScreen(on); },
  };

  /* ---------- Android native engine wrapper ---------- */
  const N = window.SlowwaveNative;
  const NativeEngine = N && {
    kind: 'android',
    start(cfg) { return JSON.parse(N.start(JSON.stringify(cfg))); },
    stop() { N.stop(); },
    status() { return JSON.parse(N.status()); },
    test(cfg) { return JSON.parse(N.test(JSON.stringify(cfg))); },
    takeLastSession() { const s = N.takeLastSession(); return s ? JSON.parse(s) : null; },
    peekLastSession() { const s = N.peekLastSession(); return s ? JSON.parse(s) : null; },
    keepScreenOn(on) { N.keepScreenOn(!!on); },
    version() { return N.version(); },
  };

  window.Engine = NativeEngine || WebEngine;
})();

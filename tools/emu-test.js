// Drives the debug APK on a running emulator over CDP and checks a short real night.
// Usage: node tools/emu-test.js [outdir]   (debug APK installed and running, adb on PATH)
const { execSync } = require('child_process');
const fs = require('fs');
const out = process.argv[2] || '/tmp/sw-emu';
fs.mkdirSync(out, { recursive: true });
const adb = c => execSync('adb ' + c, { encoding: 'utf8', timeout: 120000 }).trim();
let fails = 0;
const check = (name, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!ok) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shot = name => { try { execSync(`adb exec-out screencap -p > ${out}/${name}.png`, { timeout: 120000, shell: '/bin/bash' }); } catch (e) { console.log('screenshot failed: ' + name); } };

// Minimal CDP client: the emulator's old WebView can't take Playwright's connectOverCDP.
async function cdpPage(port) {
  const list = await (await fetch(`http://localhost:${port}/json`)).json();
  const target = list.find(t => t.type === 'page');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map(), errs = [];
  ws.onmessage = m => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
    if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception ? d.params.exceptionDetails.exception.description : d.params.exceptionDetails.text);
  };
  const send = (method, params) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable', {});
  return {
    errs,
    async evaluate(fn, arg) {
      const expr = `(${fn.toString()})(${arg === undefined ? '' : JSON.stringify(arg)})`;
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.result && r.result.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300));
      return r.result && r.result.result ? r.result.result.value : undefined;
    },
    async reload() { await send('Page.reload', {}); },
    close() { ws.close(); },
  };
}

async function waitReady(p) {
  for (let i = 0; i < 60; i++) { try { if (await p.evaluate(() => document.readyState === 'complete' && !!window.__sw)) return; } catch (e) {} await sleep(1000); }
}

(async () => {
  const pid = adb('shell pidof com.mildsolvent.slowwave');
  adb(`forward tcp:9222 localabstract:webview_devtools_remote_${pid}`);
  const p = await cdpPage(9222);
  const errs = p.errs;
  check('native engine in APK', await p.evaluate(() => Engine.kind === 'android'));
  check('version reported', await p.evaluate(() => Engine.version()) === '0.2.0');
  check('setup screen visible', await p.evaluate(() => !document.getElementById('setup').classList.contains('hidden')));
  check('keep-screen row hidden on Android', await p.evaluate(() => document.getElementById('screen-row').classList.contains('hidden')));
  const w = await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  check('no horizontal overflow', w);
  shot('01-setup');

  const t = await p.evaluate(() => Engine.test(__sw.cfg));
  check('Test button plays a block', t.ok === true && t.bursts >= 2, JSON.stringify(t));

  // short night: 6 s fall-asleep with hiss, then 40 s of bursts (rhythm = 16.25 s period -> 3 groups)
  const cfg = await p.evaluate(() => Object.assign({}, __sw.cfg, { delayMin: 0.75, windowMin: 40 / 60, pattern: 'rhythm', lull: true, blind: false }));
  const r = await p.evaluate(c => { const r = Engine.start(c); window.__swShow && window.__swShow(); return r; }, cfg);
  check('night starts', r.ok === true, JSON.stringify(r));
  await p.reload();
  p.close(); await sleep(4000); Object.assign(p, await cdpPage(9222)); await waitReady(p);
  let s = await p.evaluate(() => Engine.status());
  check('state waiting first', s.state === 'waiting', s.state);
  check('night screen shown after reload', await p.evaluate(() => !document.getElementById('night').classList.contains('hidden')));
  const svc = adb('shell dumpsys activity services com.mildsolvent.slowwave');
  check('foreground service running', /SleepService/.test(svc) && /isForeground=true/.test(svc));
  shot('02-night-waiting');
  while (Date.now() < r.plan.burstStart + 3000) await sleep(1000);
  s = await p.evaluate(() => Engine.status());
  check('state bursting after delay', s.state === 'bursting', s.state);

  // screen off for 25 s: the service must keep playing
  adb('shell input keyevent 26');
  await sleep(12000);
  const af = adb('shell dumpsys media.audio_flinger');
  adb('shell input keyevent 26'); await sleep(1500); adb('shell input keyevent 82');
  s = await p.evaluate(() => Engine.status());
  check('still bursting with screen off', s.state === 'bursting' || s.state === 'idle', s.state + ' blocks=' + s.blocks);
  check('audio track active in audio_flinger', /com\.mildsolvent\.slowwave|Output thread/.test(af));
  while (Date.now() < r.plan.burstEnd + 4000) await sleep(1000);
  s = await p.evaluate(() => Engine.status());
  check('night stops by itself', s.state === 'idle', s.state);
  const last = await p.evaluate(() => Engine.peekLastSession());
  check('morning summary: done', last && last.endedBy === 'done', last && last.endedBy);
  check('3 groups played', last && last.blocks === 3, last && String(last.blocks));
  const svc2 = adb('shell dumpsys activity services com.mildsolvent.slowwave');
  check('service gone after night', !/SleepService/.test(svc2));
  await sleep(1500);
  check('morning card visible', await p.evaluate(() => !document.getElementById('morning').classList.contains('hidden')));
  shot('03-morning');

  // stop mid-night via the hold button
  await p.evaluate(c => Engine.start(Object.assign({}, c, { delayMin: 30, windowMin: 180, lull: false })), cfg);
  await p.reload();
  p.close(); await sleep(3000); Object.assign(p, await cdpPage(9222)); await waitReady(p);
  await p.evaluate(() => { const b = document.getElementById('btn-stop'); b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); setTimeout(() => b.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })), 200); });
  await sleep(1800);
  check('tap does not stop', (await p.evaluate(() => Engine.status())).state === 'waiting');
  await p.evaluate(() => { const b = document.getElementById('btn-stop'); b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); });
  await sleep(2000);
  s = await p.evaluate(() => Engine.status());
  check('hold stops', s.state === 'idle', s.state);
  const last2 = await p.evaluate(() => Engine.peekLastSession());
  check('stopped recorded', last2 && last2.endedBy === 'stopped');
  await p.evaluate(() => { document.getElementById('morning-skip').click(); });

  // nap with alarm: 6 s to fall asleep, 72 s nap (bursts 60 s, quiet 12 s), alarm rings up to 30 s
  const nc = Object.assign({}, cfg, { session: 'nap', napDelayMin: 0.1, napMin: 1.2, alarmMin: 0.5, lull: false, blind: false, pattern: 'rhythm' });
  const nr = await p.evaluate(c => Engine.start(c), nc);
  check('nap starts', nr.ok === true, JSON.stringify(nr));
  check('nap plan: alarm 72 s after bursts start', nr.plan.wakeAt - nr.plan.burstStart === 72000 && nr.plan.wakeAt - nr.plan.burstEnd === 12000, JSON.stringify(nr.plan));
  const pendingAlarms = () => adb('shell dumpsys alarm').split('Pending user blocked background alarms')[0]; // skip the history of fired alarms
  const alarms = pendingAlarms();
  check('real alarm clock scheduled', /com\.mildsolvent\.slowwave/.test(alarms) && /slowwave\.WAKE/.test(alarms));
  adb('shell input keyevent 26'); // screen off for the whole nap
  while (Date.now() < nr.plan.burstEnd + 3000) await sleep(1000);
  s = await p.evaluate(() => Engine.status());
  check('quiet after the nap bursts', s.state === 'quiet', s.state + ' blocks=' + s.blocks);
  check('nap played bursts', s.blocks >= 3, String(s.blocks));
  while (Date.now() < nr.plan.wakeAt + 5000) await sleep(1000);
  s = await p.evaluate(() => Engine.status());
  check('alarm rings with the screen off', s.state === 'waking', s.state);
  const au = adb('shell dumpsys audio');
  check('alarm plays on the alarm stream', /USAGE_ALARM/.test(au.split('players:')[1] || au));
  await sleep(1500);
  check('alarm turns the screen on', /mWakefulness=Awake/.test(adb('shell dumpsys power')));
  check('app shows over the lock screen while ringing', /mResumedActivity.*slowwave|topResumedActivity.*slowwave/.test(adb('shell dumpsys activity activities')));
  shot('04-alarm-ringing');
  await p.evaluate(() => Engine.stop());
  await sleep(1500);
  const ln = await p.evaluate(() => Engine.peekLastSession());
  check('stopping the alarm records woke', ln && ln.endedBy === 'woke', ln && ln.endedBy);
  check('alarm clock cleared', !/slowwave\.WAKE/.test(pendingAlarms()));
  check('service gone after alarm', !/SleepService/.test(adb('shell dumpsys activity services com.mildsolvent.slowwave')));
  adb('shell input keyevent 224'); await sleep(1000); adb('shell input keyevent 82');
  await p.evaluate(() => { document.getElementById('morning-skip').click(); });

  // an alarm nobody stops gives up by itself
  const nr2 = await p.evaluate(c => Engine.start(Object.assign({}, c, { napDelayMin: 0, napMin: 0.3, alarmMin: 0.25 })), nc);
  while (Date.now() < nr2.plan.end + 4000) await sleep(1000);
  const ln2 = await p.evaluate(() => Engine.peekLastSession());
  check('unanswered alarm stops itself', ln2 && ln2.endedBy === 'done' && (await p.evaluate(() => Engine.status())).state === 'idle', ln2 && ln2.endedBy);
  await p.evaluate(() => { document.getElementById('morning-skip').click(); });

  const allErrs = errs === p.errs ? errs : errs.concat(p.errs); check('no JS errors', allErrs.length === 0, allErrs.join(' | '));
  p.close();
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });

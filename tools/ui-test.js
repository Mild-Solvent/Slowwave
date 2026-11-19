// Headless phone-size test of the web UI (browser engine). Usage: node tools/ui-test.js [outdir]
const { chromium } = require('playwright');
const path = require('path'), http = require('http'), fs = require('fs');
const root = path.join(__dirname, '..', 'web'), out = process.argv[2] || '/tmp/sw-ui';
fs.mkdirSync(out, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((q, r) => {
  const f = path.join(root, decodeURIComponent(q.url.split('?')[0]).replace(/\/$/, '/index.html'));
  if (!f.startsWith(root) || !fs.existsSync(f)) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r);
}).listen(0);
let fails = 0;
const setSlider = (p, id, v) => p.evaluate(([id, v]) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, [id, v]);
const check = (name, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!ok) fails++; };

(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto(`http://localhost:${srv.address().port}/`);
  await p.waitForTimeout(400);
  check('loads without JS errors', errs.length === 0, errs.join(' | '));
  const sw = await p.evaluate(() => document.documentElement.scrollWidth);
  check('page width <= 390', sw <= 390, String(sw));
  check('web engine in browser', await p.evaluate(() => Engine.kind === 'web'));
  check('keep-screen row visible on web', await p.isVisible('#screen-row'));
  await p.screenshot({ path: out + '/setup.png', fullPage: true });

  // burst render: 50 ms, peak 1, ramps
  const br = await p.evaluate(() => {
    const d = SW.renderBurst(44100); let pk = 0; d.forEach(x => { pk = Math.max(pk, Math.abs(x)); });
    return { n: d.length, pk, first: Math.abs(d[0]), last: Math.abs(d[d.length - 1]) };
  });
  check('burst is 50 ms at 44.1k', br.n === 2205, String(br.n));
  check('burst peak normalised', Math.abs(br.pk - 1) < 0.01, br.pk.toFixed(3));
  check('burst ramps start/end at 0', br.first < 1e-6 && br.last < 1e-6);
  check('default volume is quiet (< -40 dBFS)', await p.evaluate(() => 20 * Math.log10(SW.burstGain(35)) < -40));

  // settings persist
  await setSlider(p, 'delay', 45);
  await p.click('.chips[data-key=pattern] button[data-v="pairs"]');
  await p.click('#sw-lull');
  check('lull volume appears', await p.isVisible('#lull-vol-field'));
  await p.reload(); await p.waitForTimeout(300);
  const cfg = await p.evaluate(() => JSON.parse(localStorage.getItem('sw.cfg')));
  check('settings persist', cfg.delayMin === 45 && cfg.pattern === 'pairs' && cfg.lull === true, JSON.stringify(cfg));
  check('slider shows saved value', await p.evaluate(() => document.getElementById('delay').value === '45'));
  check('slider label shows minutes', (await p.textContent('[data-val=delayMin]')) === '45 min', await p.textContent('[data-val=delayMin]'));
  await setSlider(p, 'window', 75);
  check('burst window slider: 1 h 15 min', (await p.textContent('[data-val=windowMin]')) === '1 h 15 min');
  await setSlider(p, 'window', 180);
  const t = await p.textContent('#times');
  check('timeline shows burst window', /bursts .*→/.test(t), t);

  // test button
  await p.click('#btn-test'); await p.waitForTimeout(500);
  check('test animates pips', (await p.$$('.pip')).length >= 1);

  // sheets + back
  await p.click('#btn-about');
  check('about sheet opens', await p.isVisible('#sheet-about'));
  const backed = await p.evaluate(() => window.onBack() === true);
  check('back closes sheet', backed && !(await p.isVisible('#sheet-about')));
  await p.click('#btn-about'); await p.waitForTimeout(300);
  await p.screenshot({ path: out + '/about.png' });
  await p.click('#sheet-about [data-close]');

  // start night
  await p.click('#btn-start'); await p.waitForTimeout(1300);
  check('night screen shown', await p.isVisible('#night') && !(await p.isVisible('#setup')));
  const st = await p.evaluate(() => Engine.status());
  check('state waiting during delay', st.state === 'waiting', st.state);
  check('burst window starts 45 min after start', st.plan.burstStart - st.plan.start === 45 * 60000);
  await p.screenshot({ path: out + '/night.png' });

  // hold to stop: a short press must not stop
  const box = await (await p.$('#btn-stop')).boundingBox();
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await p.mouse.down(); await p.waitForTimeout(300); await p.mouse.up(); await p.waitForTimeout(200);
  check('short press does not stop', await p.isVisible('#night'));
  await p.mouse.down(); await p.waitForTimeout(1500); await p.mouse.up(); await p.waitForTimeout(300);
  check('hold stops the night', await p.isVisible('#setup'));
  check('morning card shows after stop', await p.isVisible('#morning'));
  await p.screenshot({ path: out + '/morning.png', fullPage: true });
  await p.click('#rate button[data-r="4"]'); await p.fill('#morning-note', 'test night'); await p.click('#morning-save');
  const log = await p.evaluate(() => JSON.parse(localStorage.getItem('sw.log')));
  check('rating saved to log', log.length === 1 && log[0].rating === 4 && log[0].note === 'test night');
  check('morning card hidden after save', !(await p.isVisible('#morning')));

  // a night whose window has passed ends by itself
  await p.evaluate(() => { Engine.start(Object.assign({}, __sw.cfg, { blind: false })); });
  await p.evaluate(() => {
    const k = 'sw.webSession', s = JSON.parse(localStorage.getItem(k));
    s.plan.burstStart -= 10 * 3600e3; s.plan.burstEnd = s.plan.end = Date.now() - 1000; localStorage.setItem(k, JSON.stringify(s));
  });
  await p.waitForTimeout(16000);
  const last = await p.evaluate(() => Engine.peekLastSession());
  check('night ends by itself after window', !!last && last.endedBy === 'done', last && last.endedBy);
  await p.evaluate(() => { const r = document.getElementById('morning'); if (r.classList.contains('hidden')) location.reload(); });
  await p.waitForTimeout(400);
  check('morning card after auto end', await p.isVisible('#morning'));
  await p.click('#morning-skip');

  // blind mode
  if (!(await p.evaluate(() => JSON.parse(localStorage.getItem('sw.cfg')).blind))) await p.click('#sw-blind');
  await p.click('#btn-start'); await p.waitForTimeout(1200);
  await p.evaluate(() => Engine.stop());
  await p.evaluate(() => location.reload()); await p.waitForTimeout(500);
  await p.click('#rate button[data-r="3"]'); await p.click('#morning-save'); await p.waitForTimeout(200);
  check('blind reveal toast', /Reveal/.test(await p.textContent('#toast')), await p.textContent('#toast'));
  await p.click('#btn-log'); await p.waitForTimeout(300);
  check('log lists nights', (await p.$$('#log-list li')).length >= 2);
  await p.screenshot({ path: out + '/log.png' });

  // chime
  const ch = await p.evaluate(() => { const d = SW.renderChime(44100); let pk = 0; d.forEach(x => { pk = Math.max(pk, Math.abs(x)); }); return { n: d.length, pk, last: Math.abs(d[d.length - 1]) }; });
  check('alarm chime 2.8 s, peak 1, ends at 0', ch.n === Math.round(44100 * 2.8) && Math.abs(ch.pk - 1) < 0.01 && ch.last < 1e-3, JSON.stringify(ch));
  check('alarm gets louder: -32 to -10 dBFS', await p.evaluate(() => Math.abs(20 * Math.log10(SW.alarmGain(0)) + 32) < 0.1 && Math.abs(20 * Math.log10(SW.alarmGain(120000)) + 10) < 0.1));
  await p.click('#sheet-log [data-close]');

  // night alarm
  if (await p.evaluate(() => JSON.parse(localStorage.getItem('sw.cfg')).blind)) await p.click('#sw-blind');
  check('alarm time hidden while alarm off', !(await p.isVisible('#alarm-time')));
  await p.click('#sw-alarm');
  check('alarm time shows when alarm on', await p.isVisible('#alarm-time'));
  const soon = await p.evaluate(() => { const d = new Date(Date.now() + 2 * 3600e3); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); });
  await p.fill('#alarm-time', soon); await p.dispatchEvent('#alarm-time', 'change');
  const ap = await p.evaluate(() => SW.makePlan(__sw.runCfg(), Date.now()));
  check('night alarm at the chosen time', ap.wakeAt && Math.abs(ap.wakeAt - Date.now() - 2 * 3600e3) < 61000, String(ap.wakeAt - Date.now()));
  check('bursts end 10 min before the alarm', ap.burstEnd <= ap.wakeAt - 10 * 60000, String((ap.wakeAt - ap.burstEnd) / 60000));
  check('timeline shows the alarm', /alarm/.test(await p.textContent('#times')) && await p.isVisible('#seg-wake'), await p.textContent('#times'));
  await p.screenshot({ path: out + '/night-alarm.png', fullPage: true });
  await p.click('#sw-alarm');

  // nap mode
  await p.click('.modes button[data-v="nap"]');
  check('nap mode: nap length shows, night fields hide', await p.isVisible('#naplen') && !(await p.isVisible('#window')) && !(await p.isVisible('#sw-blind')) && !(await p.isVisible('#sw-alarm')));
  check('nap mode: start says Start nap', (await p.textContent('#btn-start')) === 'Start nap');
  await setSlider(p, 'napdelay', 7); await setSlider(p, 'naplen', 45);
  check('nap sliders labelled', (await p.textContent('[data-val=napMin]')) === '45 min' && (await p.textContent('[data-val=napDelayMin]')) === '7 min');
  check('nap timeline shows alarm', /alarm/.test(await p.textContent('#times')), await p.textContent('#times'));
  check('page width <= 390 in nap mode', await p.evaluate(() => document.documentElement.scrollWidth <= 390));
  await p.screenshot({ path: out + '/nap.png', fullPage: true });
  await p.click('#btn-start'); await p.waitForTimeout(1200);
  let ns = await p.evaluate(() => Engine.status());
  check('nap starts waiting', ns.state === 'waiting', ns.state);
  check('nap plan: 7 min fall asleep, wake 45 min later, bursts stop 5 min before', ns.plan.burstStart - ns.plan.start === 7 * 60000 && ns.plan.wakeAt - ns.plan.burstStart === 45 * 60000 && ns.plan.wakeAt - ns.plan.burstEnd === 5 * 60000);
  check('nap is never blind', ns.cfg.blind === false);
  check('nap night screen says Nap', /Nap/.test(await p.textContent('#n-phase')));
  // jump to the alarm
  await p.evaluate(() => { const k = 'sw.webSession', s = JSON.parse(localStorage.getItem(k)), now = Date.now();
    s.plan.wakeAt = now - 1000; s.plan.burstEnd = now - 60000; s.plan.burstStart = now - 120000; s.plan.end = now + 5 * 60000; localStorage.setItem(k, JSON.stringify(s)); });
  await p.waitForTimeout(1300);
  check('alarm rings: waking state', (await p.evaluate(() => Engine.status())).state === 'waking');
  check('ringing screen', await p.evaluate(() => document.getElementById('night').classList.contains('waking')) && /alarm/.test(await p.textContent('#hold-label')));
  await p.screenshot({ path: out + '/alarm.png' });
  const bx = await (await p.$('#btn-stop')).boundingBox();
  await p.mouse.move(bx.x + bx.width / 2, bx.y + bx.height / 2); await p.mouse.down(); await p.waitForTimeout(1500); await p.mouse.up(); await p.waitForTimeout(300);
  const nl = await p.evaluate(() => Engine.peekLastSession());
  check('hold stops alarm, recorded as woke', nl && nl.endedBy === 'woke', nl && nl.endedBy);
  check('morning card says Last nap', (await p.textContent('#morning-title')) === 'Last nap');
  await p.click('#rate button[data-r="5"]'); await p.click('#morning-save');
  check('nap saved in log as nap', await p.evaluate(() => JSON.parse(localStorage.getItem('sw.log'))[0].nap === true));
  // alarm that nobody stops ends by itself
  await p.click('#btn-start'); await p.waitForTimeout(500);
  await p.evaluate(() => { const k = 'sw.webSession', s = JSON.parse(localStorage.getItem(k)), now = Date.now();
    s.plan.wakeAt = now - 6 * 60000; s.plan.burstEnd = s.plan.burstStart = now - 7 * 60000; s.plan.end = now - 1000; localStorage.setItem(k, JSON.stringify(s)); });
  await p.waitForTimeout(1300);
  const al = await p.evaluate(() => Engine.peekLastSession());
  check('unanswered alarm stops after its time', al && al.endedBy === 'done' && await p.isVisible('#setup'), al && al.endedBy);
  await p.click('#morning-skip');

  check('no JS errors overall', errs.length === 0, errs.join(' | '));
  await b.close(); srv.close();
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();

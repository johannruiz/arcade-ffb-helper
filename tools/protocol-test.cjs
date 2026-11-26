// Protocol check for the running helper, no wheel needed (0.2, 2026-11-26).
// A page on an allowed origin (TEST_PAGE, e.g. a local game server) opens /ws/game and sends `f`
// lines; the helper's report (GET /report) says what it would play. Checks that a game without
// the optional spring shape (Daytona USA 2, Scud Race) still gets the linear spring it always had,
// and that Daytona USA's shaped spring reaches the wheel with its dead zone and slope.
//   node tools/protocol-test.cjs   (helper running; PLAYWRIGHT_PATH, TEST_PAGE=http://localhost:<port>/test.html)
const assert = require('node:assert/strict');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const PAGE = process.env.TEST_PAGE || 'http://localhost:8162/spectator.html';

const report = () => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: 47823, path: '/report', headers: { Host: '127.0.0.1:47823' } }, res => {
    let body = ''; res.on('data', d => body += d); res.on('end', () => resolve(body));
  }).on('error', reject);
});
const setting = (text, key) => Number(text.match(new RegExp(`^\\s*${key}\\s*[=:]\\s*([-0-9.]+)`, 'm'))?.[1]);

(async () => {
  const browser = await chromium.launch({ channel: process.env.TEST_CHANNEL || 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(PAGE); // any HTML page served from an allowed origin (client/test.html works)
    const hi = await page.evaluate(() => new Promise((ok, fail) => {
      const ws = window.ws = new WebSocket('ws://127.0.0.1:47823/ws/game');
      ws.onopen = () => ws.send('hello test 1');
      ws.onmessage = e => ok(String(e.data));
      ws.onerror = () => fail('no helper');
      // keep the game talking so the helper treats it as live (it stops after 300 ms of silence)
      window.send = line => { clearInterval(window.timer); ws.send(line); window.timer = setInterval(() => ws.send(line), 100); };
    }));
    console.log('helper says:', hi);
    assert.match(hi, /^hi 0\.2\.0 /);
    const first = await report();
    const strength = setting(first, 'strength'), springGain = setting(first, 'springGain'), minSpring = setting(first, 'minSpring');
    assert.ok(strength > 0 && springGain > 0, 'settings in the report');
    const cases = [
      { name: 'D2/Scud: no shape (linear, as before)', line: 'f 1 0.200 0.500 0.000 0.000 0.000', shaped: false },
      { name: 'D1: shaped spring 0x3F (dead zone 6%)', line: 'f 1 0.000 0.484 0.000 0.000 0.000 0.060 12.500', shaped: true, dead: 0.06, slope: 12.5 },
      { name: 'D1: shaped spring 0x34 (dead zone 2%)', line: 'f 1 0.000 0.355 0.000 0.000 0.000 0.020 12.500', shaped: true, dead: 0.02, slope: 12.5 },
      { name: 'D1: force, no spring (shape ignored)', line: 'f 1 0.742 0.000 0.000 0.000 0.000 0.020 12.500', shaped: false },
      { name: 'seven fields: treated as linear', line: 'f 1 0.000 0.400 0.000 0.000 0.000 0.060', shaped: false },
      { name: 'out of range: clamped', line: 'f 1 0.000 0.400 0.000 0.000 0.000 9 -4', shaped: true, dead: 0.5, slope: 0 },
      { name: 'not live: all zero', line: 'f 0 0 0 0 0 0', shaped: false, zero: true },
    ];
    for (const c of cases) {
      await page.evaluate(line => window.send(line), c.line);
      await page.waitForTimeout(250);
      const r = await report();
      const wheel = r.match(/to the wheel now: torque ([-0-9.]+), spring ([0-9.]+)/);
      const spring = Number(wheel[2]);
      const shape = r.match(/spring shape to the wheel: (linear|saturation ([0-9.]+), slope ([0-9.]+), dead zone ([0-9.]+))/);
      const raw = Number(c.line.split(' ')[3]);
      const expectSpring = c.zero ? 0 : Math.min(1, Math.max(raw * springGain, minSpring) * strength);
      assert.ok(Math.abs(spring - expectSpring) < 0.002, `${c.name}: spring ${spring} vs ${expectSpring}`);
      if (c.shaped && raw * springGain >= minSpring) {
        assert.notEqual(shape[1], 'linear', c.name);
        assert.ok(Math.abs(Number(shape[3]) - Math.min(1, c.slope * springGain * strength)) < 0.002, `${c.name}: slope`);
        assert.ok(Math.abs(Number(shape[4]) - c.dead) < 0.002, `${c.name}: dead zone`);
      } else assert.equal(shape[1], 'linear', c.name);
      console.log('ok -', c.name, '|', wheel[0].replace('to the wheel now: ', ''), '|', shape[0]);
    }
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });

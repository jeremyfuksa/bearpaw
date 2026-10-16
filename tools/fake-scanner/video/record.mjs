// Drives Bearpaw through the hype-video shot list against the fake scanner,
// as a 1920x1080 video. record-vertical.mjs is the 1080x1920 cut.
//
//   0. npm install in this directory, once. Needs Google Chrome and ffmpeg.
//   1. tools/fake-scanner/demo.sh browser BC125AT     (fresh start = clean take)
//   2. node record.mjs --capture  headless; records take.mp4 itself
//      node record.mjs            full-screen Chrome on the main display, for
//                                 recording the screen yourself
//
// Every take logs its hits into the current hour, which after a few takes
// outweighs the seeded week and darkens the heatmap. Delete
// /tmp/bearpaw-demo/analytics.db before starting demo.sh to reseed it.
//
// Zoom and pan happen inside the page (a CSS transform on <body>), so text stays
// sharp at any zoom on a 1080p capture. The cursor is drawn by the page, because
// Playwright's mouse never moves the real one.
import { chromium } from 'playwright-core';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const APP = 'http://localhost:5173/';
const API = 'http://localhost:8000/api/v1';
const W = 1920, H = 1080;
const capture = process.argv.includes('--capture');
// Capture runs every camera move SLOW times slower, then plays it back at
// speed: about 200 real samples a second, blended into true motion blur.
const SLOW = capture ? 8 : 1;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (p, init) => fetch(API + p, init).then((r) => r.json());

// ---- preflight ------------------------------------------------------------
const info = await api('/device/info');
if (info.model !== 'BC125AT' || info.connection_status !== 'connected') {
  throw new Error(`expected a connected BC125AT, got ${info.model} ${info.connection_status}`);
}
await api('/memory/sync', { method: 'POST' });
for (let i = 0; i < 60 && (await api('/memory/sync/status')).in_progress; i++) await sleep(500);
const bank8 = await api('/memory/channels/351');
if (bank8.frequency) throw new Error('bank 8 already has channels: restart demo.sh for a clean take');
// Bank names outlive the fake scanner's memory, so clear them for every take.
await api('/banks/names', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ names: Array(10).fill('') }),
});

// ---- browser --------------------------------------------------------------
const browser = await chromium.launch({
  channel: 'chrome',
  headless: capture,
  ignoreDefaultArgs: ['--enable-automation'],
  args: capture ? [`--window-size=${W},${H}`] : ['--kiosk', '--window-position=0,0', `--window-size=${W},${H}`],
});
const context = await browser.newContext(
  capture
    ? { viewport: { width: W, height: H } }
    : { viewport: null },
);
await context.addInitScript(() => {
  const W = innerWidth, H = innerHeight;
  const css = document.createElement('style');
  css.textContent = `
    html { overflow: hidden !important; background: #1c1f26; }
    ::-webkit-scrollbar { display: none; }
    #fx-cursor { position: fixed; left: 0; top: 0; z-index: 2147483647; pointer-events: none;
      width: 28px; height: 28px; transform: translate(-100px, -100px); transition: scale .12s; }
    #fx-cursor.down { scale: .82; }
    .fx-ripple { position: fixed; z-index: 2147483646; pointer-events: none; width: 44px; height: 44px;
      margin: -22px 0 0 -22px; border-radius: 50%; border: 3px solid #f29a1f; animation: fx-r .5s ease-out forwards; }
    @keyframes fx-r { from { opacity: .9; scale: .3 } to { opacity: 0; scale: 1.3 } }
    #fx-key { position: fixed; left: 50%; bottom: 64px; translate: -50% 0; z-index: 2147483647; pointer-events: none;
      font: 600 34px/1 -apple-system, sans-serif; color: #fff; background: rgba(17,19,27,.88);
      border: 1px solid rgba(255,255,255,.18); border-radius: 14px; padding: 16px 26px; opacity: 0; transition: opacity .2s; }
  `;
  const cam = { x: 0, y: 0, s: 1 };
  let lockEl = null;
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  window.__fx = {
    // Show layout-space region (x, y, w, h) filling the viewport.
    focus(r, pad = 40, ms = 1400) {
      const s = Math.max(1, Math.min(W / (r.w + 2 * pad), H / (r.h + 2 * pad)));
      const x = clamp(r.x + r.w / 2 - W / s / 2, 0, W - W / s);
      const y = clamp(r.y + r.h / 2 - H / s / 2, 0, H - H / s);
      Object.assign(cam, { x, y, s });
      const b = document.body;
      b.style.transformOrigin = '0 0';
      b.style.transition = `transform ${ms}ms cubic-bezier(.83,0,.17,1)`;
      b.style.transform = `translate(${-x * s}px, ${-y * s}px) scale(${s})`;
    },
    wide(ms = 1200) { this.focus({ x: 0, y: 0, w: W, h: H }, 0, ms); },
    // An element's rect in layout space, undoing the current camera.
    rect(el) {
      const r = el.getBoundingClientRect();
      return { x: r.x / cam.s + cam.x, y: r.y / cam.s + cam.y, w: r.width / cam.s, h: r.height / cam.s };
    },
    scale() { return cam.s; },
    // Pin the drawn cursor to an element (e.g. a grip being dragged), or null.
    lock(el) { lockEl = el; },
    key(text) {
      const k = document.getElementById('fx-key');
      k.textContent = text; k.style.opacity = 1;
      setTimeout(() => (k.style.opacity = 0), 1100);
    },
  };
  addEventListener('DOMContentLoaded', () => {
    document.head.append(css);
    const c = document.createElement('div');
    c.id = 'fx-cursor';
    c.innerHTML = '<svg viewBox="0 0 28 28" width="28" height="28"><path d="M5 3l16 11.5-7 1.2 4.3 8.3-3.2 1.6-4.2-8.4L5 22z" fill="#fff" stroke="#000" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    const k = document.createElement('div');
    k.id = 'fx-key';
    document.documentElement.append(c, k);
    const place = (x, y) => (c.style.transform = `translate(${x - 5}px, ${y - 3}px)`);
    addEventListener('mousemove', (e) => { if (!lockEl) place(e.clientX, e.clientY); }, true);
    const follow = () => {
      if (lockEl) { const r = lockEl.getBoundingClientRect(); place(r.x + r.width / 2, r.y + r.height / 2); }
      requestAnimationFrame(follow);
    };
    follow();
    addEventListener('mousedown', (e) => {
      c.classList.add('down');
      const r = document.createElement('div');
      r.className = 'fx-ripple'; r.style.left = e.clientX + 'px'; r.style.top = e.clientY + 'px';
      document.documentElement.append(r); setTimeout(() => r.remove(), 600);
    }, true);
    addEventListener('mouseup', () => c.classList.remove('down'), true);
  });
});
const page = await context.newPage();
await page.goto(APP);
await page.getByRole('tab', { name: 'Scan' }).waitFor();
await sleep(2500);

// ---- helpers --------------------------------------------------------------
let mouse = { x: W * 0.62, y: H * 0.72 };
await page.mouse.move(mouse.x, mouse.y);
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
async function glide(x, y, ms = 700) {
  const from = { ...mouse }, n = Math.max(8, Math.round(ms / 16));
  for (let i = 1; i <= n; i++) {
    const t = ease(i / n);
    await page.mouse.move(from.x + (x - from.x) * t, from.y + (y - from.y) * t);
    await sleep(ms / n / 2);
  }
  mouse = { x, y };
}
async function center(locator) {
  const b = await locator.boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}
async function click(locator, ms) {
  const p = await center(locator);
  await glide(p.x, p.y, ms);
  await sleep(150);
  await page.mouse.down(); await sleep(90); await page.mouse.up();
}
const rectOf = (locator) => locator.evaluate((el) => window.__fx.rect(el));
// SIGUSR2 freezes the fake scanner, so nothing changes on screen while a
// slowed move plays out; a second one resumes it.
const freeze = () => execFileSync('pkill', ['-USR2', '-f', 'fake_scanner.py']);
const slowed = []; // [start, end] wall-clock seconds of each slowed move
async function move(fn, ms, hold = false) {
  if (SLOW > 1 && !hold) freeze();
  const start = Date.now() / 1000;
  await fn(ms * SLOW);
  await sleep(ms * SLOW);
  slowed.push([start, Date.now() / 1000]);
  if (SLOW > 1 && !hold) freeze();
}
const focus = (r, pad, ms = 1400, hold) => move((d) => page.evaluate(([r, pad, d]) => window.__fx.focus(r, pad, d), [r, pad, d]), ms, hold);
const wide = (ms = 1200) => move((d) => page.evaluate((d) => window.__fx.wide(d), d), ms);
// Wall-clock time to video time: each slowed move plays back SLOW times faster.
const toVideo = (t) => slowed.reduce((v, [a, b]) => v - Math.max(0, Math.min(t, b) - a) * (1 - 1 / SLOW), t);
const panelOf = (heading) => page.getByRole('heading', { name: heading }).locator('xpath=..');

const markers = [];
let t0;
const mark = (name) => {
  markers.push([Date.now() / 1000, name]);
  console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s (wall)  ${name}`);
};

// ---- countdown --------------------------------------------------------------
if (!capture) {
  console.log('Start your screen recording now. Rolling in 12 seconds...');
  await sleep(12000);
}
// Capture: Chrome's screencast sends a frame each time the page repaints, each
// with its own timestamp; ffmpeg turns that variable-rate stream into 60 fps.
const frames = [];
let cdp;
if (capture) {
  rmSync('capture', { recursive: true, force: true });
  mkdirSync('capture');
  cdp = await context.newCDPSession(page);
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    const file = `f${String(frames.length).padStart(5, '0')}.jpg`;
    writeFileSync(`capture/${file}`, Buffer.from(data, 'base64'));
    frames.push({ file, t: metadata.timestamp });
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 95, maxWidth: W, maxHeight: H });
}
t0 = Date.now();

// ---- 1. a hit lands on the display ------------------------------------------
mark('1 wide: Scan view');
await sleep(4000);
// Zoom on a hit that has just started, so it holds for the whole shot.
for (let i = 0; i < 60 && (await api('/status')).squelch_open; i++) await sleep(250);
for (let i = 0; i < 80 && !(await api('/status')).squelch_open; i++) await sleep(250);
mark('1 zoom: hit on the display');
// Frozen across the zoom AND the hold, so the hit stays up for both.
if (SLOW > 1) freeze();
await focus(await rectOf(page.locator('[class*="radial-gradient"]').first()), 30, 1500, true);
await sleep(4000);
if (SLOW > 1) freeze();

// ---- 2. the history ----------------------------------------------------------
mark('2 pan: Recent Hits');
await focus(await rectOf(panelOf('Recent Hits')), 30, 1400);
await sleep(2800);
mark('2 pan: Busiest Channels');
await focus(await rectOf(panelOf('Busiest Channels')), 30, 1400);
await sleep(2200);
mark('2 pan: Activity Heatmap');
await focus(await rectOf(panelOf('Activity Heatmap')), 30, 1400);
await sleep(2800);
await wide(1200);

// ---- 3. paste a bank -----------------------------------------------------------
mark('3 Channels tab');
await click(page.getByRole('tab', { name: 'Channels' }), 900);
await sleep(900);
await click(page.getByRole('button', { name: 'Bank 8', exact: true }), 800);
await sleep(700);
const firstRow = page.locator('[role=row][aria-rowindex="2"]');
const table = await rectOf(page.locator('[role=row]').first());
const rowBox = await rectOf(firstRow);
mark('3 zoom: empty bank');
await focus({ x: table.x - 10, y: table.y - 80, w: 760, h: 9 * rowBox.h + 120 }, 20, 1300);
await click(firstRow.locator(':scope > div').nth(2), 700);
await sleep(600);
mark('3 paste');
await page.evaluate(() => window.__fx.key('⌘V'));
await sleep(350);
const tsv = [
  'Freq\tTag\tMode',
  '156.800\tMarine 16\tFM', '156.450\tMarine 9\tFM', '156.650\tMarine 13\tFM', '157.100\tUSCG 22A\tFM',
  '156.300\tMarine 6\tFM', '156.550\tMarine 11\tFM', '156.600\tMarine 12\tFM', '156.700\tMarine 14\tFM',
].join('\n');
await page.evaluate((t) => {
  const dt = new DataTransfer();
  dt.setData('text/plain', t);
  document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
}, tsv);
await sleep(2800);

// ---- 4. drag a channel ------------------------------------------------------------
mark('4 drag: USCG 22A to the top');
// Pull back to about 1.6x first. The camera scales the page, and motion's
// Reorder mixes on-screen and unscaled distances when it decides a swap: from
// 2x up, the last swap into slot 1 never triggers. Below that it does, and
// the row still moves s times faster than the pointer, so the drawn cursor is
// pinned to the grip instead of following the pointer.
await focus({ x: table.x - 10, y: table.y - 80, w: 1160, h: 9 * rowBox.h + 120 }, 20, 900);
const gripLoc = page.getByRole('button', { name: /^Reorder channel 354,/ });
const grip = await center(gripLoc);
const top = await center(page.getByRole('button', { name: /^Reorder channel 351,/ }));
const s = await page.evaluate(() => window.__fx.scale());
await glide(grip.x, grip.y, 800);
await sleep(200);
await gripLoc.evaluate((el) => window.__fx.lock(el));
await page.mouse.down();
await sleep(250);
await glide(grip.x, grip.y + (top.y - grip.y) / s - 6, 1400);
await sleep(400);
await page.mouse.up();
await sleep(300);
const dropped = await center(page.getByRole('button', { name: /^Reorder channel 351,/ }));
await page.evaluate(() => window.__fx.lock(null));
await page.mouse.move(dropped.x, dropped.y);
mouse = dropped;
await sleep(1500);

// ---- 5. name the bank ----------------------------------------------------------------
mark('5 rename bank 8 to Marine');
const side = await rectOf(page.getByRole('button', { name: 'Bank 8', exact: true }));
await focus({ x: side.x - 20, y: side.y - 260, w: 760, h: 420 }, 20, 1200);
await click(page.getByRole('button', { name: 'Rename bank 8' }), 700);
await sleep(300);
const input = page.getByLabel('Name for bank 8');
await input.fill('');
await input.pressSequentially('Marine', { delay: 110 });
await sleep(300);
await input.press('Enter');
await sleep(1800);

// ---- 6. upload ---------------------------------------------------------------------------
mark('6 upload');
await wide(1100);
await click(page.getByRole('button', { name: 'Upload Changes' }), 1000);
await page.getByText('No pending changes').waitFor({ timeout: 30000 });
await sleep(2000);

// ---- 7. swap scanners ------------------------------------------------------------------------
mark('7 swap: BC125AT -> BC75XLT');
execFile('pkill', ['-USR1', '-f', 'fake_scanner.py']);
for (let i = 0; i < 80; i++) {
  const d = await api('/device/info');
  if (d.model === 'BC75XLT' && d.connection_status === 'connected') break;
  await sleep(250);
}
mark('7 swap: BC75XLT connected');
await sleep(3000);

// ---- 8. outro ------------------------------------------------------------------------------------
mark('8 Scan view on the BC75XLT');
await click(page.getByRole('tab', { name: 'Scan' }), 900);
await glide(W * 0.8, H * 0.95, 900);
await sleep(5000);
mark('end');

const origin = capture ? toVideo(frames[0].t) : t0 / 1000;
writeFileSync('markers.txt', markers.map(([t, n]) => `${(toVideo(t) - origin).toFixed(1)}s  ${n}`).join('\n') + '\n');
if (capture) {
  await cdp.send('Page.stopScreencast');
  const at = frames.map((f) => toVideo(f.t));
  const list = frames.map((f, i) => {
    const next = at[i + 1] ?? at[i] + 1 / 30;
    return `file '${f.file}'\nduration ${(next - at[i]).toFixed(5)}`;
  });
  // The concat demuxer ignores the last entry's duration unless it is repeated.
  list.push(`file '${frames.at(-1).file}'`);
  writeFileSync('capture/frames.txt', list.join('\n') + '\n');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', 'capture/frames.txt',
    // 240 fps, then average 3 neighbours (a 270-degree shutter) and keep every 4th.
    '-vf', 'fps=240,tmix=frames=3,fps=60,format=yuv420p', '-c:v', 'libx264', '-crf', '14', '-preset', 'slow', '-movflags', '+faststart', 'take.mp4']);
  const span = at.at(-1) - at[0];
  console.log(`take.mp4: ${frames.length} frames over ${span.toFixed(1)} s of video`);
  console.log(readFileSync('markers.txt', 'utf8'));
}
await context.close();
await browser.close();
// Leave the fake on the BC125AT for the next take.
execFile('pkill', ['-USR1', '-f', 'fake_scanner.py']);

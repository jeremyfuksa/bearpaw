// The hype-video shot list as a 1080x1920 vertical video, recorded headlessly.
//
//   0. npm install in this directory, once. Needs Google Chrome and ffmpeg.
//   1. tools/fake-scanner/demo.sh browser BC125AT     (fresh start = clean take)
//   2. node record-vertical.mjs                         writes vertical.mp4
//
// See record.mjs for reseeding the hit history between takes.
//
// Bearpaw cramps below ~1400 px wide, so it is not resized: it runs at its
// normal 1920x1080 inside an iframe, and a portrait camera (a CSS transform on
// the iframe) frames it. Wide shots show the whole app across the middle with
// room above and below for captions; close-ups fill the width.
//
// Unlike record.mjs, the camera transforms the iframe, not the app's own body,
// so the browser maps the pointer into the app's coordinates and drags track
// 1:1 at any zoom.
import { chromium } from 'playwright-core';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const ORIGIN = 'http://localhost:5173';
const API = 'http://localhost:8000/api/v1';
const W = 1080, H = 1920; // the video
const AW = 1920, AH = 1080; // the app
const SLOW = 8; // camera moves are captured 8x slower, then played back at speed
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (p, init) => fetch(API + p, init).then((r) => r.json());

// ---- preflight ------------------------------------------------------------
const info = await api('/device/info');
if (info.model !== 'BC125AT' || info.connection_status !== 'connected') {
  throw new Error(`expected a connected BC125AT, got ${info.model} ${info.connection_status}`);
}
await api('/memory/sync', { method: 'POST' });
for (let i = 0; i < 60 && (await api('/memory/sync/status')).in_progress; i++) await sleep(500);
if ((await api('/memory/channels/351')).frequency) {
  throw new Error('bank 8 already has channels: restart demo.sh for a clean take');
}
await api('/banks/names', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ names: Array(10).fill('') }),
});

// ---- stage ------------------------------------------------------------------
// Served from the app's own origin, so the stage can reach into the iframe.
const STAGE = `${ORIGIN}/__stage`;
const stageHtml = `<!doctype html><html><head><style>
  html, body { margin: 0; height: 100%; overflow: hidden;
    background: radial-gradient(ellipse at 50% 45%, #2a2f3b 0%, #15171e 60%, #0d0f15 100%); }
  #app { position: absolute; left: 0; top: 0; width: ${AW}px; height: ${AH}px; border: 0;
    transform-origin: 0 0; border-radius: 18px; box-shadow: 0 30px 90px rgba(0,0,0,.6); }
</style></head><body><iframe id="app" src="${ORIGIN}/"></iframe></body></html>`;

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: [`--window-size=${W},${H}`] });
const context = await browser.newContext({ viewport: { width: W, height: H } });
await context.route(STAGE, (r) => r.fulfill({ contentType: 'text/html', body: stageHtml }));
await context.addInitScript(([W, H, AW, AH]) => {
  if (window.top !== window) {
    // Inside the app: no scrollbars, and report the pointer to the stage.
    addEventListener('DOMContentLoaded', () => {
      const css = document.createElement('style');
      css.textContent = 'html { overflow: hidden !important; } ::-webkit-scrollbar { display: none; }';
      document.head.append(css);
    });
    for (const type of ['mousemove', 'mousedown', 'mouseup']) {
      addEventListener(type, (e) => parent.__fx?.pointer(type, e.clientX, e.clientY), true);
    }
    return;
  }
  const cam = { x: 0, y: 0, s: 1 };
  let lockEl = null;
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  // Where the visible window starts on one axis: centred when it is wider
  // than the app, otherwise kept inside it.
  const start = (centre, view, size) => (view >= size ? (size - view) / 2 : clamp(centre - view / 2, 0, size - view));
  const app = () => document.getElementById('app');
  // The iframe's CURRENT transform, mid-transition included.
  const now = () => {
    const m = new DOMMatrix(getComputedStyle(app()).transform);
    return { s: m.a, tx: m.e, ty: m.f };
  };
  window.__fx = {
    focus(r, pad, ms) {
      const s = Math.min(W / (r.w + 2 * pad), H / (r.h + 2 * pad));
      const x = start(r.x + r.w / 2, W / s, AW);
      const y = start(r.y + r.h / 2, H / s, AH);
      Object.assign(cam, { x, y, s });
      const a = app();
      a.style.transition = `transform ${ms}ms cubic-bezier(.83,0,.17,1)`;
      a.style.transform = `translate(${-x * s}px, ${-y * s}px) scale(${s})`;
    },
    // App coordinates to stage coordinates.
    toStage(x, y) {
      const { s, tx, ty } = now();
      return { x: x * s + tx, y: y * s + ty };
    },
    pointer(type, x, y) {
      const p = this.toStage(x, y);
      if (type === 'mousemove' && !lockEl) place(p.x, p.y);
      if (type === 'mousedown') { cursor.classList.add('down'); ripple(p.x, p.y); }
      if (type === 'mouseup') cursor.classList.remove('down');
    },
    lock(el) { lockEl = el; },
    key(text) {
      key.textContent = text; key.style.opacity = 1;
      setTimeout(() => (key.style.opacity = 0), 1100);
    },
  };
  let cursor, key;
  const place = (x, y) => (cursor.style.transform = `translate(${x - 5}px, ${y - 3}px)`);
  const ripple = (x, y) => {
    const r = document.createElement('div');
    r.className = 'fx-ripple'; r.style.left = x + 'px'; r.style.top = y + 'px';
    document.body.append(r); setTimeout(() => r.remove(), 600);
  };
  addEventListener('DOMContentLoaded', () => {
    const css = document.createElement('style');
    css.textContent = `
      #fx-cursor { position: fixed; left: 0; top: 0; z-index: 10; pointer-events: none; width: 34px; height: 34px;
        transform: translate(-100px, -100px); transition: scale .12s; }
      #fx-cursor.down { scale: .82; }
      .fx-ripple { position: fixed; z-index: 9; pointer-events: none; width: 54px; height: 54px; margin: -27px 0 0 -27px;
        border-radius: 50%; border: 3px solid #f29a1f; animation: fx-r .5s ease-out forwards; }
      @keyframes fx-r { from { opacity: .9; scale: .3 } to { opacity: 0; scale: 1.3 } }
      #fx-key { position: fixed; left: 50%; bottom: 260px; translate: -50% 0; z-index: 10; pointer-events: none;
        font: 600 52px/1 -apple-system, sans-serif; color: #fff; background: rgba(17,19,27,.9);
        border: 1px solid rgba(255,255,255,.18); border-radius: 20px; padding: 22px 36px; opacity: 0; transition: opacity .2s; }`;
    document.head.append(css);
    cursor = document.createElement('div');
    cursor.id = 'fx-cursor';
    cursor.innerHTML = '<svg viewBox="0 0 28 28" width="34" height="34"><path d="M5 3l16 11.5-7 1.2 4.3 8.3-3.2 1.6-4.2-8.4L5 22z" fill="#fff" stroke="#000" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    key = document.createElement('div');
    key.id = 'fx-key';
    document.body.append(cursor, key);
    const follow = () => {
      if (lockEl) {
        const r = lockEl.getBoundingClientRect();
        const p = window.__fx.toStage(r.x + r.width / 2, r.y + r.height / 2);
        place(p.x, p.y);
      }
      requestAnimationFrame(follow);
    };
    follow();
  });
}, [W, H, AW, AH]);

const page = await context.newPage();
await page.goto(STAGE);
const app = page.frameLocator('#app');
await app.getByRole('tab', { name: 'Scan' }).waitFor();
const appFrame = page.frames().find((f) => f !== page.mainFrame());
await page.evaluate(([AW, AH]) => window.__fx.focus({ x: 0, y: 0, w: AW, h: AH }, 0, 0), [AW, AH]);
await sleep(2500);

// ---- helpers ------------------------------------------------------------------
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
let mouse = { x: W * 0.7, y: H * 0.62 };
await page.mouse.move(mouse.x, mouse.y);
async function glide(x, y, ms = 700) {
  const from = { ...mouse }, n = Math.max(8, Math.round(ms / 16));
  for (let i = 1; i <= n; i++) {
    const t = ease(i / n);
    await page.mouse.move(from.x + (x - from.x) * t, from.y + (y - from.y) * t);
    await sleep(ms / n / 2);
  }
  mouse = { x, y };
}
// An element's rect in APP coordinates (the iframe is never scrolled).
const rectOf = (loc) => loc.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
async function center(loc) {
  const r = await rectOf(loc);
  return page.evaluate(([x, y]) => window.__fx.toStage(x, y), [r.x + r.w / 2, r.y + r.h / 2]);
}
async function click(loc, ms) {
  const p = await center(loc);
  await glide(p.x, p.y, ms);
  await sleep(150);
  await page.mouse.down(); await sleep(90); await page.mouse.up();
}
const freeze = () => execFileSync('pkill', ['-USR2', '-f', 'fake_scanner.py']);
const slowed = [];
async function focus(r, pad, ms, hold = false) {
  if (!hold) freeze();
  const begin = Date.now() / 1000;
  await page.evaluate(([r, pad, d]) => window.__fx.focus(r, pad, d), [r, pad, ms * SLOW]);
  await sleep(ms * SLOW);
  slowed.push([begin, Date.now() / 1000]);
  if (!hold) freeze();
}
const wide = (ms) => focus({ x: 0, y: 0, w: AW, h: AH }, 0, ms);
const toVideo = (t) => slowed.reduce((v, [a, b]) => v - Math.max(0, Math.min(t, b) - a) * (1 - 1 / SLOW), t);
const panelOf = (heading) => app.getByRole('heading', { name: heading }).locator('xpath=..');
const markers = [];
const mark = (name) => { markers.push([Date.now() / 1000, name]); console.log(name); };

// ---- capture -----------------------------------------------------------------
const frames = [];
rmSync('capture-v', { recursive: true, force: true });
mkdirSync('capture-v');
const cdp = await context.newCDPSession(page);
cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
  const file = `f${String(frames.length).padStart(5, '0')}.jpg`;
  writeFileSync(`capture-v/${file}`, Buffer.from(data, 'base64'));
  frames.push({ file, t: metadata.timestamp });
  cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
});
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 95, maxWidth: W, maxHeight: H });

// ---- 1. a hit lands on the display ------------------------------------------
mark('1 wide: Scan view');
await sleep(4000);
for (let i = 0; i < 60 && (await api('/status')).squelch_open; i++) await sleep(250);
for (let i = 0; i < 80 && !(await api('/status')).squelch_open; i++) await sleep(250);
mark('1 zoom: hit on the display');
freeze(); // across the zoom AND the hold
// Portrait close-ups take a slice of each panel's width: the whole app height
// fits a 9:16 frame anyway, so a slice is what makes the text phone-sized.
const display = app.locator('[class*="radial-gradient"]').first();
const d = await rectOf(display);
// Wide enough for the whole tag: a long one ("Downtown Rptr") got cut at 640.
const tagRight = await display.evaluate((el) => {
  const left = el.getBoundingClientRect().left;
  // Measure the letters, not their element: the tag sits in a full-width block.
  const range = document.createRange();
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let right = 0;
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    if (!t.textContent.trim() || parseFloat(getComputedStyle(t.parentElement).fontSize) < 40) continue;
    range.selectNodeContents(t);
    right = Math.max(right, range.getBoundingClientRect().right - left);
  }
  return right;
});
await focus({ x: d.x - 16, y: d.y, w: Math.min(Math.max(640, tagRight + 56), d.w + 32), h: d.h }, 0, 1500, true);
await sleep(4000);
freeze();

// ---- 2. the history ----------------------------------------------------------
// Busiest Channels already sits under the display in shot 1's frame.
mark('2 pan: Recent Hits');
const hits = await rectOf(panelOf('Recent Hits'));
await focus({ x: hits.x - 16, y: hits.y, w: 680, h: hits.h }, 0, 1400);
await sleep(2800);
mark('2 push in: Activity Heatmap');
const heat = await rectOf(panelOf('Activity Heatmap'));
await focus({ x: heat.x - 10, y: heat.y, w: 560, h: heat.h }, 0, 1400);
await sleep(3000);
await wide(1200);

// ---- 3. paste a bank -----------------------------------------------------------
mark('3 Channels tab');
await click(app.getByRole('tab', { name: 'Channels' }), 900);
await sleep(900);
await click(app.getByRole('button', { name: 'Bank 8', exact: true }), 800);
await sleep(700);
const firstRow = app.locator('[role=row][aria-rowindex="2"]');
const table = await rectOf(app.locator('[role=row]').first());
const side = await rectOf(app.getByRole('button', { name: 'Bank 8', exact: true }));
// The bank list and the CH / FREQ / TAG columns, full height.
const leftCols = { x: side.x - 16, y: 0, w: table.x + 560 - (side.x - 16), h: AH };
mark('3 zoom: empty bank');
await focus(leftCols, 0, 1300);
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
await appFrame.evaluate((t) => {
  const dt = new DataTransfer();
  dt.setData('text/plain', t);
  document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
}, tsv);
await sleep(2800);

// ---- 4. drag a channel ------------------------------------------------------------
mark('4 drag: USCG 22A to the top');
const gripLoc = app.getByRole('button', { name: /^Reorder channel 354,/ });
const grip = await center(gripLoc);
const top = await center(app.getByRole('button', { name: /^Reorder channel 351,/ }));
await glide(grip.x, grip.y, 800);
await sleep(200);
await gripLoc.evaluate((el) => parent.__fx.lock(el));
await page.mouse.down();
await sleep(250);
await glide(grip.x, top.y - 6, 1400);
await sleep(400);
await page.mouse.up();
await sleep(300);
const dropped = await center(app.getByRole('button', { name: /^Reorder channel 351,/ }));
await page.evaluate(() => window.__fx.lock(null));
await page.mouse.move(dropped.x, dropped.y);
mouse = dropped;
await sleep(1500);

// ---- 5. name the bank ----------------------------------------------------------------
mark('5 rename bank 8 to Marine');
await focus({ x: side.x - 16, y: side.y - 300, w: 640, h: 520 }, 0, 1200);
await click(app.getByRole('button', { name: 'Rename bank 8' }), 700);
await sleep(300);
const input = app.getByLabel('Name for bank 8');
await input.fill('');
await input.pressSequentially('Marine', { delay: 110 });
await sleep(300);
await input.press('Enter');
await sleep(1800);

// ---- 6. upload ---------------------------------------------------------------------------
mark('6 upload');
const upload = app.getByRole('button', { name: 'Upload Changes' });
const up = await rectOf(upload);
await focus({ x: AW - 720, y: up.y - 160, w: 700, h: 560 }, 0, 1100);
await click(upload, 1000);
await app.getByText('No pending changes').waitFor({ timeout: 30000 });
await sleep(2000);

// ---- 7. swap scanners ------------------------------------------------------------------------
mark('7 swap: BC125AT -> BC75XLT');
await focus(leftCols, 0, 1100);
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
await click(app.getByRole('tab', { name: 'Scan' }), 900);
await sleep(600);
const d2 = await rectOf(display);
await focus({ x: d2.x - 16, y: d2.y, w: 640, h: d2.h }, 0, 1400);
await glide(W * 0.75, H * 0.8, 900);
await sleep(4500);
mark('end');

// ---- encode ----------------------------------------------------------------------------------
await cdp.send('Page.stopScreencast');
const at = frames.map((f) => toVideo(f.t));
const origin = at[0];
writeFileSync('markers-vertical.txt', markers.map(([t, n]) => `${(toVideo(t) - origin).toFixed(1)}s  ${n}`).join('\n') + '\n');
const list = frames.map((f, i) => `file '${f.file}'\nduration ${((at[i + 1] ?? at[i] + 1 / 30) - at[i]).toFixed(5)}`);
list.push(`file '${frames.at(-1).file}'`);
writeFileSync('capture-v/frames.txt', list.join('\n') + '\n');
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', 'capture-v/frames.txt',
  '-vf', 'fps=240,tmix=frames=3,fps=60,format=yuv420p', '-c:v', 'libx264', '-crf', '14', '-preset', 'slow',
  '-movflags', '+faststart', 'vertical.mp4']);
console.log(`vertical.mp4: ${frames.length} frames over ${(at.at(-1) - origin).toFixed(1)} s of video`);
console.log(readFileSync('markers-vertical.txt', 'utf8'));
await context.close();
await browser.close();
execFile('pkill', ['-USR1', '-f', 'fake_scanner.py']);

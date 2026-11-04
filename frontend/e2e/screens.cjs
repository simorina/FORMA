// Screenshots of Forma's main states for the README (docs/screenshots), in Chromium (Playwright),
// against a running backend on the offline provider. Like flows.cjs it DELETES every model it
// finds, so it refuses to run unless FORMA_E2E=1 and the backend's default provider is
// "procedural". Usage (both servers running, see `make screenshots`):
//   FORMA_E2E=1 node e2e/screens.cjs <out-dir> [desktop,tablet,phone] [scale]
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.env.FORMA_URL || 'http://127.0.0.1:4173/';
const OUT = path.resolve(process.argv[2] || 'shots');
const DEVICES = (process.argv[3] || 'desktop,tablet,phone').split(',');
const SCALE = Number(process.argv[4] || 2);
const SIZES = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 768, height: 1024 },
  phone: { width: 390, height: 844 },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wipe(page) {
  await page.evaluate(async () => {
    const { models } = await (await fetch('/api/models')).json();
    for (const m of models) await fetch(`/api/models/${m.id}`, { method: 'DELETE' });
  });
}

async function run(browser, device) {
  // reduced motion: no reveal, no camera tweens, no auto-rotate, so software WebGL goes idle
  // between states and every screenshot gets its frame
  const ctx = await browser.newContext({ viewport: SIZES[device], deviceScaleFactor: SCALE, hasTouch: device === 'phone', reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const shot = async (name) => {
    await sleep(350);
    const file = path.join(OUT, `${device}-${name}.${process.env.FORMA_SHOT_EXT || 'jpg'}`);
    await page.screenshot({ path: file, type: file.endsWith('.png') ? 'png' : 'jpeg', quality: file.endsWith('.png') ? undefined : 88, timeout: 120000 });
    console.log('  ', path.basename(file));
  };
  const count = () => page.evaluate(() => document.querySelectorAll('.history-row').length);
  const waitDone = async (n) => {
    await page.waitForFunction((k) => {
      const p = document.querySelector('.progress');
      return document.querySelectorAll('.history-row').length > k && p && p.hidden;
    }, n, { timeout: 60000, polling: 200 });
    await sleep(2600); // the reveal builds the model up from the bed
  };
  const blur = () => page.evaluate(() => document.activeElement?.blur());

  await page.goto(BASE + 'api/health');
  await wipe(page);
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('forma:reviewImage', 'true');
    localStorage.setItem('forma:autoRotate', 'false');
  });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await sleep(1600);
  await shot('empty');

  // the preview image to approve
  if (device === 'phone') await page.waitForSelector('.panel-left.is-open');
  await page.fill('#prompt', 'Vaso a collo stretto con la pancia morbida');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.draft:not([hidden]) .draft-image:not([hidden])', { timeout: 20000 });
  await sleep(500);
  await shot('draft');

  // a job frozen halfway through the 3D stage, with the starting image
  const n0 = await count();
  await page.route('**/api/jobs/**', async (route) => {
    const res = await route.fetch();
    const job = await res.json();
    job.status = 'running';
    job.stage = 'shape';
    job.progress = 0.47;
    job.message = 'Pixal3D genera la forma · campionamento 7/12';
    job.result = null;
    job.model_id = null;
    job.stages = job.stages.map((s) => ({
      ...s,
      status: s.key === 'image' ? 'done' : s.key === 'shape' ? 'active' : 'pending',
      progress: s.key === 'image' ? 1 : s.key === 'shape' ? 0.6 : 0,
    }));
    await route.fulfill({ response: res, json: job });
  });
  await page.click('.draft-actions .btn-primary');
  await page.waitForSelector('.progress:not([hidden])');
  await sleep(1400);
  await shot('generating');
  await page.unroute('**/api/jobs/**');
  await waitDone(n0);
  await blur();
  await shot('ready');

  await page.keyboard.press('o');
  await sleep(500);
  await shot('overhang');
  await page.keyboard.press('o');

  // the guided tour: at the report on desktop, at the prompt on smaller screens
  await page.click(device === 'desktop' ? '.topbar .tour-start' : '.tabbar .tour-start');
  await page.waitForSelector('.tour:not([hidden])');
  for (let i = 0; i < (device === 'desktop' ? 5 : 1); i++) await page.keyboard.press('ArrowRight');
  await sleep(1200);
  await shot('tour');
  await page.keyboard.press('Escape');
  await sleep(400);

  if (device === 'desktop') {
    // the print panel further down: materials, size and the bed-fit check
    await page.evaluate(() => {
      const el = document.querySelector('.panel-right');
      const t = document.querySelector('.print-view .block:nth-child(3)');
      if (el && t) el.scrollTop = t.offsetTop - 8;
    });
    await sleep(300);
    await shot('materials');
    await page.evaluate(() => { const el = document.querySelector('.panel-right'); if (el) el.scrollTop = 0; });

    // a hollowed sphere cut open
    await page.click('.switch-row:has-text("Svuota")');
    const n1 = await count();
    await page.fill('#prompt', 'Sfera liscia');
    await page.click('.review-row'); // straight to 3D
    await page.keyboard.press('Control+Enter');
    await waitDone(n1);
    await blur();
    await page.keyboard.press('c');
    await page.waitForSelector('.section-panel:not([hidden])');
    await page.fill('.section-panel .range', '55');
    await sleep(500);
    await shot('section');
    await page.keyboard.press('Escape');
    // back to the vase
    await page.keyboard.press('h');
    await page.locator('.history-open').nth(1).click();
    await sleep(2600);
    await page.keyboard.press('h');
  }

  // sculpting, with a stroke already made
  await blur();
  await page.keyboard.press('e');
  // on tablets and phones the tools wait in a closed sheet: the view is not "visible"
  await page.waitForFunction(() => document.querySelector('.edit-view')?.hidden === false);
  const box = await page.locator('.viewport-canvas').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height * 0.42;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(cx + i * 4, cy - i * 2);
  await page.mouse.up();
  await page.mouse.move(cx + 8, cy + 30);
  await sleep(1500); // software WebGL keeps the main thread busy: let the panel settle
  await shot('edit');

  if (errors.length) console.log('   page errors:', errors.join(' | '));
  await ctx.close();
}

(async () => {
  if (process.env.FORMA_E2E !== '1') {
    console.error('Set FORMA_E2E=1: this script deletes every model on the server.');
    process.exit(2);
  }
  const probe = await (await fetch(new URL('api/providers', BASE))).json();
  if (probe.default !== 'procedural') {
    console.error('The backend is not on the offline provider: refusing to wipe it.');
    process.exit(2);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  for (const d of DEVICES) {
    console.log(d);
    await run(browser, d);
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });

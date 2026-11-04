// End-to-end checks of Forma's main flows in Chromium (Playwright), against a running backend
// on the offline provider. Run it with `make e2e`: it starts both servers on throwaway data.
// It DELETES every model it finds, so it refuses to run unless FORMA_E2E=1 and the backend's
// default provider is "procedural" (the e2e setup), never against your real history.
const { chromium } = require('playwright');
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const URL = 'http://127.0.0.1:4173/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const step = async (name, fn) => {
  const t = Date.now();
  try { await fn(); results.push(`PASS ${name} (${Date.now() - t} ms)`); }
  catch (e) { results.push(`FAIL ${name}: ${e.message.replace(/\s+/g, ' ').slice(0, 260)}`); }
};

(async () => {
  if (process.env.FORMA_E2E !== '1') {
    console.error('Set FORMA_E2E=1 (make e2e does): this suite deletes every model on the server.');
    process.exit(2);
  }
  const probe = await (await fetch('http://127.0.0.1:8000/api/providers')).json();
  if (probe.default !== 'procedural') {
    console.error('The backend is not the e2e one (default provider is not procedural): refusing to wipe it.');
    process.exit(2);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forma-e2e-'));
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(URL + 'api/health');
  await page.evaluate(async () => {
    const { models } = await (await fetch('/api/models')).json();
    for (const m of models) await fetch(`/api/models/${m.id}`, { method: 'DELETE' });
  });
  await page.goto(URL, { waitUntil: 'networkidle' });
  await sleep(800);
  const text = (sel) => page.locator(sel).first().innerText();
  const blur = () => page.evaluate(() => document.activeElement?.blur());
  // Playwright does not await an async predicate (a Promise is truthy): keep it synchronous.
  // Done = one more row in the (rendered) history list AND the progress card closed.
  const count = () => page.evaluate(() => document.querySelectorAll('.history-row').length);
  let baseline = 0;
  const arm = async () => { baseline = await count(); };
  const waitDone = () => page.waitForFunction((n) => {
    const p = document.querySelector('.progress');
    return document.querySelectorAll('.history-row').length > n && p && p.hidden;
  }, baseline, { timeout: 30000, polling: 200 }).then(() => sleep(300));

  await step('first run: empty bed, prompt focused, no download', async () => {
    assert.match(await text('.stage-empty'), /Il piatto è vuoto/);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'prompt');
    assert.equal(await page.isVisible('.btn-download'), false);
  });

  await step('preview image first: approve, or ask for another', async () => {
    await page.fill('#prompt', 'Vaso a collo stretto con la pancia morbida');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.draft:not([hidden]) .draft-image:not([hidden])', { timeout: 15000 });
    assert.match(await text('.topbar .pill'), /Immagine da approvare/i);
    const first = await page.getAttribute('.draft-image', 'src');
    await page.click('.draft-actions .btn-secondary'); // another image
    await page.waitForFunction((src) => { const i = document.querySelector('.draft-image'); return i && !i.hidden && i.getAttribute('src') !== src; }, first, { timeout: 15000 });
    await arm();
    await page.click('.draft-actions .btn-primary'); // make the 3D model
    await waitDone();
    const models = await page.evaluate(async () => (await (await fetch('/api/models')).json()).models);
    assert.equal(models[0].kind, 'text');
    assert.match(models[0].prompt, /Vaso/);
    // turn the review off for the rest of the run
    await page.click('.review-row');
    assert.equal(await page.isChecked('.review-row .switch'), false);
    // back to a first run (the choice to skip the review is remembered)
    await page.evaluate(async () => {
      const { models } = await (await fetch('/api/models')).json();
      for (const m of models) await fetch(`/api/models/${m.id}`, { method: 'DELETE' });
    });
    await page.reload({ waitUntil: 'networkidle' });
    await sleep(800);
    assert.equal(await page.isChecked('.review-row .switch'), false);
  });

  await step('empty prompt explains instead of failing', async () => {
    await page.click('.prompt-foot .btn');
    await page.waitForSelector('.toast', { timeout: 3000 });
    assert.match(await text('.toast'), /Scrivi cosa vuoi stampare/);
  });

  await step('generate from text: stages, model, report, status', async () => {
    await arm();
    await page.fill('#prompt', 'Pedone degli scacchi in stile classico');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.progress:not([hidden])', { timeout: 5000 });
    await waitDone();
    assert.match(await text('.object-name'), /Pedone/);
    assert.match(await text('.topbar .pill'), /Pronto da stampare|Servono supporti/i);
    assert.match(await text('.kv'), /Chiusa e valida/);
    assert.ok(await page.isVisible('.btn-download'));
  });

  await step('filament swatch recolours the data hue', async () => {
    const css = (name) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
    await page.click('.swatch[data-key="azzurro"]');
    assert.equal(await css('--filament'), '#47b2ef');
    assert.notEqual(await css('--data'), '#47b2ef'); // darkened for contrast on the ivory paper
    assert.match(await text('.label-row'), /PLA Azzurro/);
    await page.click('.swatch[data-key="blu"]');
    assert.equal(await css('--data'), '#2c63d8'); // already reads on the paper: kept as it is
  });

  await step('printer change re-judges the fit; oversize suggests the max', async () => {
    await page.selectOption('#printer', 'prusa-mk4');
    await page.fill('.size-row .num-input', '300');
    await page.locator('.size-row .num-input').press('Tab');
    await sleep(200);
    assert.match(await text('.fit-line'), /Al massimo 220,0 mm/);
    await page.click('.fit-text .btn');
    assert.equal(await page.inputValue('.size-row .num-input'), '220');
    assert.match(await text('.fit-line'), /Entra/);
  });

  await step('apply re-runs the pipeline at the new size', async () => {
    await page.click('.apply-row .btn');
    await page.waitForFunction(() => /Applicate/.test(document.querySelector('.apply-row .meta')?.textContent || ''), null, { timeout: 30000 });
    assert.match(await text('.kv'), /220,0 mm/);
  });

  await step('second model and history switching', async () => {
    await arm();
    await page.fill('#prompt', 'Ingranaggio da 18 denti con mozzo');
    await page.keyboard.press('Enter');
    await waitDone();
    await blur();
    await page.keyboard.press('h');
    await page.waitForSelector('#view-history:not([hidden])');
    assert.equal(await page.locator('.history-row').count(), 2);
    await page.locator('.history-open').nth(1).click();
    await page.waitForFunction(() => /Pedone/.test(document.querySelector('.object-name')?.textContent || ''));
    await page.keyboard.press('h');
  });

  await step('sculpt: stroke, undo, redo, repair as a new model', async () => {
    await blur();
    await page.keyboard.press('e');
    await page.waitForSelector('.edit-view:not([hidden])');
    const box = await page.locator('.viewport-canvas').boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height * 0.45;
    await page.mouse.move(cx, cy); await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(cx + i * 3, cy - i * 3);
    await page.mouse.up();
    assert.match(await text('.undo-row .meta'), /1 modifica/);
    assert.match(await text('.topbar .pill'), /Modifiche da riparare/i);
    assert.equal(await page.getAttribute('.btn-download', 'aria-disabled'), 'true');
    await page.keyboard.press('Control+z');
    assert.match(await text('.undo-row .meta'), /Nessuna modifica/);
    await page.keyboard.press('Control+Shift+z');
    assert.match(await text('.undo-row .meta'), /1 modifica/);
    await page.keyboard.press('s'); // smooth tool
    assert.equal(await page.getAttribute('.tool[aria-checked="true"]', 'title'), 'Leviga · S');
    await page.keyboard.press(']');
    await page.click('.finish .btn-primary');
    await page.waitForFunction(() => document.querySelector('.edit-view')?.hidden === true, null, { timeout: 30000 });
    await page.waitForSelector('.toast-positive', { timeout: 10000 });
    const models = await page.evaluate(async () => (await (await fetch('/api/models')).json()).models);
    assert.equal(models.length, 3);
    assert.equal(models[0].kind, 'edit');
    assert.ok(models[0].parent_id);
    assert.ok(models[0].report.watertight);
  });

  await step('material, infill and price change the estimate', async () => {
    const before = await text('.spool-text');
    await page.click('.material-grid ~ * .seg, .print-view .segmented .seg >> text=PETG');
    await page.selectOption('#infill', '0.4');
    await page.fill('#price', '30');
    await page.locator('#price').press('Tab');
    await sleep(200);
    const after = await text('.spool-text');
    assert.notEqual(before, after);
    assert.match(after, /di PETG/);
    assert.match(after, /€/);
    assert.match(await text('.kv'), /Copie per piatto/);
  });

  await step('overhang map and section view', async () => {
    await blur();
    await page.keyboard.press('o');
    await page.waitForSelector('.legend:not([hidden])');
    assert.match(await text('.legend'), /Sbalzi oltre 45°|Nessuno sbalzo/);
    await page.keyboard.press('c');
    await page.waitForSelector('.section-panel:not([hidden])');
    await page.fill('.section-panel .range', '30');
    assert.match(await text('.section-panel .value'), /mm/);
    await page.keyboard.press('Escape');
    assert.equal(await page.isVisible('.section-panel'), false);
    await page.keyboard.press('o');
    assert.equal(await page.isVisible('.legend'), false);
  });

  await step('"Meno supporti" re-orients and reports it', async () => {
    await page.click('.segmented-grid .seg >> text=Meno supporti');
    await page.click('.apply-row .btn');
    await page.waitForFunction(() => /Applicate/.test(document.querySelector('.apply-row .meta')?.textContent || ''), null, { timeout: 30000 });
    const models = await page.evaluate(async () => (await (await fetch('/api/models')).json()).models);
    const current = models.find((m) => m.settings.orientation === 'supports');
    assert.ok(current, 'a model prepared with orientation=supports');
  });

  await step('any mesh file is repaired and prepared as a new model', async () => {
    const href = await page.getAttribute('.btn-download', 'href');
    const stl = await page.evaluate(async (u) => {
      const id = u.split('/').pop().split('?')[0];
      const r = await fetch(`/api/export/${id}?format=stl`);
      return Array.from(new Uint8Array(await r.arrayBuffer()));
    }, href);
    const file = path.join(tmp, 'pezzo-da-riparare.stl');
    fs.writeFileSync(file, Buffer.from(stl));
    await arm();
    await page.setInputFiles('input[type="file"]', file);
    await page.waitForSelector('.toast-positive', { timeout: 30000 });
    const models = await page.evaluate(async () => (await (await fetch('/api/models')).json()).models);
    assert.equal(models[0].kind, 'upload');
    assert.match(await text('.object-name'), /Pezzo da riparare/i);
  });

  await step('shortcuts overlay opens and closes; space and F do not break', async () => {
    await page.keyboard.press('?');
    await page.waitForSelector('.scrim:not([hidden])');
    assert.match(await text('.dialog'), /Scorciatoie da tastiera/);
    await page.keyboard.press('Escape');
    assert.equal(await page.isVisible('.scrim'), false);
    const before = await page.getAttribute('.view-tools .icon-btn:nth-child(2)', 'aria-pressed');
    await page.locator('.viewport-canvas').click({ position: { x: 20, y: 20 } });
    await page.keyboard.press(' ');
    const after = await page.getAttribute('.view-tools .icon-btn:nth-child(2)', 'aria-pressed');
    assert.notEqual(before, after);
    await page.keyboard.press('f');
    await page.keyboard.press('/');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'prompt');
  });

  await step('download link serves a 3MF with a meaningful name', async () => {
    const href = await page.getAttribute('.btn-download', 'href');
    const res = await page.evaluate(async (u) => { const r = await fetch(u); return { s: r.status, cd: r.headers.get('content-disposition'), n: (await r.arrayBuffer()).byteLength }; }, href);
    assert.equal(res.s, 200);
    assert.match(res.cd, /attachment; filename="[a-z0-9-]+-\d+mm\.3mf"/);
    assert.ok(res.n > 1000);
  });

  await step('rename from the top bar: Enter saves and names the files, Esc cancels', async () => {
    await page.click('.object-name-btn');
    await page.waitForSelector('.object-name-input:not([hidden])');
    await page.fill('.object-name-input', 'Pezzo di prova');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.object-name-text')?.textContent === 'Pezzo di prova');
    const res = await page.evaluate(async () => {
      const { models } = await (await fetch('/api/models')).json();
      const r = await fetch(models[0].urls.export.stl);
      return { title: models[0].title, cd: r.headers.get('content-disposition') };
    });
    assert.equal(res.title, 'Pezzo di prova');
    assert.match(res.cd, /filename="pezzo-di-prova-\d+mm\.stl"/);
    assert.match(await text('.file-name'), /pezzo-di-prova-\d+mm\.3mf/);
    await page.click('.object-name-btn');
    await page.fill('.object-name-input', 'Nome da scartare');
    await page.keyboard.press('Escape');
    assert.equal(await page.isVisible('.object-name-input'), false);
    assert.equal(await text('.object-name-text'), 'Pezzo di prova');
    assert.equal(await page.evaluate(() => document.activeElement?.className), 'object-name-btn');
  });

  await step('quick views (1-4, buttons) and wireframe (W) change the view', async () => {
    await blur();
    const shot = () => page.locator('.viewport-canvas').screenshot();
    const pressed = () => page.evaluate(() => Array.from(document.querySelectorAll('.preset[aria-pressed="true"]')).map((b) => b.dataset.view));
    await page.keyboard.press('1');
    await sleep(900);
    assert.deepEqual(await pressed(), ['front']);
    const front = await shot();
    await page.keyboard.press('3');
    await sleep(900);
    assert.deepEqual(await pressed(), ['top']);
    const top = await shot();
    assert.ok(!front.equals(top), 'the top view looks different from the front view');
    await page.click('.preset[data-view="iso"]');
    await sleep(900);
    assert.deepEqual(await pressed(), ['iso']);
    await page.keyboard.press('w');
    await sleep(200);
    assert.equal(await page.getAttribute('.view-tools .icon-btn:nth-child(5)', 'aria-pressed'), 'true');
    const wired = await shot();
    await page.keyboard.press('w');
    await sleep(200);
    assert.equal(await page.getAttribute('.view-tools .icon-btn:nth-child(5)', 'aria-pressed'), 'false');
    assert.ok(!wired.equals(await shot()), 'the wireframe draws the triangles');
    // orbiting by hand leaves the quick views
    const box = await page.locator('.viewport-canvas').boundingBox();
    await page.mouse.move(box.x + 60, box.y + box.height - 60);
    await page.mouse.down();
    await page.mouse.move(box.x + 160, box.y + box.height - 80, { steps: 6 });
    await page.mouse.up();
    assert.deepEqual(await pressed(), []);
  });

  await step('flat bottom: cut, applied and reported, with the new report rows', async () => {
    await page.click('.switch-row:has-text("Base piana")');
    await page.waitForSelector('.sub-row:has-text("Taglio dal fondo")');
    assert.equal(await page.inputValue('.sub-row:has-text("Taglio dal fondo") input'), '2');
    await page.click('.apply-row .btn');
    await page.waitForFunction(() => /Applicate/.test(document.querySelector('.apply-row .meta')?.textContent || ''), null, { timeout: 30000 });
    const m = await page.evaluate(async () => (await (await fetch('/api/models')).json()).models[0]);
    assert.equal(m.settings.flat_bottom_mm, 2);
    assert.ok(m.report.repairs.some((x) => /fondo tagliato in piano|base piana saltata/.test(x)), m.report.repairs.join(' | '));
    const kv = await text('.kv');
    assert.match(kv, /Appoggio sul piatto/);
    assert.match(kv, /Parti sotto 0,8 mm/);
    await page.click('.switch-row:has-text("Base piana")'); // off again for the next models
    assert.equal(await page.isVisible('.sub-row:has-text("Taglio dal fondo")'), false);
  });

  await step('a photo pasted anywhere becomes the input; a mesh dropped anywhere is repaired', async () => {
    await blur();
    await page.evaluate(async () => {
      const { models } = await (await fetch('/api/models')).json();
      const blob = await (await fetch(models[0].urls.thumb)).blob();
      const dt = new DataTransfer();
      dt.items.add(new File([blob], 'appunti.png', { type: 'image/png' }));
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
    });
    await page.waitForSelector('.photo-chip');
    assert.match(await text('.toasts'), /Foto pronta/);
    await page.click('.photo-chip .icon-btn');
    await arm();
    await page.evaluate(async () => {
      const { models } = await (await fetch('/api/models')).json();
      const blob = await (await fetch(models[0].urls.export.stl)).blob();
      const dt = new DataTransfer();
      dt.items.add(new File([blob], 'trascinato.stl', { type: 'model/stl' }));
      window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
    });
    assert.equal(await page.isVisible('.drop-overlay'), true);
    await page.evaluate(async () => {
      const { models } = await (await fetch('/api/models')).json();
      const blob = await (await fetch(models[0].urls.export.stl)).blob();
      const dt = new DataTransfer();
      dt.items.add(new File([blob], 'trascinato.stl', { type: 'model/stl' }));
      document.querySelector('.drop-overlay').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    assert.equal(await page.isVisible('.drop-overlay'), false);
    await page.waitForFunction((n) => document.querySelectorAll('.history-row').length > n, baseline, { timeout: 30000 });
    const models = await page.evaluate(async () => (await (await fetch('/api/models')).json()).models);
    assert.equal(models[0].kind, 'upload');
    assert.match(models[0].prompt, /trascinato/);
  });

  await step('the preview card shows the English prompt sent to the image model', async () => {
    await page.click('.review-row'); // review on again
    const thumb = await page.evaluate(async () => (await (await fetch('/api/models')).json()).models[0].urls.thumb);
    await page.route('**/api/image', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({
      draft_id: 'd', url: thumb, prompt: 'Gatto seduto', prompt_en: 'A sitting cat', seed: 1, provider: 'procedural' }) }));
    await page.fill('#prompt', 'Gatto seduto');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.draft:not([hidden]) .draft-en:not([hidden])', { timeout: 8000 });
    assert.match(await text('.draft-en'), /A sitting cat/);
    await page.unroute('**/api/image');
    await blur();
    await page.keyboard.press('Escape');
    assert.equal(await page.isVisible('.draft'), false);
    await page.click('.review-row'); // and off
  });

  await step('photo upload generates from an image', async () => {
    const thumb = await page.evaluate(async () => {
      const { models } = await (await fetch('/api/models')).json();
      const r = await fetch(models[0].urls.thumb);
      return Array.from(new Uint8Array(await r.arrayBuffer()));
    });
    const png = path.join(tmp, 'foto.png');
    fs.writeFileSync(png, Buffer.from(thumb));
    await page.setInputFiles('input[type="file"]', png);
    await page.waitForSelector('.photo-chip');
    await arm();
    await page.fill('#prompt', '');
    await page.click('.prompt-foot .btn');
    await waitDone();
    const models = await page.evaluate(async () => (await (await fetch('/api/models')).json()).models);
    assert.equal(models[0].kind, 'image');
    await page.click('.photo-chip .icon-btn');
    assert.equal(await page.isVisible('.photo-chip'), false);
  });

  await step('a failed job shows the error in the panel with Riprova', async () => {
    await page.route('**/api/jobs/**', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({
      id: 'x', status: 'error', stage: 'shape', message: 'Quota GPU gratuita di Hugging Face esaurita per TencentARC/Pixal3D.', progress: 0.3,
      stages: [{ key: 'image', label: 'Immagine', status: 'done', progress: 1, message: '' }, { key: 'shape', label: 'Forma 3D', status: 'error', progress: 0.2, message: '' }, { key: 'repair', label: 'Riparazione', status: 'pending', progress: 0, message: '' }, { key: 'ready', label: 'Pronto', status: 'pending', progress: 0, message: '' }],
      error: 'Quota GPU gratuita di Hugging Face esaurita per TencentARC/Pixal3D. Aggiungi HF_TOKEN.', model_id: null, image_url: null, prompt: 'x', provider: 'hf_remote', model: 'pixal3d', created_at: 0, result: null }) }));
    await page.fill('#prompt', 'Razzo spaziale con tre alette');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.progress-actions:not([hidden])', { timeout: 8000 });
    assert.match(await text('.progress-message'), /Quota GPU/);
    assert.match(await text('.topbar .pill'), /Non riuscito/i);
    await page.unroute('**/api/jobs/**');
    await arm();
    await page.click('.progress-actions .btn-primary'); // Riprova, now against the real backend
    await waitDone();
    assert.match(await text('.object-name'), /Razzo/);
  });

  await step('delete from history asks once, then removes', async () => {
    await blur();
    await page.keyboard.press('h');
    const n = await page.locator('.history-row').count();
    const del = page.locator('.history-row').first().locator('.history-delete');
    await page.locator('.history-row').first().hover();
    await del.click();
    assert.match(await del.innerText(), /Elimina\?/);
    await del.click();
    await page.waitForFunction((k) => document.querySelectorAll('.history-row').length === k - 1, n);
  });

  results.push(`page errors: ${errors.length ? errors.join(' | ') : 'none'}`);
  console.log(results.join('\n'));
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(results.some((r) => r.startsWith('FAIL')) || errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

// smoke-workflow.js — Playwright validator for the new Setup flow.
//
// Goal: prove that a non-programmer can walk through the 3 steps
// (drop face photo → write script → click Make my trailer) without
// seeing a console error, an undefined function, or a 3x retry storm.
//
// Run:   cd /workspace/curtis-image-gen
//        NODE_PATH=/usr/local/lib/node_modules node smoke-workflow.js

const { chromium, devices } = require('playwright');

const CHROME = '/root/.cache/ms-playwright/chromium-1223/chrome-linux/chrome';
const URL = 'https://curtis-image-gen.onrender.com/?t=' + Date.now();

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();

  let pageErrors = 0;
  let consoleErrors = 0;
  page.on('pageerror', e => { pageErrors++; console.log('  [PAGEERROR]', e.message); });
  page.on('console', m => {
    if(m.type() === 'error' && !m.text().includes('Failed to load resource')){
      consoleErrors++;
      console.log('  [console.error]', m.text().slice(0, 200));
    }
  });

  // ----- 1. Load -----
  console.log(`=== loading ${URL} ===`);
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(2500);

  // 1a. Initial banner
  const initialBanner = await page.evaluate(() => {
    const b = document.getElementById('setupBanner');
    return b ? { text: b.textContent.trim().slice(0, 150), cls: b.className } : null;
  });
  console.log('  initial banner:', JSON.stringify(initialBanner));
  if(!initialBanner || !initialBanner.text.includes('photo')){
    throw new Error('Initial banner should mention dropping a face photo. Got: ' + JSON.stringify(initialBanner));
  }

  // 1b. Provider dropdown NOT on Setup
  const providerOnSetup = await page.evaluate(() => {
    const setup = document.querySelector('.panel[data-tab="setup"]');
    return !!setup?.querySelector('#provider');
  });
  console.log('  provider dropdown on Setup tab:', providerOnSetup, '(should be false)');
  if(providerOnSetup) throw new Error('Provider dropdown should be on Settings, not Setup');

  // 1c. Make my trailer button
  const makeBtn = await page.evaluate(() => {
    const el = document.getElementById('makeTrailerBtn');
    return el ? { text: el.textContent.trim(), disabled: el.disabled } : null;
  });
  console.log('  Make my trailer button:', JSON.stringify(makeBtn));
  if(!makeBtn) throw new Error('Make my trailer button missing');
  if(makeBtn.disabled) throw new Error('Make my trailer should not start disabled');

  // ----- 2. Click Make my trailer with no ref / no script -----
  console.log('=== clicking Make my trailer (no reference, no script) ===');
  await page.evaluate(() => document.getElementById('makeTrailerBtn').click());
  await page.waitForTimeout(800);
  const bannerAfterNoRef = await page.evaluate(() => {
    const b = document.getElementById('setupBanner');
    return b ? { text: b.textContent.trim().slice(0, 200), cls: b.className } : null;
  });
  console.log('  banner after no-ref click:', JSON.stringify(bannerAfterNoRef));
  // The button now validates input first; with no ref and no script
  // it should show a clear error banner ("No scenes yet" or similar),
  // not silently no-op. The new makeTrailer behavior is correct.
  if(!bannerAfterNoRef || !bannerAfterNoRef.text.match(/scenes|reference|script|photo/i)) {
    throw new Error('Banner should mention missing input. Got: ' + JSON.stringify(bannerAfterNoRef));
  }
  if(!bannerAfterNoRef.cls.includes('bad')) {
    throw new Error('Banner should be marked bad (red) on validation error. Got: ' + bannerAfterNoRef.cls);
  }
  await page.screenshot({ path: '/tmp/wf-1-no-ref.png' });

  // ----- 3. Add a reference URL and click again -----
  console.log('=== adding a reference URL ===');
  await page.evaluate(() => {
    const inp = document.getElementById('refUrl');
    inp.value = 'https://example.com/face.jpg';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(600);
  await page.evaluate(() => document.getElementById('makeTrailerBtn').click());
  await page.waitForTimeout(800);
  const bannerAfterRef = await page.evaluate(() => {
    const b = document.getElementById('setupBanner');
    return b ? { text: b.textContent.trim().slice(0, 200), cls: b.className } : null;
  });
  console.log('  banner after ref-only click:', JSON.stringify(bannerAfterRef));
  if(!bannerAfterRef || !bannerAfterRef.text.toLowerCase().includes('script')) {
    throw new Error('Banner should advance to Step 2 (write a script). Got: ' + JSON.stringify(bannerAfterRef));
  }
  await page.screenshot({ path: '/tmp/wf-2-ref.png' });

  // ----- 4. Add a script and parse -----
  console.log('=== adding a script and parsing ===');
  await page.evaluate(() => {
    const ta = document.getElementById('script');
    ta.value = 'A cat in a jungle.\n---\nA dog on a log.\n---\nA bird at dawn.';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => document.getElementById('parseBtn').click());
  await page.waitForTimeout(800);
  const log = await page.evaluate(() => {
    const l = document.getElementById('log');
    return l ? l.textContent.trim().slice(-300) : '';
  });
  console.log('  log tail:', log);
  if(!log.includes('Parsed 3 scene')) {
    throw new Error('Expected "Parsed 3 scene(s)" in log. Got: ' + log);
  }
  const gallery = await page.evaluate(() => ({
    scenes: document.querySelectorAll('#scenes .scene').length,
    gallery: document.querySelectorAll('#gallery > *').length,
  }));
  console.log('  scene cards:', gallery.scenes, '(should be 3)');
  if(gallery.scenes < 3) throw new Error('Expected 3 scene cards, got ' + gallery.scenes);
  await page.screenshot({ path: '/tmp/wf-3-scenes.png' });

  // ----- 5. Final banner shows "Ready" -----
  const finalBanner = await page.evaluate(() => {
    const b = document.getElementById('setupBanner');
    return b ? { text: b.textContent.trim().slice(0, 200), cls: b.className } : null;
  });
  console.log('  final banner:', JSON.stringify(finalBanner));
  if(!finalBanner || !finalBanner.text.toLowerCase().includes('ready')) {
    throw new Error('Final banner should say "Ready" with N scenes. Got: ' + JSON.stringify(finalBanner));
  }
  await page.screenshot({ path: '/tmp/wf-4-ready.png' });

  // ----- 6. Settings tab loads without error -----
  console.log('=== checking Settings tab ===');
  await page.evaluate(() => {
    const tab = document.querySelector('[data-tab="settings"]') ||
                document.querySelectorAll('.tab, .tab-btn, button')[0];
  });
  // Just navigate via JS by toggling the panel class
  await page.evaluate(() => {
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    document.querySelector('.panel[data-tab="settings"]').classList.add('active');
  });
  await page.waitForTimeout(500);
  const settingsFields = await page.evaluate(() => ({
    a2eKey: !!document.getElementById('openaiKeyA2E'),
    a2eImgModel: !!document.getElementById('a2eImgModel'),
    openaiKey: !!document.getElementById('openaiKey'),
    openaiDefaultModel: !!document.getElementById('openaiDefaultModel'),
    geminiKey: !!document.getElementById('geminiKey'),
  }));
  console.log('  Settings fields present:', JSON.stringify(settingsFields));
  const missing = Object.entries(settingsFields).filter(([k, v]) => !v).map(([k]) => k);
  if(missing.length) throw new Error('Settings tab missing fields: ' + missing.join(', '));
  await page.screenshot({ path: '/tmp/wf-5-settings.png' });

  // ----- 7. Tally errors -----
  console.log('');
  console.log('=== RESULT ===');
  console.log('  pageErrors:    ', pageErrors);
  console.log('  consoleErrors: ', consoleErrors);
  if(pageErrors > 0) throw new Error('Got ' + pageErrors + ' page errors during the workflow walk');
  if(consoleErrors > 0) throw new Error('Got ' + consoleErrors + ' console errors during the workflow walk');

  console.log('  ✓ Workflow walk succeeded end-to-end.');

  await browser.close();
  process.exit(0);
})().catch(e => {
  console.error('SMOKE FAIL:', e.message);
  process.exit(1);
});

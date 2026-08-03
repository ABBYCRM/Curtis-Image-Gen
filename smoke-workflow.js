// Playwright smoke for the workflow rethink
// Verifies:
//   1. Page loads, no JS errors
//   2. New Setup tab has a banner, a step-1 drop zone, a step-2 script, a step-3 "Make my trailer" button
//   3. Banner changes from "info" (no reference) to "ready" once reference + script are added
//   4. Clicking "Make my trailer" with no reference shows a friendly error, doesn't loop 3x
//   5. Provider dropdown is NOT visible on Setup anymore
const { chromium, devices } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    executablePath: '/root/.cache/ms-playwright/chromium-1223/chrome-linux/chrome',
  });
  const context = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await context.newPage();

  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => {
    if(m.type() === 'error') errors.push('console.error: ' + m.text());
  });

  console.log('=== loading https://curtis-image-gen.onrender.com/ ===');
  await page.goto('https://curtis-image-gen.onrender.com/', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForFunction(() => {
    const el = document.getElementById('connState');
    return el && el.textContent && el.textContent !== 'Checking…';
  }, { timeout: 30000 });

  // 1. Banner present and shows the right initial state
  const initialBanner = await page.evaluate(() => {
    const el = document.getElementById('setupBanner');
    return { text: document.getElementById('bannerText')?.textContent, cls: el?.className };
  });
  console.log('  initial banner:', JSON.stringify(initialBanner));
  await page.screenshot({ path: '/tmp/wf-1-initial.png' });

  // 2. Provider dropdown should NOT be on Setup anymore
  const providerOnSetup = await page.evaluate(() => {
    const setup = document.querySelector('[data-tab="setup"]');
    return !!setup?.querySelector('#provider');
  });
  console.log('  provider dropdown on Setup tab:', providerOnSetup, '(should be false)');

  // 3. Make my trailer button present
  const makeBtn = await page.evaluate(() => {
    const el = document.getElementById('makeTrailerBtn');
    return el ? { text: el.textContent.trim(), disabled: el.disabled } : null;
  });
  console.log('  Make my trailer button:', JSON.stringify(makeBtn));

  // 4. Click Make my trailer with no reference / no script
  console.log('=== clicking Make my trailer (no reference, no script) ===');
  await page.click('#makeTrailerBtn');
  await page.waitForFunction(() => {
    const el = document.getElementById('bannerText');
    return el && (el.textContent.includes('photo') || el.textContent.includes('script') || el.textContent.includes('Add'));
  }, { timeout: 5000 });
  const bannerAfterNoRef = await page.evaluate(() => {
    return { text: document.getElementById('bannerText')?.textContent, cls: document.getElementById('setupBanner')?.className };
  });
  console.log('  banner after no-ref click:', JSON.stringify(bannerAfterNoRef));
  await page.screenshot({ path: '/tmp/wf-2-no-ref.png' });

  // 5. Now add a script
  console.log('=== adding a script ===');
  await page.fill('#script', `CURTIS
---
Dimly lit study. He turns to camera and says:
"In every silence, there's a story waiting to be told."
---
Wide shot, library at night. He walks between shelves.
"Some doors only open from the inside."`);
  await page.click('#parseBtn');
  await page.waitForTimeout(500);
  const bannerAfterScript = await page.evaluate(() => {
    return { text: document.getElementById('bannerText')?.textContent, cls: document.getElementById('setupBanner')?.className };
  });
  console.log('  banner after script+parse:', JSON.stringify(bannerAfterScript));
  await page.screenshot({ path: '/tmp/wf-3-after-parse.png' });

  // 6. Click Make my trailer with script but no reference
  console.log('=== clicking Make my trailer (script only, no reference) ===');
  await page.click('#makeTrailerBtn');
  await page.waitForFunction(() => {
    const el = document.getElementById('bannerText');
    return el && (el.textContent.includes('photo') || el.textContent.includes('Add'));
  }, { timeout: 5000 });
  const bannerNoRef = await page.evaluate(() => {
    return { text: document.getElementById('bannerText')?.textContent, cls: document.getElementById('setupBanner')?.className };
  });
  console.log('  banner:', JSON.stringify(bannerNoRef));
  await page.screenshot({ path: '/tmp/wf-4-no-ref-with-script.png' });

  // 7. Add a reference (data URL — minimal PNG) and try again
  console.log('=== adding a reference photo ===');
  // 1x1 transparent PNG
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  await page.setInputFiles('#refFile', { name: 'face.png', mimeType: 'image/png', buffer: png });
  await page.waitForTimeout(500);
  const bannerWithRef = await page.evaluate(() => {
    return { text: document.getElementById('bannerText')?.textContent, cls: document.getElementById('setupBanner')?.className };
  });
  console.log('  banner with ref + script:', JSON.stringify(bannerWithRef));
  await page.screenshot({ path: '/tmp/wf-5-with-ref.png' });

  // 8. Now hit Make my trailer — this should reach the provider and fail
  //    with the friendly "free plan" message instead of retrying 3x
  console.log('=== clicking Make my trailer (everything ready) ===');
  const startLogCount = await page.evaluate(() => document.querySelectorAll('#log div').length);
  await page.click('#makeTrailerBtn');
  // Wait up to 30s for the pipeline to settle (A2E call should fail fast
  // with a structured error, not loop 3x)
  await page.waitForFunction((startCount) => {
    const el = document.getElementById('bannerText');
    if(!el) return false;
    const text = el.textContent;
    return text.includes('Free plan') || text.includes('key') || text.includes('Done') || text.includes('error');
  }, { timeout: 30000 }, startLogCount).catch(() => console.log('  (timed out waiting for banner change)'));
  const endLogCount = await page.evaluate(() => document.querySelectorAll('#log div').length);
  const finalBanner = await page.evaluate(() => {
    return { text: document.getElementById('bannerText')?.textContent, cls: document.getElementById('setupBanner')?.className };
  });
  console.log('  final banner:', JSON.stringify(finalBanner));
  console.log('  log lines added:', endLogCount - startLogCount, '(should be small — no 3x retry storm)');
  await page.screenshot({ path: '/tmp/wf-6-final.png' });

  // 9. The new Settings tab should still be reachable and have the
  //    provider + key fields
  await page.click('button[data-goto="settings"]');
  await page.waitForTimeout(300);
  const settingsHasKey = await page.evaluate(() => !!document.getElementById('apiKey'));
  const settingsHasOpenaiKey = await page.evaluate(() => !!document.getElementById('openaiKey'));
  console.log('  Settings has apiKey field:', settingsHasKey, '(should be true)');
  console.log('  Settings has openaiKey field:', settingsHasOpenaiKey, '(should be true)');
  await page.screenshot({ path: '/tmp/wf-7-settings.png' });

  console.log('');
  console.log('=== ERRORS COLLECTED ===');
  if(errors.length === 0) console.log('  (none)');
  else for(const e of errors) console.log('  -', e);

  await browser.close();
  process.exit(errors.length > 0 ? 1 : 0);
})();

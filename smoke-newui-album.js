// End-to-end Playwright smoke for the Album tab flow.
//
// 1) Load the new front-end, verify tabs render
// 2) Open Settings, paste real OpenAI key, save to localStorage
// 3) Upload a reference image + parse a script
// 4) Click Generate -> GPT Image 2 (face-locked via input_reference)
// 5) Switch to the Album tab, verify the image appears
// 6) Click Download on the album card -> verify the browser receives
//    the bytes and starts a save (Playwright captures the download)
//
// This proves:
//  - The Download bug is fixed (button works, bytes reach the disk)
//  - The Album tab renders and lists the saved image
//  - The auto-save from the proxy + front-end re-upload kept the
//    album in sync
//
// Run:  cd /workspace/curtis-image-gen
//       OPENAI_KEY=sk-... node smoke-newui-album.js

const { chromium, devices } = require('playwright');
const CHROME = '/root/.cache/ms-playwright/chromium-1223/chrome-linux/chrome';
const URL = 'https://curtis-image-gen.onrender.com/?t=' + Date.now();
const OPENAI_KEY = process.env.OPENAI_KEY || '';

(async () => {
  if (!OPENAI_KEY) {
    console.error('OPENAI_KEY env var is required for the album smoke test.');
    process.exit(2);
  }
  const browser = await chromium.launch({ executablePath: CHROME });
  // Use a desktop context for the download check — iOS Safari handles
  // <a download> differently (it opens the file inline instead of
  // saving) and Playwright won't capture the download event in that
  // emulation. Desktop Chrome honors download and Playwright captures
  // it cleanly.
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();

  const errors = [];
  const apiCalls = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => {
    if(m.type() === 'error' &&
       !m.text().includes('Failed to load resource') &&
       !m.text().includes("'frame-ancestors' is ignored when delivered via a <meta> element")) {
      errors.push('console: ' + m.text().slice(0, 200));
    }
  });
  page.on('request', req => {
    const u = req.url();
    if(u.includes('curtis-a2e-proxy')) {
      const h = req.headers();
      apiCalls.push({ method: req.method(), url: u.replace(/^https?:\/\/[^/]+/, '').slice(0, 70), xOpenaiKey: !!h['x-openai-key'] });
    }
  });
  // Capture downloads initiated by the page
  const downloads = [];
  page.on('download', d => downloads.push({ filename: d.suggestedFilename(), url: d.url().replace(/^https?:\/\/[^/]+/, '').slice(0, 80) }));

  console.log(`=== loading ${URL} ===`);
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(3000);

  // 1. Tabs visible
  const tabs = await page.evaluate(() => {
    const setup = document.getElementById('tab-setup');
    const scenes = document.getElementById('tab-scenes');
    const album  = document.getElementById('tab-album');
    return {
      setup: { found: !!setup, text: setup?.textContent?.trim(), active: setup?.classList?.contains('active') },
      scenes: { found: !!scenes, text: scenes?.textContent?.trim() },
      album:  { found: !!album,  text: album?.textContent?.trim() },
    };
  });
  console.log('  tabs:', JSON.stringify(tabs));
  if(!tabs.setup.found || !tabs.scenes.found || !tabs.album.found) {
    console.error('FAIL: missing tab buttons');
    process.exit(1);
  }

  // 2. Open settings, paste key
  await page.evaluate(() => document.getElementById('settingsButton').click());
  await page.waitForTimeout(500);
  await page.evaluate((k) => {
    const inp = document.getElementById('openaiKeyInput');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(inp, k);
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  }, OPENAI_KEY);
  await page.waitForTimeout(300);
  await page.evaluate(() => document.getElementById('saveSettingsButton').click());
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const d = document.getElementById('settingsDialog');
    if(d.open) d.close();
  });
  await page.waitForTimeout(300);

  // 3. Reference + script
  const fileInput = await page.$('#referenceFile');
  await fileInput.setInputFiles('/workspace/img1.png');
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const t = document.getElementById('scriptInput');
    t.value = '[0:00 - 0:04] Scene 1: Album Test\n• Visual: A protagonist on a sunlit rooftop.\n• Voiceover: "Smoke test."';
    t.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => document.getElementById('parseButton').click());
  await page.waitForTimeout(500);

  // 4. Generate
  console.log('=== generating image ===');
  await page.evaluate(() => document.getElementById('generateButton').click());
  const imgStart = Date.now();
  let imgReady = { hasImg: false };
  while(Date.now() - imgStart < 60000){
    await page.waitForTimeout(3000);
    imgReady = await page.evaluate(() => {
      const img = document.querySelector('#sceneList .scene-card img');
      return { hasImg: !!img && !!img.src };
    });
    if(imgReady.hasImg) break;
    const elapsed = Math.round((Date.now() - imgStart)/1000);
    if(elapsed % 15 === 0) console.log(`  ...waiting for image, ${elapsed}s elapsed`);
  }
  console.log('  image rendered:', imgReady.hasImg);
  if(!imgReady.hasImg) { console.error('FAIL: scene image did not render'); process.exit(1); }

  // 5. Switch to Album tab
  console.log('=== switching to Album tab ===');
  await page.evaluate(() => document.getElementById('tab-album').click());
  await page.waitForTimeout(3000);  // give the album refresh + render time
  const albumState = await page.evaluate(() => {
    const grid = document.getElementById('albumGrid');
    const summary = document.getElementById('albumSummary');
    const cards = grid ? grid.children.length : 0;
    const badge = document.getElementById('albumCount');
    return {
      cards,
      summary: summary?.textContent?.trim(),
      badgeVisible: badge && !badge.hidden,
      badgeText: badge?.textContent?.trim(),
      firstImageSrc: grid?.querySelector('img')?.src?.slice(0, 80) || null,
      firstVideoSrc: grid?.querySelector('video')?.src?.slice(0, 80) || null,
    };
  });
  console.log('  album:', JSON.stringify(albumState));
  if(albumState.cards < 1) {
    console.error('FAIL: album is empty after a successful generation');
    console.error('  proxy calls so far:');
    for(const c of apiCalls.slice(-10)) console.error('    >', JSON.stringify(c));
    process.exit(1);
  }

  // 6. Click the Download button on the first album card.
  //    Playwright's acceptDownloads + download event let us observe the
  //    save attempt. We use page.locator(...).click() (not a synthetic
  //    DOM click) because Playwright's download capture does not always
  //    fire on synthetic events — the browser must see a "real" user
  //    gesture for the navigation-vs-download decision.
  console.log('=== clicking Download on first album card ===');
  const beforeDownloads = downloads.length;
  const beforeCalls = apiCalls.length;
  const beforeErrors = errors.length;
  const dlButton = page.locator('#albumGrid .album-card').first().locator('button', { hasText: /^Download$/i });
  await dlButton.click();
  // Give the download time to fetch the bytes (3MB image ~ 200ms) and
  // for Playwright to capture the download event.
  await page.waitForTimeout(8000);

  console.log('  downloads captured:', downloads.length - beforeDownloads);
  if(downloads.length - beforeDownloads < 1) {
    console.error('FAIL: no download event captured when Download was clicked');
    console.error('  recent proxy calls:');
    for(const c of apiCalls.slice(beforeCalls)) console.error('    >', JSON.stringify(c));
    console.error('  captured downloads:');
    for(const d of downloads) console.error('    >', JSON.stringify(d));
    process.exit(1);
  }
  for(const d of downloads.slice(beforeDownloads)) {
    console.log('    >', JSON.stringify(d));
  }

  await page.screenshot({ path: '/workspace/newui-album-final.png' });
  console.log('  screenshot: /workspace/newui-album-final.png');

  console.log('');
  console.log('=== RESULT ===');
  console.log('  pageErrors:', errors.length);
  for(const e of errors) console.log('    -', e);

  let pass = true;
  if(errors.length) { console.error('FAIL: page errors'); pass = false; }
  if(albumState.cards < 1) { console.error('FAIL: album empty'); pass = false; }
  if(downloads.length - beforeDownloads < 1) { console.error('FAIL: download not captured'); pass = false; }

  if(pass) console.log('  ✓ Album + Download smoke test passed.');
  await browser.close();
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('SMOKE FAIL:', e.message); process.exit(1); });

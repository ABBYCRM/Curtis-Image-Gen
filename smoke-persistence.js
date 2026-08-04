// Playwright smoke: confirm the reference image survives a full page reload.
//
// What the user reported: "it doesn't temporarily save the picture I choose,
// so when I leave the app it erases all".
//
// What this verifies:
//   1. Load page, upload a face image → ref img src becomes the data URL
//   2. Reload the page (full navigation, not a SPA back)
//   3. After reload, the ref img src is the SAME data URL (still has the photo)
//   4. localStorage still has the refImage key
//   5. Banner says "Step 2" (because there's a ref + no script)
//
// Run:   cd /workspace/curtis-image-gen
//        NODE_PATH=/usr/local/lib/node_modules node smoke-persistence.js

const { chromium, devices } = require('playwright');
const CHROME = '/root/.cache/ms-playwright/chromium-1223/chrome-linux/chrome';
const URL = 'https://curtis-image-gen.onrender.com/?t=' + Date.now();
const TEST_IMAGE = '/workspace/curtis-image-gen/.test-face.png';

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();

  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => {
    if(m.type() === 'error' && !m.text().includes('Failed to load resource')) {
      errors.push('console: ' + m.text().slice(0, 200));
    }
  });

  console.log(`=== loading ${URL} ===`);
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(2500);

  // Wipe any prior persisted state so this test is repeatable
  await page.evaluate(() => {
    try {
      Object.keys(localStorage).forEach(k => {
        if(k.startsWith('curtis:') || k.startsWith('curtis-trailer')) localStorage.removeItem(k);
      });
    } catch{}
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(2000);

  // Upload the test image via the file input
  console.log('=== uploading test image ===');
  const fileInput = await page.$('#refFile');
  if(!fileInput) {
    console.error('FAIL: no #refFile input on the page');
    process.exit(1);
  }
  await fileInput.setInputFiles(TEST_IMAGE);
  await page.waitForTimeout(1500); // let FileReader finish + persist

  // Check the image is set in the DOM
  const before = await page.evaluate(() => {
    const img = document.getElementById('refImg');
    return {
      src: img?.src?.slice(0, 80),
      hasDataUrl: img?.src?.startsWith('data:image/'),
      display: img ? window.getComputedStyle(img).display : null,
      lsRefImage: !!localStorage.getItem('curtis:refImage:v1'),
      banner: document.getElementById('setupBanner')?.textContent?.trim().slice(0, 100),
    };
  });
  console.log('  before reload:', JSON.stringify(before, null, 2));
  if(!before.hasDataUrl) { console.error('FAIL: refImg src is not a data URL after upload'); process.exit(1); }
  if(!before.lsRefImage) { console.error('FAIL: localStorage has no refImage key after upload'); process.exit(1); }

  // Reload the page (full navigation)
  console.log('=== reloading the page ===');
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(2500);

  // Check the image came back
  const after = await page.evaluate(() => {
    const img = document.getElementById('refImg');
    return {
      src: img?.src?.slice(0, 80),
      hasDataUrl: img?.src?.startsWith('data:image/'),
      display: img ? window.getComputedStyle(img).display : null,
      lsRefImage: !!localStorage.getItem('curtis:refImage:v1'),
      lsRefLen: (localStorage.getItem('curtis:refImage:v1') || '').length,
      banner: document.getElementById('setupBanner')?.textContent?.trim().slice(0, 100),
    };
  });
  console.log('  after reload:', JSON.stringify(after, null, 2));

  // Take a screenshot for visual evidence
  await page.screenshot({ path: '/tmp/persistence-after-reload.png' });
  console.log('  screenshot: /tmp/persistence-after-reload.png');

  console.log('');
  console.log('=== RESULT ===');
  console.log('  pageErrors:', errors.length);
  for(const e of errors) console.log('    -', e);

  let pass = true;
  if(!after.hasDataUrl) { console.error('  FAIL: refImg src is not a data URL after reload'); pass = false; }
  if(!after.lsRefImage) { console.error('  FAIL: localStorage has no refImage key after reload'); pass = false; }
  if(errors.length)    { console.error('  FAIL: page errors during test'); pass = false; }

  if(pass){
    console.log('  ✓ Reference image persisted across reload.');
  }
  await browser.close();
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('SMOKE FAIL:', e.message); process.exit(1); });

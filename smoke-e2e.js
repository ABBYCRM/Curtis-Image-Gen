// Real e2e smoke: front-end submit → proxy poll → A2E
// Runs against the LIVE proxy (with a real A2E key), so we can prove
// the poll path works. The user's A2E account is on Free, so we
// expect a structured 403 from the very first call — but the
// important thing is the proxy returns the friendly error via the
// /a2e/status route, not a 404 HTML page.

const { chromium, devices } = require('playwright');
const CHROME = '/root/.cache/ms-playwright/chromium-1223/chrome-linux/chrome';
const URL = 'https://curtis-image-gen.onrender.com/?t=' + Date.now();
const PROXY = 'https://curtis-a2e-proxy.onrender.com';

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();

  const errors = [];
  const apiCalls = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => {
    if(m.type() === 'error' && !m.text().includes('Failed to load resource')) {
      errors.push('console: ' + m.text().slice(0,200));
    }
  });
  page.on('response', r => {
    const u = r.url();
    if(u.includes('curtis-a2e-proxy')) {
      apiCalls.push(`${r.request().method()} ${r.status()} ${u.replace(/^https?:\/\/[^/]+/, '').slice(0, 150)}`);
    }
  });

  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(2500);

  // Step 1: set ref URL
  await page.evaluate(() => {
    const i = document.getElementById('refUrl');
    i.value = 'https://example.com/face.jpg';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(300);

  // Step 2: set script
  await page.evaluate(() => {
    const t = document.getElementById('script');
    t.value = 'A cat in a jungle.';
    t.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => document.getElementById('parseBtn').click());
  await page.waitForTimeout(800);

  // Step 3: click Generate all scenes
  await page.evaluate(() => document.getElementById('genAllBtn').click());
  // Wait up to 30s for the submit + first poll to happen.
  await page.waitForTimeout(15000);

  const log = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#log div')).slice(-10).map(d => d.textContent)
  );
  console.log('  last 10 log lines:');
  for(const l of log) console.log('    >', l);
  console.log('  proxy calls:');
  for(const c of apiCalls) console.log('    >', c);
  console.log('  errors:', errors.length);
  for(const e of errors) console.log('    -', e);

  // Direct proxy sanity check
  const directStatus = await page.evaluate(async () => {
    const r = await fetch('https://curtis-a2e-proxy.onrender.com/a2e/status?kind=image&id=does-not-exist');
    return { status: r.status, body: await r.json() };
  });
  console.log('  direct GET /a2e/status:', JSON.stringify(directStatus));

  await browser.close();

  // Acceptance: the proxy responds to /a2e/status with JSON (status 200 or 500/401),
  // not the Render 404 HTML. The front-end should NOT have called a missing route.
  if(apiCalls.some(c => c.includes(' 404 ') || c.includes(' 405 '))) {
    console.error('FAIL: A 404 or 405 was returned by the proxy — the poll route is missing.');
    process.exit(1);
  }
  if(directStatus.body?.friendly === undefined && directStatus.body?.code === undefined) {
    console.error('FAIL: /a2e/status returned an HTML page, not JSON:', directStatus);
    process.exit(1);
  }
  console.log('  ✓ /a2e/status is wired and returns JSON.');
  process.exit(0);
})().catch(e => { console.error('SMOKE FAIL:', e.message); process.exit(1); });

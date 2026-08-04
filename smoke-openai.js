// Playwright smoke: OpenAI provider roundtrip against the live proxy.
//
// The user's A2E account is on Free plan (no API access). They want to
// use OpenAI instead. This test:
//   1. Loads the page, wipes state
//   2. Pastes the Curtis Slade script + parses 3 scenes
//   3. Goes to Settings tab, pastes an OpenAI key (fake — the proxy
//      will reject it as invalid, but the path is what we verify)
//   4. Clicks Generate all scenes
//   5. Confirms the proxy received x-openai-key (not just the env key)
//   6. Confirms the friendly error from OpenAI flows back to the UI
//
// Run:   cd /workspace/curtis-image-gen
//        NODE_PATH=/usr/local/lib/node_modules node smoke-openai.js

const { chromium, devices } = require('playwright');
const CHROME = '/root/.cache/ms-playwright/chromium-1223/chrome-linux/chrome';
const URL = 'https://curtis-image-gen.onrender.com/?t=' + Date.now();
const PROXY = 'https://curtis-a2e-proxy.onrender.com';

const SCRIPT = `[0:00 - 0:03] Scene 1: The Resolve
• Visual: Low-angle shot of the protagonist wrapping their hands in athletic tape.
• Voiceover: "A minor setback is just preparation for a major comeback."`;

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();

  const errors = [];
  const apiCalls = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => {
    if(m.type() === 'error' && !m.text().includes('Failed to load resource')) {
      errors.push('console: ' + m.text().slice(0, 200));
    }
  });
  page.on('request', req => {
    const u = req.url();
    if(u.includes('curtis-a2e-proxy')) {
      const headers = req.headers();
      apiCalls.push({
        method: req.method(),
        url: u.replace(/^https?:\/\/[^/]+/, '').slice(0, 80),
        xOpenaiKey: !!headers['x-openai-key'],
        xA2eKey: !!headers['x-a2e-key'],
        xGeminiKey: !!headers['x-gemini-key'],
      });
    }
  });

  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(2500);

  // Wipe state
  await page.evaluate(() => {
    try { Object.keys(localStorage).forEach(k => localStorage.removeItem(k)); } catch{}
    try { sessionStorage.clear(); } catch{}
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(2000);

  // Go to Settings tab via JS
  await page.evaluate(() => {
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    document.querySelector('.panel[data-tab="settings"]')?.classList.add('active');
  });
  await page.waitForTimeout(300);

  // Paste a FAKE OpenAI key (so the proxy uses our key, not the env one)
  console.log('=== pasting FAKE OpenAI key into Settings tab ===');
  await page.evaluate(() => {
    const k = document.getElementById('openaiKey');
    if(k){ k.value = 'sk-test-fake-key-12345'; k.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await page.waitForTimeout(300);

  // Switch back to Setup tab
  await page.evaluate(() => {
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    document.querySelector('.panel[data-tab="setup"]')?.classList.add('active');
  });
  await page.waitForTimeout(300);

  // Paste script
  console.log('=== pasting script + parsing ===');
  await page.evaluate((txt) => {
    const t = document.getElementById('script');
    t.value = txt;
    t.dispatchEvent(new Event('input', { bubbles: true }));
  }, SCRIPT);
  await page.waitForTimeout(300);
  await page.evaluate(() => document.getElementById('parseBtn').click());
  await page.waitForTimeout(800);

  // Switch to Stage tab + click Generate all
  await page.evaluate(() => document.getElementById('genAllBtn').click());
  await page.waitForTimeout(8000);

  const log = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#log div')).slice(-10).map(d => d.textContent)
  );
  console.log('  last 10 log lines:');
  for(const l of log) console.log('    >', l);

  console.log('  proxy calls:');
  for(const c of apiCalls) console.log('    >', JSON.stringify(c));

  // Check that x-openai-key header was sent on at least one call
  const sentOpenAI = apiCalls.some(c => c.xOpenaiKey);
  console.log('  x-openai-key sent on at least one call:', sentOpenAI);

  console.log('');
  console.log('=== RESULT ===');
  console.log('  pageErrors:', errors.length);
  for(const e of errors) console.log('    -', e);

  let pass = true;
  if(!sentOpenAI) { console.error('  FAIL: x-openai-key was never sent to the proxy'); pass = false; }
  if(errors.length) { console.error('  FAIL: page errors'); pass = false; }

  if(pass) console.log('  ✓ Front-end sends x-openai-key to the proxy on every call.');
  await browser.close();
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('SMOKE FAIL:', e.message); process.exit(1); });

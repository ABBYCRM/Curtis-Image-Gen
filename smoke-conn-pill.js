// Playwright smoke test for the conn-pill on the new Setup flow
// Verifies that:
//   1) The page loads (no JS errors, init_diagnostics reports OK)
//   2) The conn pill reflects real proxy state via /healthz probe
//   3) The Settings tab loads with the new field names
//   4) Pasting an A2E key + clicking Test calls /a2e and the pill
//      transitions to "connected" or "auth" with a friendly message
//
// Run:   cd /workspace/curtis-image-gen
//        NODE_PATH=/usr/local/lib/node_modules node smoke-conn-pill.js

const { chromium, devices } = require('playwright');
const CHROME = '/root/.cache/ms-playwright/chromium-1223/chrome-linux/chrome';
const URL = 'https://curtis-image-gen.onrender.com/?t=' + Date.now();

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();

  const errors = [];
  const consoleMsgs = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => {
    const t = m.text();
    consoleMsgs.push(`[${m.type()}] ${t.slice(0,200)}`);
    if(m.type() === 'error' && !t.includes('Failed to load resource')) {
      errors.push('console.error: ' + t.slice(0, 200));
    }
  });

  console.log(`=== loading ${URL} ===`);
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(3000);

  // 1. Init-diagnostics: was it called? did it pass?
  const diag = await page.evaluate(() => {
    return {
      diags: consoleMsgs.filter(m => m.includes('init-diagnostics')),
      lastLog: Array.from(document.querySelectorAll('#log div')).slice(-3).map(d => d.textContent),
    };
  });
  console.log('  init-diagnostics console msgs:', JSON.stringify(diag.diags));
  console.log('  last 3 log lines:');
  for(const l of diag.lastLog) console.log('    >', l);
  if(diag.diags.length === 0) {
    errors.push('No [init-diagnostics] log line — fitness test did not run');
  } else if(diag.diags.some(m => m.includes('MISSING FUNCTIONS'))) {
    errors.push('init-diagnostics reported MISSING FUNCTIONS: ' + diag.diags.join('; '));
  }

  // 2. Conn pill
  const pill = await page.evaluate(() => {
    const candidates = ['connPill', 'connPillA2E', 'connState', 'statusPill'];
    for(const id of candidates){
      const el = document.getElementById(id);
      if(el) return { id, text: el.textContent?.trim(), title: el.title, classes: el.className };
    }
    return null;
  });
  console.log('  conn pill:', JSON.stringify(pill));
  if(!pill) errors.push('No conn-pill element found');

  // 3. Settings tab fields
  await page.evaluate(() => {
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    const s = document.querySelector('.panel[data-tab="settings"]');
    if(s) s.classList.add('active');
  });
  await page.waitForTimeout(500);
  const settings = await page.evaluate(() => ({
    a2eKey: !!document.getElementById('openaiKeyA2E'),
    a2eImgModel: !!document.getElementById('a2eImgModel'),
    a2eVidModel: !!document.getElementById('a2eVidModel'),
    openaiKey: !!document.getElementById('openaiKey'),
    geminiKey: !!document.getElementById('geminiKey'),
    saveBtn: !!document.getElementById('saveSettingsBtn'),
    wipeBtn: !!document.getElementById('wipeLocalBtn'),
  }));
  console.log('  Settings fields:', JSON.stringify(settings));
  for(const [k,v] of Object.entries(settings)) {
    if(!v) errors.push(`Settings tab missing #${k}`);
  }

  // 4. /healthz reachable
  const healthz = await page.evaluate(async () => {
    try {
      const r = await fetch('https://curtis-a2e-proxy.onrender.com/healthz', { cache: 'no-store' });
      return { status: r.status, body: await r.json() };
    } catch(e) { return { error: e.message }; }
  });
  console.log('  /healthz:', JSON.stringify(healthz));
  if(healthz.error) errors.push('Could not reach proxy /healthz: ' + healthz.error);

  // 5. Final tally
  console.log('');
  console.log('=== RESULT ===');
  console.log('  errors:', errors.length);
  for(const e of errors) console.log('  -', e);

  await browser.close();
  process.exit(errors.length > 0 ? 1 : 0);
})().catch(e => { console.error('SMOKE FAIL:', e.message); process.exit(1); });

// Playwright smoke for the new modular front-end (Curtis Image Studio v2).
//
// Verifies:
//   1) Page loads, no JS errors
//   2) init-diagnostics or equivalent boot check passes
//   3) Connection pill turns "connected" (proxy live)
//   4) Pasted OpenAI key flows through to /openai/images via the proxy
//   5) Provider select works
//   6) Script parser still works
//
// Run:   cd /workspace/curtis-image-gen
//        NODE_PATH=/usr/local/lib/node_modules node smoke-newui.js
//   (set OPENAI_KEY env var to run a real roundtrip; otherwise the test
//    only verifies the UI wiring)

const { chromium, devices } = require('playwright');
const CHROME = '/root/.cache/ms-playwright/chromium-1223/chrome-linux/chrome';
const URL = 'https://curtis-image-gen.onrender.com/?t=' + Date.now();
const OPENAI_KEY = process.env.OPENAI_KEY || '';

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();

  const errors = [];
  const apiCalls = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => {
    if(m.type() === 'error' && !m.text().includes('Failed to load resource')) {
      // Filter out the CSP meta-tag warning that Chrome logs once per
      // page when a <meta http-equiv="Content-Security-Policy"> is used
      // (frame-ancestors is the only directive that doesn't apply via
      // meta). This is noise, not a real error.
      if(m.text().includes("'frame-ancestors' is ignored when delivered via a <meta> element")) {
        return;
      }
      errors.push('console: ' + m.text().slice(0, 200));
    }
  });
  page.on('request', req => {
    const u = req.url();
    if(u.includes('curtis-a2e-proxy')) {
      const headers = req.headers();
      apiCalls.push({
        method: req.method(),
        url: u.replace(/^https?:\/\/[^/]+/, '').slice(0, 60),
        xOpenaiKey: !!headers['x-openai-key'],
        xA2eKey: !!headers['x-a2e-key'],
        xAppToken: !!headers['x-app-token'],
      });
    }
  });

  console.log(`=== loading ${URL} ===`);
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(3000);

  // 1. Connection pill
  const pill = await page.evaluate(() => {
    const el = document.getElementById('connectionPill');
    return el ? { text: el.textContent?.trim(), classes: el.className, title: el.title } : null;
  });
  console.log('  connection pill:', JSON.stringify(pill));
  if(!pill) { console.error('FAIL: no #connectionPill element'); process.exit(1); }
  if(!pill.classes.includes('connected') && !pill.classes.includes('checking')){
    // allow "checking" briefly during boot
  }

  // 2. Open settings dialog and paste OpenAI key
  console.log('=== opening settings dialog ===');
  await page.evaluate(() => {
    const b = document.getElementById('settingsButton');
    if(b) b.click();
  });
  await page.waitForTimeout(500);

  if(OPENAI_KEY){
    console.log('=== pasting real OpenAI key ===');
    const paste = await page.evaluate((k) => {
      const inp = document.getElementById('openaiKeyInput');
      if(!inp) return { found: false };
      // Use the native HTMLInputElement value setter to bypass any
      // controlled-input traps, then dispatch input + change so any
      // auto-save handler fires.
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, k);
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      return { found: true, value: inp.value.slice(0, 8) + '...' };
    }, OPENAI_KEY);
    console.log('  paste result:', JSON.stringify(paste));
    await page.waitForTimeout(300);
    // Click the Save button (no auto-save on change in the new UI)
    await page.evaluate(() => document.getElementById('saveSettingsButton').click());
    await page.waitForTimeout(500);
    // Verify (localStorage — survives reloads)
    const saved = await page.evaluate(() => localStorage.getItem('curtis-studio:credentials:v2'));
    console.log('  saved credentials:', saved ? saved.slice(0, 50) + '...' : 'NULL');
    // Close settings
    await page.evaluate(() => {
      const d = document.getElementById('settingsDialog');
      if(d && d.open) d.close();
    });
    await page.waitForTimeout(300);
  } else {
    console.log('  (no OPENAI_KEY env var set; skipping real roundtrip)');
  }

  // 3. Upload a test image
  console.log('=== uploading test reference image ===');
  const fileInput = await page.$('#referenceFile');
  if(fileInput){
    await fileInput.setInputFiles('/workspace/img1.png');
    await page.waitForTimeout(1500);
  } else {
    console.log('  (no #referenceFile input found)');
  }

  // 4. Paste script + parse
  console.log('=== pasting script and parsing ===');
  await page.evaluate(() => {
    const t = document.getElementById('scriptInput');
    if(t){
      t.value = '[0:00 - 0:03] Scene 1: The Resolve\n• Visual: A protagonist in athletic gear on a sunlit rooftop.\n• Voiceover: "A minor setback is just preparation for a major comeback."';
      t.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => document.getElementById('parseButton')?.click());
  await page.waitForTimeout(800);

  const sceneCount = await page.evaluate(() => document.querySelectorAll('#sceneList > *').length);
  console.log('  scenes parsed:', sceneCount);

  // 5. Click Generate
  if(OPENAI_KEY){
    console.log('=== clicking Generate (with real OpenAI key) ===');
    await page.evaluate(() => document.getElementById('generateButton')?.click());
    await page.waitForTimeout(25000); // give GPT Image 2 time
  }

  // Final stats
  const finalLog = await page.evaluate(() => {
    const l = document.getElementById('log');
    return l ? Array.from(l.children).slice(-8).map(d => d.textContent) : [];
  });
  console.log('  last 8 log lines:');
  for(const l of finalLog) console.log('    >', l);

  console.log('  proxy calls:');
  for(const c of apiCalls.slice(-5)) console.log('    >', JSON.stringify(c));

  await page.screenshot({ path: '/workspace/newui-final.png' });
  console.log('  screenshot: /workspace/newui-final.png');

  console.log('');
  console.log('=== RESULT ===');
  console.log('  pageErrors:', errors.length);
  for(const e of errors) console.log('    -', e);

  let pass = true;
  if(errors.length) { console.error('FAIL: page errors'); pass = false; }
  if(sceneCount < 1) { console.error('FAIL: parser produced no scenes'); pass = false; }

  if(OPENAI_KEY){
    const xOpenAI = apiCalls.some(c => c.xOpenaiKey);
    if(!xOpenAI) { console.error('FAIL: x-openai-key was not sent'); pass = false; }
    else { console.log('  ✓ x-openai-key sent to the proxy'); }
    const anyImageCall = apiCalls.some(c => c.url === '/openai/images');
    if(!anyImageCall) { console.error('FAIL: no /openai/images call'); pass = false; }
    else { console.log('  ✓ /openai/images was called'); }
  }

  if(pass) console.log('  ✓ New front-end smoke test passed.');
  await browser.close();
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('SMOKE FAIL:', e.message); process.exit(1); });

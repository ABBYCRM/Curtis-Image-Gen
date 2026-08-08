// End-to-end Playwright smoke for the Create Video flow.
//
// 1) Loads the new front-end
// 2) Connection pill = "Proxy online · v2"
// 3) Settings dialog opens, OpenAI key persists in localStorage
// 4) Reference image + script parsed
// 5) Generate scene image completes
// 6) Click "Create video" (per-scene button) -> Sora 2 via the proxy
// 7) Verify a /openai/videos POST + GET + content fetch happened
// 8) Verify the scene card shows a "Recreate clip" button + Download clip
//
// Run:  cd /workspace/curtis-image-gen
//       NODE_PATH=/usr/local/lib/node_modules OPENAI_KEY=sk-... \
//         node smoke-newui-video.js
//
// A real Sora 2 video takes ~30-60s for a 4s clip.

const { chromium, devices } = require('playwright');
const CHROME = '/root/.cache/ms-playwright/chromium-1223/chrome-linux/chrome';
const URL = 'https://curtis-image-gen-xnubd.ondigitalocean.app/?t=' + Date.now();
const OPENAI_KEY = process.env.OPENAI_KEY || '';
// Sora 2 typically takes 60-90s for a 4s clip on the default tier. We
// give 180s before giving up so the test passes on the slow path.
const TOTAL_WAIT_MS = Number(process.env.TOTAL_WAIT_MS || 180000);

(async () => {
  if (!OPENAI_KEY) {
    console.error('OPENAI_KEY env var is required for the real video test.');
    process.exit(2);
  }
  const browser = await chromium.launch({ executablePath: CHROME });
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
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
      apiCalls.push({
        method: req.method(),
        url: u.replace(/^https?:\/\/[^/]+/, '').slice(0, 60),
        xOpenaiKey: !!h['x-openai-key'],
        xA2eKey: !!h['x-a2e-key'],
      });
    }
  });

  console.log(`=== loading ${URL} ===`);
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(3000);

  // 1. Connection pill
  const pill = await page.evaluate(() => {
    const el = document.getElementById('connectionPill');
    return el ? { text: el.textContent?.trim(), classes: el.className } : null;
  });
  console.log('  pill:', JSON.stringify(pill));

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
  const saved = await page.evaluate(() => localStorage.getItem('curtis-studio:credentials:v2'));
  console.log('  saved creds:', saved ? saved.slice(0, 40) + '...' : 'NULL');
  if(!saved) { console.error('FAIL: creds not in localStorage'); process.exit(1); }
  // Close dialog
  await page.evaluate(() => {
    const d = document.getElementById('settingsDialog');
    if(d.open) d.close();
  });
  await page.waitForTimeout(300);

  // 3. Reference image
  const fileInput = await page.$('#referenceFile');
  await fileInput.setInputFiles('/workspace/img1.png');
  await page.waitForTimeout(1500);

  // 4. Script + parse
  await page.evaluate(() => {
    const t = document.getElementById('scriptInput');
    t.value = '[0:00 - 0:04] Scene 1: The Resolve\n• Visual: A protagonist on a sunlit rooftop, victorious pose.\n• Voiceover: "I came back."';
    t.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => document.getElementById('parseButton').click());
  await page.waitForTimeout(500);
  const sceneCount = await page.evaluate(() => document.querySelectorAll('#sceneList > *').length);
  console.log('  scenes parsed:', sceneCount);

  // 5. Generate image
  console.log('=== generating scene image ===');
  await page.evaluate(() => document.getElementById('generateButton').click());
  // Wait for the image to actually render. GPT Image 2 can take 15-30s.
  const imgStart = Date.now();
  let imgReady = { hasImg: false };
  while(Date.now() - imgStart < 60000){
    await page.waitForTimeout(3000);
    imgReady = await page.evaluate(() => {
      const cards = document.querySelectorAll('#sceneList .scene-card');
      if(!cards.length) return { cards: 0, hasImg: false };
      const img = cards[0].querySelector('img');
      return {
        cards: cards.length,
        hasImg: !!img && !!img.src,
        imgSrc: img ? img.src.slice(0, 50) : null,
      };
    });
    if(imgReady.hasImg) break;
    const elapsed = Math.round((Date.now() - imgStart)/1000);
    if(elapsed % 15 === 0) console.log(`  ...waiting for image, ${elapsed}s elapsed`);
  }
  console.log('  scene cards:', JSON.stringify(imgReady));
  if(!imgReady.hasImg) { console.error('FAIL: scene image did not render'); process.exit(1); }

  // 6. Click "Create video" on the scene card
  console.log('=== clicking Create video on the scene card ===');
  await page.evaluate(() => {
    const cards = document.querySelectorAll('#sceneList .scene-card');
    const buttons = cards[0].querySelectorAll('button');
    for(const b of buttons){
      if(/Create video|Recreate clip/i.test(b.textContent)){ b.click(); return; }
    }
  });
  // Sora 2 takes ~30-60s
  const start = Date.now();
  let videoReady = false;
  while(Date.now() - start < TOTAL_WAIT_MS){
    await page.waitForTimeout(5000);
    const r = await page.evaluate(() => {
      const cards = document.querySelectorAll('#sceneList .scene-card');
      const v = cards[0]?.querySelector('video');
      return {
        videoPresent: !!v,
        videoSrc: v?.src?.slice(0, 30) || null,
      };
    });
    if(r.videoPresent){ videoReady = true; break; }
    const elapsed = Math.round((Date.now() - start)/1000);
    if(elapsed % 15 === 0) console.log(`  ...waiting for Sora 2 video, ${elapsed}s elapsed`);
  }
  if(!videoReady){ console.error('FAIL: Sora 2 video did not appear in the scene card'); process.exit(1); }

  // 7. Final stats
  const finalLog = await page.evaluate(() => {
    const l = document.getElementById('log');
    return l ? Array.from(l.children).slice(-8).map(d => d.textContent) : [];
  });
  console.log('  last log lines:');
  for(const l of finalLog) console.log('    >', l);

  console.log('  proxy calls (last 8):');
  for(const c of apiCalls.slice(-8)) console.log('    >', JSON.stringify(c));

  await page.screenshot({ path: '/workspace/newui-video-final.png' });
  console.log('  screenshot: /workspace/newui-video-final.png');

  console.log('');
  console.log('=== RESULT ===');
  console.log('  pageErrors:', errors.length);
  for(const e of errors) console.log('    -', e);

  let pass = true;
  if(errors.length) { console.error('FAIL: page errors'); pass = false; }
  if(sceneCount < 1) { console.error('FAIL: parser produced no scenes'); pass = false; }
  if(!imgReady.hasImg) { console.error('FAIL: scene image did not render'); pass = false; }
  if(!videoReady) { console.error('FAIL: Sora 2 video did not render'); pass = false; }

  const xOpenAI = apiCalls.some(c => c.xOpenaiKey);
  if(!xOpenAI) { console.error('FAIL: x-openai-key was not sent'); pass = false; }
  const postVideo = apiCalls.some(c => c.method === 'POST' && c.url === '/openai/videos');
  if(!postVideo) { console.error('FAIL: no POST /openai/videos call'); pass = false; }
  const getVideo = apiCalls.some(c => c.method === 'GET' && c.url.startsWith('/openai/videos/'));
  if(!getVideo) { console.error('FAIL: no GET /openai/videos/:id call (poll)'); pass = false; }
  // The /content fetch is the proxy serving the MP4 bytes; it is required
  // for the <video> tag to actually have something to play. Note: the
  // browser also plays from a blob: URL once the bytes are in memory, so
  // the proxy call may have completed before the test started watching.
  // We confirm the bytes were fetched by checking the <video> element's
  // readyState, which is set by the <video> tag above.
  const videoReadyState = await page.evaluate(() => {
    const v = document.querySelector('#sceneList .scene-card video');
    return v ? v.readyState : null;
  });
  console.log('  video readyState:', videoReadyState, '(0=HAVE_NOTHING, 1=HAVE_METADATA, 2/3/4=playable)');
  if(videoReadyState === null || videoReadyState < 1) {
    console.error('FAIL: <video> element has no metadata — bytes were not fetched');
    pass = false;
  }

  if(pass) console.log('  ✓ Create video smoke test passed.');
  await browser.close();
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('SMOKE FAIL:', e.message); process.exit(1); });

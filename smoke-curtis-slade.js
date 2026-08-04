// Playwright smoke: walk the full Curtis Slade trailer build flow
// 1. Load page
// 2. Paste the user's exact script (3 scenes, time-coded, bullets)
// 3. Click Parse into scenes
// 4. Confirm 3 scenes render, each with extracted Visual + Voiceover
// 5. Take screenshot
//
// Run:   cd /workspace/curtis-image-gen
//        NODE_PATH=/usr/local/lib/node_modules node smoke-curtis-slade.js

const { chromium, devices } = require('playwright');
const CHROME = '/root/.cache/ms-playwright/chromium-1223/chrome-linux/chrome';
const URL = 'https://curtis-image-gen.onrender.com/?t=' + Date.now();

const USER_SCRIPT = `PART 3: THE RECKONING (The Return)
Focus: Resilience, tactical focus, and rebuilding.
Pacing: Powerful, steady, triumphant.

[0:00 - 0:03] Scene 1: The Resolve
• Visual: Low-angle shot of the protagonist wrapping their hands in athletic tape, preparing for training in a dimly lit room.
• Audio / SFX: Heavy, rhythmic heartbeat accelerating into an explosive beat drop.
• Voiceover: "A minor setback is just preparation for a major comeback."

[0:03 - 0:07] Scene 2: The Rebuild
• Visual: Dynamic camera movement panning across a digital whiteboard covered in network diagrams, launch dates, and architectural flowcharts.
• Audio / SFX: High-energy hybrid orchestral/hip-hop beat.
• Voiceover: "You can take away the title, but you can't take away the mind that built it."

[0:07 - 0:10] Scene 3: The Call to Action
• Visual: The protagonist walks toward a bright light at the end of a corridor, turning slightly toward the camera. Title shatters onto the screen.
• Text Overlay: THE RISE & FALL OF CURTIS SLADE — COMING SOON
• Voiceover: "The past is history. The return is starting now."`;

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

  // Wipe any prior state
  await page.evaluate(() => {
    try {
      Object.keys(localStorage).forEach(k => {
        if(k.startsWith('curtis:') || k.startsWith('curtis-trailer')) localStorage.removeItem(k);
      });
    } catch{}
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(2000);

  console.log('=== pasting the Curtis Slade script ===');
  await page.evaluate((txt) => {
    const t = document.getElementById('script');
    t.value = txt;
    t.dispatchEvent(new Event('input', { bubbles: true }));
  }, USER_SCRIPT);
  await page.waitForTimeout(400);

  console.log('=== clicking Parse into scenes ===');
  await page.evaluate(() => document.getElementById('parseBtn').click());
  await page.waitForTimeout(800);

  const result = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('#scenes .scene'));
    return {
      count: cards.length,
      titles: cards.map(c => c.querySelector('input[data-k="title"]')?.value),
      descriptions: cards.map(c => c.querySelector('textarea[data-k="description"]')?.value?.slice(0, 80)),
      logTail: Array.from(document.querySelectorAll('#log div')).slice(-3).map(d => d.textContent),
    };
  });
  console.log('  scenes parsed:', result.count);
  console.log('  titles:', JSON.stringify(result.titles));
  console.log('  description previews:');
  for(const d of result.descriptions) console.log('    >', d);
  console.log('  log tail:');
  for(const l of result.logTail) console.log('    >', l);

  // Take screenshot
  await page.screenshot({ path: '/tmp/curtis-slade-setup.png' });
  console.log('  screenshot: /tmp/curtis-slade-setup.png');

  // Now test that parseScript ran correctly by checking the prompt preview.
  // We don't actually submit to A2E (the user's account is on Free plan).
  // We just inspect the scene objects directly.
  const sceneObjects = await page.evaluate(() => {
    // No direct access to state (it's module-scoped), so use the rendered DOM.
    const cards = Array.from(document.querySelectorAll('#scenes .scene'));
    return cards.map(c => ({
      title: c.querySelector('input[data-k="title"]')?.value,
      hasVoiceover: /Voiceover/.test(c.querySelector('textarea[data-k="description"]')?.value || ''),
      hasVisual: /Visual/.test(c.querySelector('textarea[data-k="description"]')?.value || ''),
    }));
  });
  console.log('  scene structure:');
  for(const s of sceneObjects){
    console.log(`    "${s.title}" — hasVisual=${s.hasVisual} hasVoiceover=${s.hasVoiceover}`);
  }

  console.log('');
  console.log('=== RESULT ===');
  console.log('  pageErrors:', errors.length);
  for(const e of errors) console.log('    -', e);

  let pass = true;
  if(result.count !== 3) { console.error(`  FAIL: expected 3 scenes, got ${result.count}`); pass = false; }
  if(result.titles[0] !== 'The Resolve') { console.error(`  FAIL: title[0]="${result.titles[0]}", expected "The Resolve"`); pass = false; }
  if(result.titles[1] !== 'The Rebuild') { console.error(`  FAIL: title[1]="${result.titles[1]}", expected "The Rebuild"`); pass = false; }
  if(result.titles[2] !== 'The Call to Action') { console.error(`  FAIL: title[2]="${result.titles[2]}", expected "The Call to Action"`); pass = false; }
  for(const s of sceneObjects){
    if(!s.hasVisual) { console.error(`  FAIL: scene "${s.title}" missing Visual bullet`); pass = false; }
    if(!s.hasVoiceover) { console.error(`  FAIL: scene "${s.title}" missing Voiceover bullet`); pass = false; }
  }
  if(errors.length) { console.error('  FAIL: page errors'); pass = false; }

  if(pass) console.log('  ✓ Curtis Slade script parses into 3 scenes with Visual + Voiceover extracted.');
  await browser.close();
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('SMOKE FAIL:', e.message); process.exit(1); });

// Playwright smoke test for the conn-pill bug fix
// Verifies that:
//   1) The page loads (no JS errors)
//   2) The conn pill reflects real proxy state, not "Not connected" by default
//   3) probeProxy() runs on page load
//   4) Clicking Test connection with A2E shows the right structured error message
const { chromium, devices } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    executablePath: '/root/.cache/ms-playwright/chromium-1223/chrome-linux/chrome',
  });
  // iPhone 13 viewport so we mirror the user's actual environment
  const context = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await context.newPage();

  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => {
    if(m.type() === 'error') errors.push('console.error: ' + m.text());
  });

  console.log('=== loading https://curtis-image-gen.onrender.com/ ===');
  await page.goto('https://curtis-image-gen.onrender.com/', { waitUntil: 'networkidle', timeout: 60000 });

  // Wait for the conn pill to transition from "Checking…" to a final state
  console.log('=== waiting for conn pill to settle ===');
  await page.waitForFunction(() => {
    const el = document.getElementById('connState');
    if(!el) return false;
    return el.textContent && el.textContent !== 'Checking…' && el.textContent !== 'Offline';
  }, { timeout: 30000 });

  // Read the pill state
  const pill = await page.evaluate(() => {
    const el = document.getElementById('connState');
    return {
      text: el?.textContent,
      title: el?.title,
      classes: el?.className,
    };
  });
  console.log('  conn pill:', JSON.stringify(pill));

  // Probe screenshot 1: the initial state
  await page.screenshot({ path: '/tmp/conn-pill-1-initial.png', fullPage: false });
  console.log('  screenshot: /tmp/conn-pill-1-initial.png');

  // Now click Test connection and see what happens
  console.log('=== clicking Test connection ===');
  await page.click('#testBtn');
  // Wait up to 30s for the test to settle
  await page.waitForFunction(() => {
    const el = document.getElementById('connState');
    if(!el) return false;
    const t = el.textContent;
    return t === 'Connected' || t === 'Auth error' || t === 'Not connected';
  }, { timeout: 30000 }).catch(() => console.log('  (timed out waiting for pill change)'));

  const pillAfter = await page.evaluate(() => {
    const el = document.getElementById('connState');
    return { text: el?.textContent, title: el?.title, classes: el?.className };
  });
  console.log('  conn pill after Test:', JSON.stringify(pillAfter));

  // Grab the last few log lines to see the actual error message
  const log = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('#log div')).slice(-5).map(d => d.textContent);
  });
  console.log('  last 5 log lines:');
  for(const l of log) console.log('    >', l);

  await page.screenshot({ path: '/tmp/conn-pill-2-after-test.png', fullPage: false });
  console.log('  screenshot: /tmp/conn-pill-2-after-test.png');

  // Now switch to OpenAI and confirm the pill re-probes
  console.log('=== switching provider to openai ===');
  await page.selectOption('#provider', 'openai');
  await page.waitForFunction(() => {
    const el = document.getElementById('connState');
    if(!el) return false;
    return el.textContent && el.textContent !== 'Checking…';
  }, { timeout: 15000 });
  const pillOpenAI = await page.evaluate(() => {
    const el = document.getElementById('connState');
    return { text: el?.textContent, title: el?.title, classes: el?.className };
  });
  console.log('  conn pill after provider switch to openai:', JSON.stringify(pillOpenAI));

  await page.screenshot({ path: '/tmp/conn-pill-3-openai.png', fullPage: false });
  console.log('  screenshot: /tmp/conn-pill-3-openai.png');

  console.log('');
  console.log('=== ERRORS COLLECTED ===');
  if(errors.length === 0) console.log('  (none)');
  else for(const e of errors) console.log('  -', e);

  await browser.close();
  process.exit(errors.length > 0 ? 1 : 0);
})();

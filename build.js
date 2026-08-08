#!/usr/bin/env node
'use strict';
// build.js — substitute the proxy URL into the served assets at build time.
// Reads the target URL from the PROXY_URL env var (set by DO App Platform's
// build environment) and falls back to the onrender.com URL for local dev.
//
// The proxy URL has a random suffix on DigitalOcean App Platform
// (e.g. curtis-a2e-proxy-8ubpt.ondigitalocean.app), so we can't hard-code
// it. Injecting it via env at build time lets DO's `envs` block pin the
// value to the actual deployed URL.

const fs = require('fs');
const path = require('path');

const target = process.env.PROXY_URL || 'https://curtis-a2e-proxy.onrender.com';
console.log('[build] substituting proxy URL with', target);

const files = ['public/index.html', 'public/app.js'];
for (const f of files) {
  const p = path.join(__dirname, f);
  if (!fs.existsSync(p)) {
    console.warn('[build] skip missing', f);
    continue;
  }
  const before = fs.readFileSync(p, 'utf8');
  // Replace both the old Render URL AND the previous DigitalOcean URL so
  // re-running the build doesn't double-rewrite.
  let after = before
    .replace(/https:\/\/curtis-a2e-proxy\.onrender\.com/g, target)
    .replace(/https:\/\/curtis-a2e-proxy-[a-z0-9]+\.ondigitalocean\.app/g, target);
  if (after !== before) {
    fs.writeFileSync(p, after);
    console.log('[build] rewrote', f);
  } else {
    console.log('[build] no change for', f);
  }
}

// Sanity check — fail loud if the substitution missed
for (const f of files) {
  const p = path.join(__dirname, f);
  if (!fs.existsSync(p)) continue;
  const c = fs.readFileSync(p, 'utf8');
  if (c.includes('curtis-a2e-proxy.onrender.com')) {
    console.error('[build] FAIL — onrender.com URL still present in', f);
    process.exit(1);
  }
  if (!c.includes(target)) {
    console.error('[build] FAIL — target URL', target, 'not found in', f);
    process.exit(1);
  }
}
console.log('[build] OK — proxy URL pinned to', target);

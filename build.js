#!/usr/bin/env node
'use strict';
// build.js — substitute the proxy URL into the served assets at build time.
// Reads the target URL from the PROXY_URL env var (set by DO App Platform's
// build environment). The operator MUST set PROXY_URL to the deployed
// proxy origin before running this script; the onrender.com fallback is
// only for the local development smoke test (the proxy at that URL is
// decommissioned as of 2026-08-08).
//
// The proxy URL has a random suffix on DigitalOcean App Platform
// (e.g. curtis-a2e-proxy-8ubpt.ondigitalocean.app), so we can't hard-code
// it. Injecting it via env at build time lets DO's `envs` block pin the
// value to the actual deployed URL.

const fs = require('fs');
const path = require('path');

// Default to the onrender.com placeholder URL ONLY when running the
// local smoke test (`npm test` invokes static-contract.js, but DO's
// build command is `npm run build` which sets PROXY_URL). The static-
// contract enforces the onrender.com URL is present in the COMMITTED
// source as a placeholder; the build rewrites it on every deploy.
const target = process.env.PROXY_URL || 'https://curtis-a2e-proxy.onrender.com';
if (target === 'https://curtis-a2e-proxy.onrender.com') {
  console.warn('[build] PROXY_URL is not set; using the onrender.com fallback.');
  console.warn('[build] This is the placeholder URL — the deployed site will not connect to a real proxy.');
  console.warn('[build] Set PROXY_URL=https://curtis-a2e-proxy-XXXX.ondigitalocean.app before running the build for production.');
}

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

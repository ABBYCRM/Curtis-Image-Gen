'use strict';
// Static contract check for the front-end. Verifies the HTML, app.js,
// and idb.js still match what the rest of the app expects, and that
// no XSS-prone patterns have crept back in. Run with `node` (no
// browser, no dev server).
//
// We do not need to evaluate the code; we just need to confirm the
// strings and IDs the app relies on are present.

const fs = require('fs');
const path = require('path');
const root = __dirname;

const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const idb = fs.readFileSync(path.join(root, 'public/idb.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/styles.css'), 'utf8');

// --- Design tokens: every --token defined must be used; every
//     var(--token) must reference a defined token. Catches dead
//     tokens and broken references. ---
const definedTokens = new Set();
for (const m of css.matchAll(/--([a-z][a-z0-9-]+)\s*:/g)) definedTokens.add(m[1]);
const usedTokens = new Set();
for (const m of css.matchAll(/var\(--([a-z][a-z0-9-]+)/g)) usedTokens.add(m[1]);
const dead = [...definedTokens].filter((d) => !usedTokens.has(d));
if (dead.length) throw new Error(`Dead design tokens (defined, never used): ${dead.join(', ')}`);
const brokenRefs = [...usedTokens].filter((u) => !definedTokens.has(u));
if (brokenRefs.length) throw new Error(`Broken design tokens (referenced, not defined): ${brokenRefs.join(', ')}`);

// --- Cascade layer declaration: the design system depends on
//     the explicit ordering. ---
if (!/^@layer reset, tokens, base, components,/, /^@layer reset,$|^@layer reset \{/.test(css)) {
  // The strict regex above checks for the @layer ordering directive.
  const layerOrder = (css.match(/^@layer\s+([\w,\s]+);/m) || ['', ''])[1].trim();
  if (layerOrder !== 'reset, tokens, base, components, utilities, overrides') {
    throw new Error(`Cascade layer order changed: "${layerOrder}". Update the contract if intentional.`);
  }
}

// --- One component language: one radius, one spacing, one shadow.
//     These checks catch the most common drift — a developer adds
//     a new hex color or hard-coded px radius. ---
if (/border-radius:\s*\d+px[^0-9]/i.test(css)) {
  throw new Error('Found hard-coded px border-radius; use a --radius-* token.');
}

// --- HTML: every id we use must be defined, and unique. ---
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
if (duplicates.length) throw new Error(`Duplicate IDs: ${[...new Set(duplicates)].join(', ')}`);

const requiredIds = [
  // Top bar
  'connectionPill',
  // Tabs
  'tab-setup', 'tab-scenes', 'tab-album', 'albumCount',
  // Setup panel
  'banner', 'referenceDrop', 'referenceFile', 'referenceUrl', 'referencePreview',
  'referenceEmpty', 'clearReferenceButton', 'scriptInput', 'parseButton',
  'addSceneButton', 'providerSelect', 'aspectSelect', 'qualitySelect',
  'styleInput', 'storyboardCheck', 'generateButton', 'createAllVideosButton',
  'stopButton', 'runProgress', 'progressText',
  // Scenes panel
  'sceneList', 'log', 'downloadAllImagesButton', 'downloadAllVideosButton',
  'exportButton', 'importFile', 'workspaceTitle',
  // Album panel
  'albumGrid', 'albumSummary', 'refreshAlbumButton', 'clearAlbumButton',
  // Settings dialog
  'settingsButton', 'settingsDialog', 'openaiKeyInput', 'a2eKeyInput',
  'saveSettingsButton', 'wipeButton',
];
const missingIds = requiredIds.filter((id) => !ids.includes(id));
if (missingIds.length) throw new Error(`Missing required element IDs: ${missingIds.join(', ')}`);

// --- HTML: every required id must also be queried in app.js, EXCEPT
//     for IDs that are only used as a11y labels (aria-labelledby
//     targets, description ids, etc.) and never need an event
//     listener. ---
const a11yOnlyIds = new Set(['workspaceTitle']);
for (const id of requiredIds) {
  if (a11yOnlyIds.has(id)) continue;
  if (!js.includes(id)) throw new Error(`Element ID ${id} exists in HTML but is not used in app.js`);
}

// --- app.js: forbidden runtime patterns (XSS, dead code). ---
for (const forbidden of [
  'innerHTML =',     // XSS-prone; CSP also blocks untrusted scripts
  'innerHTML=',      // same
  'gemini',          // not used anywhere in the app
  'eval(',           // not used anywhere
]) {
  if (js.includes(forbidden)) throw new Error(`Forbidden runtime pattern: ${forbidden}`);
}

// --- app.js: required runtime contracts. ---
for (const required of [
  // Provider paths
  '/openai/images', '/openai/videos', '/a2e',
  // Models
  'sora-2',
  // Storage + abort
  'localStorage', 'AbortController',
  // Album
  '/album/upload', '/album/save-from-url', '/album/',
  // Image processing
  'createImageBitmap', 'toDataURL',
  // LIMITS / size maps
  'LIMITS', 'OPENAI_SIZES', 'A2E_RESOLUTIONS',
  // IndexedDB
  'CurtisIndexedDb',
]) {
  if (!js.includes(required)) throw new Error(`Missing runtime contract: ${required}`);
}

// --- idb.js: must export the four functions the app calls. ---
for (const required of [
  'DB_NAME', 'STORE_REFERENCE', 'openDb',
  'putReference', 'getReference', 'deleteReference',
  'globalThis.CurtisIndexedDb',
]) {
  if (!idb.includes(required)) throw new Error(`idb.js missing required symbol: ${required}`);
}

// --- HTML must load both scripts in the right order. ---
if (!/idb\.js/.test(html)) throw new Error('index.html does not load idb.js');
if (!/app\.js/.test(html)) throw new Error('index.html does not load app.js');
const idbOrder = html.indexOf('idb.js');
const appOrder = html.indexOf('app.js');
if (idbOrder < 0 || appOrder < 0 || idbOrder > appOrder) {
  throw new Error('idb.js must be loaded BEFORE app.js (so globalThis.CurtisIndexedDb is set when app.js runs)');
}

// --- CSP must include the proxy origin. ---
if (!/connect-src/.test(html) || !/curtis-a2e-proxy\.onrender\.com/.test(html)) {
  throw new Error('CSP connect-src must allow https://curtis-a2e-proxy.onrender.com');
}

// --- CSS must include the .scene-error block (failed-scene UX). ---
if (!css.includes('.scene-error')) throw new Error('styles.css missing .scene-error block');

console.log(`Static contract OK (${ids.length} unique IDs, ${requiredIds.length} required, idb.js + app.js in order).`);

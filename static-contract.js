'use strict';
const fs = require('fs');
const path = require('path');
const root = __dirname;
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
if (duplicates.length) throw new Error(`Duplicate IDs: ${[...new Set(duplicates)].join(', ')}`);
for (const required of ['connectionPill', 'providerSelect', 'generateButton', 'sceneList', 'settingsDialog']) {
  if (!ids.includes(required)) throw new Error(`Missing required element: ${required}`);
}
for (const forbidden of ['innerHTML =', 'sora-2', 'gemini']) {
  if (js.includes(forbidden)) throw new Error(`Forbidden runtime pattern: ${forbidden}`);
}
for (const required of ['/openai/images', '/a2e', 'AbortController', 'sessionStorage']) {
  if (!js.includes(required)) throw new Error(`Missing runtime contract: ${required}`);
}
console.log(`Static contract OK (${ids.length} unique IDs).`);

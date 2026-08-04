'use strict';

const API_BASE = 'https://curtis-a2e-proxy.onrender.com';
const PROJECT_KEY = 'curtis-studio:project:v2';
// Credentials now persist in localStorage so they survive a page reload
// and a new tab. Use the Wipe button (top-right) to clear them.
// (We previously used sessionStorage, which silently dropped keys on
// tab close — that was a real footgun for non-technical users.)
const SESSION_KEY = 'curtis-studio:credentials:v2';

const elements = Object.fromEntries([
  'connectionPill', 'banner', 'referenceDrop', 'referenceFile', 'referenceUrl',
  'referencePreview', 'referenceEmpty', 'clearReferenceButton', 'scriptInput',
  'parseButton', 'addSceneButton', 'providerSelect', 'aspectSelect', 'qualitySelect',
  'styleInput', 'generateButton', 'createAllVideosButton', 'stopButton',
  'runProgress', 'progressText', 'sceneList', 'log', 'settingsButton',
  'settingsDialog', 'openaiKeyInput', 'a2eKeyInput', 'appTokenInput',
  'saveSettingsButton', 'wipeButton', 'downloadAllImagesButton',
  'downloadAllVideosButton', 'exportButton', 'importFile',
  'tab-setup', 'tab-scenes', 'tab-album', 'albumCount',
  'refreshAlbumButton', 'clearAlbumButton', 'albumGrid', 'albumSummary'
].map((id) => [id, document.getElementById(id)]));

const state = {
  scenes: [],
  reference: null,
  running: false,
  abortController: null,
};

function createId() {
  return globalThis.crypto?.randomUUID?.() || `scene-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function readCredentials() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveCredentials() {
  const credentials = {
    openaiKey: elements.openaiKeyInput.value.trim(),
    a2eKey: elements.a2eKeyInput.value.trim(),
    appToken: elements.appTokenInput.value.trim(),
  };
  localStorage.setItem(SESSION_KEY, JSON.stringify(credentials));
  updateGenerateLabel();
  setBanner('ok', 'Credentials saved in this browser. They survive page reloads. Use Wipe to clear.');
}

function providerHeaders(provider) {
  const credentials = readCredentials();
  const headers = { 'Content-Type': 'application/json' };
  if (provider === 'openai' && credentials.openaiKey) headers['x-openai-key'] = credentials.openaiKey;
  if (provider === 'a2e' && credentials.a2eKey) headers['x-a2e-key'] = credentials.a2eKey;
  if (credentials.appToken) headers['x-app-token'] = credentials.appToken;
  return headers;
}

function hasProviderKey(provider) {
  const credentials = readCredentials();
  return provider === 'openai' ? Boolean(credentials.openaiKey || credentials.appToken) : Boolean(credentials.a2eKey || credentials.appToken);
}

function setBanner(kind, message) {
  elements.banner.className = `banner ${kind}`;
  elements.banner.textContent = message;
}

function log(message, kind = '') {
  const row = document.createElement('div');
  row.className = `log-entry ${kind}`.trim();
  row.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  elements.log.append(row);
  elements.log.scrollTop = elements.log.scrollHeight;
}

function setProgress(current, total, message) {
  const percent = total ? Math.round((current / total) * 100) : 0;
  elements.runProgress.value = percent;
  elements.progressText.textContent = message;
}

function updateGenerateLabel() {
  const provider = elements.providerSelect.value;
  elements.generateButton.textContent = provider === 'a2e'
    ? 'Generate images + A2E clips'
    : 'Generate scene images';
}

function projectSnapshot() {
  return {
    version: 2,
    reference: state.reference,
    script: elements.scriptInput.value,
    provider: elements.providerSelect.value,
    aspect: elements.aspectSelect.value,
    quality: elements.qualitySelect.value,
    style: elements.styleInput.value,
    scenes: state.scenes.map(({ id, title, description, visual, voiceover }) => ({ id, title, description, visual, voiceover })),
  };
}

function saveProject() {
  try {
    localStorage.setItem(PROJECT_KEY, JSON.stringify(projectSnapshot()));
  } catch (error) {
    log(`Project could not be saved locally: ${error.message}`, 'error');
  }
}

function loadProject() {
  try {
    const project = JSON.parse(localStorage.getItem(PROJECT_KEY) || 'null');
    if (!project || project.version !== 2) return;
    state.reference = typeof project.reference === 'string' ? project.reference : null;
    elements.scriptInput.value = typeof project.script === 'string' ? project.script : '';
    elements.providerSelect.value = ['openai', 'a2e'].includes(project.provider) ? project.provider : 'openai';
    elements.aspectSelect.value = ['16:9', '9:16', '1:1'].includes(project.aspect) ? project.aspect : '16:9';
    elements.qualitySelect.value = ['low', 'medium', 'high'].includes(project.quality) ? project.quality : 'medium';
    elements.styleInput.value = typeof project.style === 'string' ? project.style : elements.styleInput.value;
    state.scenes = Array.isArray(project.scenes)
      ? project.scenes.slice(0, 50).map((scene, index) => ({
          id: typeof scene.id === 'string' ? scene.id : createId(),
          n: index + 1,
          title: String(scene.title || `Scene ${index + 1}`).slice(0, 120),
          description: String(scene.description || '').slice(0, 12000),
          visual: String(scene.visual || '').slice(0, 4000),
          voiceover: String(scene.voiceover || '').slice(0, 4000),
          imageStatus: 'idle', videoStatus: 'idle', imageUrl: null, videoUrl: null,
        }))
      : [];
    renderReference();
    renderScenes();
    updateGenerateLabel();
  } catch (error) {
    log(`Saved project was ignored: ${error.message}`, 'error');
  }
}

function renderReference() {
  if (state.reference) {
    elements.referencePreview.src = state.reference;
    elements.referencePreview.hidden = false;
    elements.referenceEmpty.hidden = true;
  } else {
    elements.referencePreview.removeAttribute('src');
    elements.referencePreview.hidden = true;
    elements.referenceEmpty.hidden = false;
  }
}

function makeSceneCard(scene) {
  const card = document.createElement('article');
  card.className = 'scene-card';

  const media = document.createElement('div');
  media.className = 'scene-media';
  if (scene.videoUrl) {
    const video = document.createElement('video');
    video.src = scene.videoUrl;
    video.controls = true;
    video.playsInline = true;
    media.append(video);
  } else if (scene.imageUrl) {
    const image = document.createElement('img');
    image.src = scene.imageUrl;
    image.alt = `Generated image for ${scene.title}`;
    media.append(image);
  } else {
    media.textContent = `Scene ${scene.n}`;
  }

  const body = document.createElement('div');
  body.className = 'scene-body';
  const titleRow = document.createElement('div');
  titleRow.className = 'scene-title-row';
  const title = document.createElement('h3');
  title.textContent = `${scene.n}. ${scene.title}`;
  const status = document.createElement('span');
  const combined = scene.videoStatus === 'running' || scene.imageStatus === 'running'
    ? 'running'
    : scene.videoStatus === 'failed' || scene.imageStatus === 'failed'
      ? 'failed'
      : scene.videoStatus === 'done' || scene.imageStatus === 'done'
        ? 'done'
        : 'idle';
  status.className = `status ${combined}`;
  status.textContent = combined;
  titleRow.append(title, status);

  const description = document.createElement('textarea');
  description.value = scene.description;
  description.setAttribute('aria-label', `Scene ${scene.n} description`);
  description.addEventListener('input', () => {
    scene.description = description.value;
    const fields = extractFields(scene.description);
    scene.visual = fields.visual;
    scene.voiceover = fields.voiceover;
    saveProject();
  });

  const actions = document.createElement('div');
  actions.className = 'button-row compact';
  const imageButton = actionButton('Regenerate image', async () => runSingleImage(scene));
  actions.append(imageButton);
  // Create video — wired to OpenAI sora-2 with A2E as fallback
  const videoButton = actionButton(
    scene.videoUrl ? 'Recreate clip' : 'Create video',
    async () => runSingleVideo(scene)
  );
  videoButton.title = 'Uses OpenAI Sora 2 first; falls back to A2E automatically.';
  actions.append(videoButton);
  if (scene.imageUrl) actions.append(actionButton('Download image', () => downloadAsset(scene.imageUrl, `scene-${scene.n}.png`, 'image/png'), 'ghost'));
  if (scene.videoUrl) actions.append(actionButton('Download clip', () => downloadAsset(scene.videoUrl, `scene-${scene.n}.mp4`, 'video/mp4'), 'ghost'));
  actions.append(actionButton('Delete', () => {
    state.scenes = state.scenes.filter((item) => item.id !== scene.id);
    renumberScenes();
    renderScenes();
    saveProject();
  }, 'danger'));

  body.append(titleRow, description, actions);
  card.append(media, body);
  return card;
}

function actionButton(label, handler, variant = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `button small ${variant}`.trim();
  button.textContent = label;
  button.disabled = state.running;
  button.addEventListener('click', handler);
  return button;
}

function renderScenes() {
  elements.sceneList.replaceChildren();
  if (!state.scenes.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No scenes yet. Parse a script or add a blank scene.';
    elements.sceneList.append(empty);
    return;
  }
  for (const scene of state.scenes) elements.sceneList.append(makeSceneCard(scene));
}

function renumberScenes() {
  state.scenes.forEach((scene, index) => { scene.n = index + 1; });
}

function extractFields(description) {
  const find = (name) => {
    const match = description.match(new RegExp(`(?:^|\\n)\\s*(?:[•*\\-]\\s*)?${name}\\s*:\\s*([^\\n]+)`, 'i'));
    return match ? match[1].replace(/^['“”"]|['“”"]$/g, '').trim() : '';
  };
  return {
    visual: find('Visual') || description.trim(),
    voiceover: find('Voiceover'),
  };
}

function parseScript(text) {
  const source = text.trim();
  if (!source) return [];
  const timedHeader = /^\s*\[(\d{1,2}:\d{2}(?:\.\d+)?\s*[–-]\s*\d{1,2}:\d{2}(?:\.\d+)?)\]\s*Scene\s+\d+\s*:\s*(.+)$/gim;
  const matches = [...source.matchAll(timedHeader)];
  const blocks = [];
  if (matches.length) {
    matches.forEach((match, index) => {
      const start = match.index;
      const end = matches[index + 1]?.index ?? source.length;
      blocks.push(source.slice(start, end).trim());
    });
  } else {
    blocks.push(...source.split(/^\s*---\s*$/m).map((block) => block.trim()).filter(Boolean));
  }
  return blocks.slice(0, 50).map((block, index) => {
    const lines = block.split(/\r?\n/);
    let titleLine = lines.shift()?.trim() || `Scene ${index + 1}`;
    titleLine = titleLine.replace(/^\[[^\]]+\]\s*/i, '').replace(/^Scene\s+\d+\s*:\s*/i, '');
    const description = lines.join('\n').trim() || titleLine;
    const fields = extractFields(description);
    return {
      id: createId(), n: index + 1, title: titleLine.slice(0, 120), description,
      visual: fields.visual, voiceover: fields.voiceover,
      imageStatus: 'idle', videoStatus: 'idle', imageUrl: null, videoUrl: null,
    };
  });
}

function aspectToOpenAISize(aspect) {
  if (aspect === '9:16') return '1024x1536';
  if (aspect === '1:1') return '1024x1024';
  return '1536x1024';
}

function sceneImagePrompt(scene) {
  const style = elements.styleInput.value.trim();
  return [
    style,
    `Scene title: ${scene.title}`,
    `Visual: ${scene.visual || scene.description}`,
    'Use the supplied reference image as the identity reference. Preserve the same adult person, facial structure, age, skin tone, hair, and distinctive features. Do not copy the reference background unless requested.',
  ].filter(Boolean).join('\n\n');
}

function sceneVideoPrompt(scene) {
  return [
    `Scene: ${scene.title}`,
    `Visual action: ${scene.visual || scene.description}`,
    scene.voiceover ? `Spoken line or atmosphere: ${scene.voiceover}` : '',
    'Preserve the identity and wardrobe shown in the source image. Natural motion, stable camera unless the scene requests movement.',
  ].filter(Boolean).join('\n\n');
}

async function apiRequest(path, provider, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { ...providerHeaders(provider), ...(options.headers || {}) },
    signal: state.abortController?.signal,
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { friendly: text.slice(0, 500) }; }
  if (!response.ok) {
    const error = new Error(body.friendly || body?.error?.message || `HTTP ${response.status}`);
    error.retryable = Boolean(body.retryable);
    error.status = response.status;
    throw error;
  }
  return body;
}

function a2eJobId(body) {
  return body?.data?._id || body?.data?.id || body?._id || body?.id || null;
}

function a2eState(body) {
  const data = body?.data || body;
  const value = String(data?.current_status || data?.status || '').toLowerCase();
  if (['completed', 'succeeded', 'success', 'done', 'finished'].includes(value)) return 'done';
  if (['failed', 'error', 'canceled', 'cancelled'].includes(value)) return 'failed';
  return 'running';
}

async function pollA2E(kind, id) {
  for (let attempt = 0; attempt < 72; attempt += 1) {
    const body = await apiRequest(`/a2e/status?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(id)}`, 'a2e', { method: 'GET' });
    const status = a2eState(body);
    const data = body.data || body;
    if (status === 'done') {
      return kind === 'image'
        ? data.image_urls?.[0] || data.image_url || data.result_url || data.output_url
        : data.result_url || data.video_url || data.output_url;
    }
    if (status === 'failed') throw new Error(data.failed_message || data.error || `A2E ${kind} job failed.`);
    await sleep(Math.min(2500 + attempt * 150, 6000));
  }
  throw new Error(`A2E ${kind} job timed out.`);
}

function sleep(ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    state.abortController?.signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Stopped', 'AbortError'));
    }, { once: true });
  });
}

async function generateOpenAIImage(scene) {
  const body = await apiRequest('/openai/images', 'openai', {
    method: 'POST',
    body: JSON.stringify({
      prompt: sceneImagePrompt(scene),
      input_reference: state.reference,
      size: aspectToOpenAISize(elements.aspectSelect.value),
      quality: elements.qualitySelect.value,
    }),
  });
  if (!body.image_url) throw new Error('OpenAI returned no image.');
  return body.image_url;
}

async function generateA2EImage(scene) {
  const body = await apiRequest('/a2e', 'a2e', {
    method: 'POST',
    body: JSON.stringify({
      action: 'image_start',
      prompt: sceneImagePrompt(scene),
      input_images: state.reference ? [state.reference] : [],
      aspectRatio: elements.aspectSelect.value,
      resolution: elements.qualitySelect.value === 'high' ? '4K' : elements.qualitySelect.value === 'low' ? '1K' : '2K',
    }),
  });
  const id = a2eJobId(body);
  if (!id) {
    const immediate = body?.data?.image_urls?.[0] || body?.data?.image_url;
    if (immediate) return immediate;
    throw new Error('A2E returned no image job ID.');
  }
  return pollA2E('image', id);
}

async function generateA2EVideo(scene) {
  const source = scene.imageUrl || state.reference;
  const body = await apiRequest('/a2e', 'a2e', {
    method: 'POST',
    body: JSON.stringify({
      action: 'video_start',
      image_url: source,
      prompt: sceneVideoPrompt(scene),
      aspectRatio: elements.aspectSelect.value,
      negative_prompt: 'deformed face, identity drift, blurry face, low quality, extra fingers',
    }),
  });
  const id = a2eJobId(body);
  if (!id) {
    const immediate = body?.data?.result_url || body?.data?.video_url;
    if (immediate) return immediate;
    throw new Error('A2E returned no video job ID.');
  }
  return pollA2E('video', id);
}

// OpenAI Sora 2 video (still live; scheduled for removal 2026-09-24).
// Returns the proxy URL of the completed video MP4 (the front-end
// streams the bytes from /openai/videos/:id/content).
async function generateOpenAIVideo(scene) {
  if (!hasProviderKey('openai')) throw new Error('OpenAI key missing.');
  const body = await apiRequest('/openai/videos', 'openai', {
    method: 'POST',
    body: JSON.stringify({
      prompt: sceneVideoPrompt(scene),
      model: 'sora-2',
      aspectRatio: elements.aspectSelect.value,
      duration: elements.qualitySelect.value === 'high' ? 'long' : 'short',
      input_reference: scene.imageUrl || state.reference || null,
    }),
  });
  if (!body.job_id) throw new Error('OpenAI returned no video job ID.');
  return pollOpenAIVideo(body.job_id);
}

async function pollOpenAIVideo(jobId) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const body = await apiRequest(`/openai/videos/${encodeURIComponent(jobId)}`, 'openai', { method: 'GET' });
    if (body.status === 'completed' && body.video_url) {
      // The proxy URL is relative; resolve against the proxy base so the
      // <video src=…> tag can stream the MP4 with the x-openai-key header
      // already attached by apiRequest. We use the proxy's /openai/videos
      // route directly with the key as a query token? No — the proxy
      // reads x-openai-key, not query. So we hand back a function that
      // builds a blob URL with the Authorization header proxied through
      // a fetch, since <video src=...> cannot set custom headers.
      return await fetchOpenAIVideoBytes(jobId);
    }
    if (body.status === 'failed') {
      throw new Error(body.error?.message || 'OpenAI video generation failed.');
    }
    await sleep(Math.min(2500 + attempt * 200, 6000));
  }
  throw new Error('OpenAI video job timed out.');
}

// Sora 2 returns the MP4 behind /v1/videos/:id/content which requires
// the Authorization header. The browser's <video src> cannot set custom
// headers, so we fetch the bytes (with the key) and turn them into a
// blob URL that the <video> tag CAN load.
async function fetchOpenAIVideoBytes(jobId) {
  const response = await fetch(`${API_BASE}/openai/videos/${encodeURIComponent(jobId)}/content`, {
    headers: providerHeaders('openai'),
    signal: state.abortController?.signal,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`OpenAI video download failed (${response.status}): ${text.slice(0, 200)}`);
  }
  const blob = await response.blob();
  return URL.createObjectURL(blob);
}

// Create a single scene's video. Tries OpenAI first (sora-2),
// falls back to A2E on auth/config error.
async function runSingleVideo(scene) {
  if (state.running) return;
  if (!scene.imageUrl && !state.reference) {
    setBanner('bad', 'Add a reference image or generate the scene image first.');
    return;
  }
  const useOpenAI = hasProviderKey('openai');
  const useA2E = hasProviderKey('a2e');
  if (!useOpenAI && !useA2E) {
    setBanner('bad', 'Open Settings and add an OpenAI or A2E key.');
    elements.settingsDialog.showModal();
    return;
  }
  state.running = true;
  state.abortController = new AbortController();
  scene.videoStatus = 'running';
  scene.videoUrl = null;
  renderScenes();
  try {
    let url = null;
    if (useOpenAI) {
      try {
        log(`Scene ${scene.n}: submitting Sora 2 clip (OpenAI).`);
        url = await generateOpenAIVideo(scene);
      } catch (openaiErr) {
        if (useA2E) {
          log(`Scene ${scene.n}: Sora 2 failed (${openaiErr.message}); falling back to A2E.`, 'warn');
          url = await generateA2EVideo(scene);
        } else {
          throw openaiErr;
        }
      }
    } else {
      log(`Scene ${scene.n}: submitting A2E clip.`);
      url = await generateA2EVideo(scene);
    }
    scene.videoUrl = url;
    scene.videoStatus = 'done';
    log(`Scene ${scene.n}: clip complete.`, 'success');
    setBanner('ok', `Scene ${scene.n} clip ready — click Download clip.`);
    // Save the clip to the album (best-effort).
    try {
      const videoResponse = await fetch(url);
      if (videoResponse.ok) {
        const blob = await videoResponse.blob();
        await saveToAlbum({
          kind: 'video', blob,
          prompt: sceneVideoPrompt(scene),
          title: `Scene ${scene.n} — ${scene.title}`,
          provider: scene.videoProvider || 'openai',
          scene_n: scene.n,
        });
      }
    } catch (e) { log(`Album clip save failed: ${e.message}`, 'warn'); }
  } catch (error) {
    scene.videoStatus = 'failed';
    setBanner('bad', error.message);
    log(`Scene ${scene.n} video failed: ${error.message}`, 'error');
  } finally {
    state.running = false;
    state.abortController = null;
    renderScenes();
  }
}

// Create videos for every scene that has an image. Tries OpenAI first,
// falls back to A2E per scene.
async function runAllVideos() {
  if (state.running) return;
  const scenes = state.scenes;
  if (!scenes.length) return setBanner('bad', 'Parse at least one scene first.');
  if (!hasProviderKey('openai') && !hasProviderKey('a2e')) {
    setBanner('bad', 'Open Settings and add an OpenAI or A2E key.');
    elements.settingsDialog.showModal();
    return;
  }
  state.running = true;
  state.abortController = new AbortController();
  setBanner('info', 'Creating clips for every scene that has an image…');
  let done = 0;
  for (const scene of scenes) {
    if (!scene.imageUrl && !state.reference) continue;
    scene.videoStatus = 'running';
    scene.videoUrl = null;
    renderScenes();
    try {
      let url = null;
      if (hasProviderKey('openai')) {
        try {
          log(`Scene ${scene.n}: submitting Sora 2 clip.`);
          url = await generateOpenAIVideo(scene);
        } catch (openaiErr) {
          if (hasProviderKey('a2e')) {
            log(`Scene ${scene.n}: Sora 2 failed (${openaiErr.message}); falling back to A2E.`, 'warn');
            url = await generateA2EVideo(scene);
          } else {
            throw openaiErr;
          }
        }
      } else {
        log(`Scene ${scene.n}: submitting A2E clip.`);
        url = await generateA2EVideo(scene);
      }
      scene.videoUrl = url;
      scene.videoStatus = 'done';
      log(`Scene ${scene.n}: clip complete.`, 'success');
      // Save the clip to the album. The proxy already auto-saves
      // successful /openai/videos responses, but we send it again from
      // the front-end so the album stays in sync no matter which path
      // produced the URL.
      try {
        const videoResponse = await fetch(url);
        if (videoResponse.ok) {
          const blob = await videoResponse.blob();
          await saveToAlbum({
            kind: 'video', blob,
            prompt: sceneVideoPrompt(scene),
            title: `Scene ${scene.n} — ${scene.title}`,
            provider: scene.videoProvider || 'openai',
            scene_n: scene.n,
          });
        }
      } catch (e) { log(`Album clip save failed: ${e.message}`, 'warn'); }
    } catch (error) {
      scene.videoStatus = 'failed';
      log(`Scene ${scene.n} video failed: ${error.message}`, 'error');
    }
    done += 1;
    setProgress(done, scenes.length, `Clips: ${done}/${scenes.length} done.`);
    renderScenes();
  }
  setBanner('ok', 'Clips complete. Click Download clip on any scene card.');
  state.running = false;
  state.abortController = null;
  renderScenes();
}

async function runSingleImage(scene) {
  if (state.running) return;
  await runPipeline([scene], false);
}

async function runPipeline(scenes = state.scenes, includeVideos = elements.providerSelect.value === 'a2e') {
  if (state.running) return;
  const provider = elements.providerSelect.value;
  if (!state.reference) return setBanner('bad', 'Add a valid reference image first.');
  if (!scenes.length) return setBanner('bad', 'Parse at least one scene first.');
  if (!hasProviderKey(provider)) {
    setBanner('bad', `Open Settings and add a ${provider === 'openai' ? 'OpenAI' : 'A2E'} key.`);
    elements.settingsDialog.showModal();
    return;
  }

  state.running = true;
  state.abortController = new AbortController();
  elements.generateButton.disabled = true;
  elements.stopButton.disabled = false;
  renderScenes();
  const operations = scenes.length * (includeVideos ? 2 : 1);
  let completed = 0;

  try {
    setBanner('info', `Generating with ${provider === 'openai' ? 'GPT Image 2' : 'A2E'}…`);
    for (const scene of scenes) {
      scene.imageStatus = 'running';
      scene.imageUrl = null;
      renderScenes();
      log(`Scene ${scene.n}: submitting image to ${provider}.`);
      scene.imageUrl = provider === 'openai'
        ? await generateOpenAIImage(scene)
        : await generateA2EImage(scene);
      scene.imageStatus = 'done';
      // Save a copy to the album so the user can re-download it from
      // the Album tab. Best-effort — failures here are logged but do
      // not fail the image response.
      try {
        const blob = await dataUrlToBlob(scene.imageUrl);
        await saveToAlbum({
          kind: 'image', blob,
          prompt: sceneImagePrompt(scene),
          title: `Scene ${scene.n} — ${scene.title}`,
          provider,
          scene_n: scene.n,
        });
      } catch (e) { log(`Album image save failed: ${e.message}`, 'warn'); }
      completed += 1;
      setProgress(completed, operations, `Scene ${scene.n} image complete.`);
      log(`Scene ${scene.n}: image complete.`, 'success');
      renderScenes();

      if (includeVideos) {
        scene.videoStatus = 'running';
        renderScenes();
        log(`Scene ${scene.n}: submitting A2E clip from the approved scene image.`);
        scene.videoUrl = await generateA2EVideo(scene);
        scene.videoStatus = 'done';
        completed += 1;
        setProgress(completed, operations, `Scene ${scene.n} clip complete.`);
        log(`Scene ${scene.n}: clip complete.`, 'success');
        renderScenes();
      }
    }
    setBanner('ok', includeVideos
      ? 'All scene images and A2E clips are ready. Download clips from each scene.'
      : 'All scene images are ready.');
    setProgress(operations, operations, 'Complete');
  } catch (error) {
    const stopped = error.name === 'AbortError';
    for (const scene of scenes) {
      if (scene.imageStatus === 'running') scene.imageStatus = stopped ? 'idle' : 'failed';
      if (scene.videoStatus === 'running') scene.videoStatus = stopped ? 'idle' : 'failed';
    }
    setBanner(stopped ? 'warn' : 'bad', stopped ? 'Generation stopped.' : error.message);
    log(stopped ? 'Generation stopped by user.' : error.message, stopped ? '' : 'error');
    setProgress(completed, operations, stopped ? 'Stopped' : 'Failed');
  } finally {
    state.running = false;
    state.abortController = null;
    elements.generateButton.disabled = false;
    elements.stopButton.disabled = true;
    renderScenes();
  }
}

// ----- Tabs -----
function switchTab(name) {
  if (!name) return;
  for (const id of ['tab-setup', 'tab-scenes', 'tab-album']) {
    const tab = elements[id];
    const isActive = tab?.dataset.tab === name;
    if (tab) {
      tab.classList.toggle('active', isActive);
      tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
    }
  }
  for (const panel of document.querySelectorAll('[data-tab-content]')) {
    panel.hidden = panel.dataset.tabContent !== name;
  }
  if (name === 'album') refreshAlbum();
}

// ----- Album -----
// Wraps fetch with the same provider key headers the rest of the app uses.
async function albumFetch(path, options = {}) {
  // Album reads are public (the bytes are stored on the proxy). Writes
  // (POST upload) need no auth — they're over the proxy, and the proxy
  // trusts the front-end origin via CORS. If the operator later sets
  // APP_PROXY_TOKEN we forward x-app-token so the proxy can use the
  // env-stored keys for any provider-specific operation.
  const credentials = readCredentials();
  const headers = { ...(options.headers || {}) };
  if (credentials.appToken) headers['x-app-token'] = credentials.appToken;
  const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  if (!response.ok) {
    let body = {};
    try { body = await response.json(); } catch {}
    throw new Error(body.friendly || body?.error?.message || `HTTP ${response.status}`);
  }
  return response.json();
}

async function refreshAlbum() {
  if (!elements.albumGrid) return;
  try {
    const body = await albumFetch('/album');
    renderAlbum(body);
  } catch (error) {
    elements.albumSummary.textContent = `Album unavailable: ${error.message}`;
    elements.albumGrid.replaceChildren();
  }
}

function renderAlbum(body) {
  const { items = [], count = 0, total_bytes = 0, cap_entries, cap_bytes } = body;
  // Tab badge
  if (elements.albumCount) {
    elements.albumCount.hidden = !count;
    elements.albumCount.textContent = count;
  }
  // Summary
  const totalMb = (total_bytes / 1024 / 1024).toFixed(1);
  const capMb = cap_bytes ? (cap_bytes / 1024 / 1024).toFixed(0) : '?';
  const capEnt = cap_entries || '?';
  elements.albumSummary.textContent = count
    ? `${count} item${count === 1 ? '' : 's'} · ${totalMb} MB of ${capMb} MB · capped at ${capEnt} entries`
    : 'No images or clips saved yet. Generate a scene and it will appear here.';

  elements.albumGrid.replaceChildren();
  for (const item of items) elements.albumGrid.append(makeAlbumCard(item));
}

function makeAlbumCard(item) {
  const card = document.createElement('article');
  card.className = 'album-card';

  const thumb = document.createElement('div');
  thumb.className = 'album-thumb';
  if (item.kind === 'video') {
    const video = document.createElement('video');
    video.src = `${API_BASE}${item.url}`;
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.addEventListener('mouseenter', () => video.play().catch(() => {}));
    video.addEventListener('mouseleave', () => video.pause());
    thumb.append(video);
    const badge = document.createElement('span');
    badge.className = 'album-kind';
    badge.textContent = 'video';
    thumb.append(badge);
  } else {
    const img = document.createElement('img');
    img.src = `${API_BASE}${item.url}`;
    img.alt = item.prompt || item.title || 'Album image';
    img.loading = 'lazy';
    thumb.append(img);
    const badge = document.createElement('span');
    badge.className = 'album-kind';
    badge.textContent = 'image';
    thumb.append(badge);
  }
  card.append(thumb);

  const meta = document.createElement('div');
  meta.className = 'album-meta';
  const title = document.createElement('p');
  title.className = 'album-title';
  title.textContent = item.title || item.prompt || `${item.kind} from ${new Date(item.created_at).toLocaleString()}`;
  meta.append(title);
  const sub = document.createElement('p');
  sub.className = 'album-sub muted';
  const subBits = [];
  if (item.provider) subBits.push(item.provider);
  if (item.width && item.height) subBits.push(`${item.width}×${item.height}`);
  if (item.bytes) subBits.push(`${(item.bytes / 1024 / 1024).toFixed(2)} MB`);
  subBits.push(new Date(item.created_at).toLocaleDateString());
  sub.textContent = subBits.join(' · ');
  meta.append(sub);
  card.append(meta);

  const actions = document.createElement('div');
  actions.className = 'button-row compact';
  const ext = item.kind === 'video' ? 'mp4' : 'png';
  const filename = `${item.title || item.kind}-${item.id}.${ext}`;
  actions.append(actionButton('Download',
    () => downloadAsset(`${API_BASE}${item.url}`, filename, item.mime), 'primary'));
  actions.append(actionButton('Delete', async () => {
    if (!confirm(`Delete this ${item.kind}?`)) return;
    try {
      await albumFetch(`/album/${item.id}`, { method: 'DELETE' });
      log(`Album ${item.kind} deleted.`);
      refreshAlbum();
    } catch (error) {
      setBanner('bad', `Delete failed: ${error.message}`);
    }
  }, 'danger'));
  card.append(actions);
  return card;
}

async function clearAlbum() {
  if (!confirm('Delete every image and clip from the album? (Your saved project and keys are untouched.)')) return;
  try {
    const body = await albumFetch('/album', { method: 'DELETE' });
    log(`Album cleared. ${body.deleted || 0} item(s) removed.`);
    refreshAlbum();
  } catch (error) {
    setBanner('bad', `Clear failed: ${error.message}`);
  }
}

// Save a generated asset to the album. Called from the image and video
// completion paths. dataUrlOrBlob is the bytes we already have; if the
// proxy already auto-saved the asset (it does, for /openai/images and
// /openai/videos/:id/content), we still POST the bytes from the
// front-end so the album stays in sync even if the proxy missed it.
async function saveToAlbum({ kind, blob, prompt, title, provider, scene_n }) {
  try {
    const mime = kind === 'video' ? 'video/mp4' : 'image/png';
    const params = new URLSearchParams({ kind });
    if (prompt) params.set('prompt', prompt);
    if (title) params.set('title', title);
    if (provider) params.set('provider', provider);
    if (typeof scene_n === 'number') params.set('scene_n', String(scene_n));
    const response = await fetch(`${API_BASE}/album/upload?${params}`, {
      method: 'POST',
      headers: { 'Content-Type': mime },
      body: blob,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    const body = await response.json();
    log(`Album: saved ${kind} (${body.id}).`);
    refreshAlbum();
    return body.id;
  } catch (error) {
    log(`Album save failed: ${error.message}`, 'warn');
    return null;
  }
}

// Convert a data: URL (the typical OpenAI image response) to a Blob.
async function dataUrlToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return res.blob();
}


//   - data: URLs pass straight through
//   - blob: URLs pass straight through
//   - https: URLs that point back to our proxy need the same auth the
//     front-end already has (x-openai-key / x-a2e-key), so we fetch
//     them with the right header and wrap the result in a blob URL
async function downloadAsset(url, filename, mime = 'application/octet-stream') {
  try {
    if (!url) throw new Error('No URL to download.');
    let href = url;
    if (/^https:\/\//.test(url) && url.includes(API_BASE)) {
      // Same-origin via the proxy. The asset is public for reads (the
      // proxy signs the bytes itself), but if it's the OpenAI Sora bytes
      // route the proxy reads x-openai-key from the request, so we
      // forward whichever provider the URL came from.
      const provider = url.includes('/openai/') ? 'openai' : 'a2e';
      const response = await fetch(url, { headers: providerHeaders(provider) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      href = URL.createObjectURL(blob);
    }
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = filename;
    anchor.rel = 'noopener';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    if (href !== url) setTimeout(() => URL.revokeObjectURL(href), 1000);
  } catch (error) {
    setBanner('bad', `Download failed: ${error.message}`);
  }
}

// Bulk download: iterate every scene, give each one a short delay so the
// browser does not collapse them into a single file. The user gets N
// downloads (one per scene) — standard for "Download all" UX.
function downloadAllImages() {
  const scenes = state.scenes.filter((scene) => scene.imageUrl);
  if (!scenes.length) return setBanner('warn', 'No scene images are ready yet.');
  setBanner('info', `Downloading ${scenes.length} image${scenes.length === 1 ? '' : 's'}…`);
  scenes.forEach((scene, index) => {
    setTimeout(() => downloadAsset(scene.imageUrl, `scene-${scene.n}.png`, 'image/png'), index * 200);
  });
}

function downloadAllVideos() {
  const scenes = state.scenes.filter((scene) => scene.videoUrl);
  if (!scenes.length) return setBanner('warn', 'No scene clips are ready yet.');
  setBanner('info', `Downloading ${scenes.length} clip${scenes.length === 1 ? '' : 's'}…`);
  scenes.forEach((scene, index) => {
    setTimeout(() => downloadAsset(scene.videoUrl, `scene-${scene.n}.mp4`, 'video/mp4'), index * 200);
  });
}

async function resizeImage(file) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Choose a JPEG, PNG, or WebP image.');
  if (file.size > 12 * 1024 * 1024) throw new Error('Image must be 12 MB or smaller.');
  const source = await createImageBitmap(file);
  const max = 1600;
  const scale = Math.min(1, max / Math.max(source.width, source.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  canvas.getContext('2d', { alpha: false }).drawImage(source, 0, 0, canvas.width, canvas.height);
  source.close();
  return canvas.toDataURL('image/jpeg', .9);
}

async function setReferenceFile(file) {
  try {
    state.reference = await resizeImage(file);
    elements.referenceUrl.value = '';
    renderReference();
    saveProject();
    setBanner('ok', 'Reference image ready.');
  } catch (error) {
    setBanner('bad', error.message);
  }
}

async function setReferenceUrl() {
  const value = elements.referenceUrl.value.trim();
  if (!value) return;
  let url;
  try { url = new URL(value); } catch { return setBanner('bad', 'Enter a valid HTTPS image URL.'); }
  if (url.protocol !== 'https:') return setBanner('bad', 'Reference URLs must use HTTPS.');
  const testImage = new Image();
  testImage.referrerPolicy = 'no-referrer';
  testImage.onload = () => {
    state.reference = value;
    renderReference();
    saveProject();
    setBanner('ok', 'Reference URL loaded.');
  };
  testImage.onerror = () => setBanner('bad', 'The reference URL could not be loaded as an image.');
  testImage.src = value;
}

async function probeProxy() {
  elements.connectionPill.className = 'pill checking';
  elements.connectionPill.textContent = 'Checking proxy…';
  try {
    const response = await fetch(`${API_BASE}/healthz`, { cache: 'no-store' });
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error(`HTTP ${response.status}`);
    elements.connectionPill.className = 'pill ok';
    elements.connectionPill.textContent = `Proxy online · v${body.version || '?'}`;
  } catch (error) {
    elements.connectionPill.className = 'pill bad';
    elements.connectionPill.textContent = 'Proxy unavailable';
    elements.connectionPill.title = error.message;
  }
}

function exportProject() {
  const blob = new Blob([JSON.stringify(projectSnapshot(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  downloadUrl(url, `curtis-project-${new Date().toISOString().slice(0, 10)}.json`);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function importProject(file) {
  try {
    if (file.size > 5 * 1024 * 1024) throw new Error('Project file is too large.');
    const project = JSON.parse(await file.text());
    if (project.version !== 2 || !Array.isArray(project.scenes)) throw new Error('Unsupported project format.');
    localStorage.setItem(PROJECT_KEY, JSON.stringify(project));
    state.scenes = [];
    state.reference = null;
    loadProject();
    setBanner('ok', 'Project imported.');
  } catch (error) {
    setBanner('bad', `Import failed: ${error.message}`);
  } finally {
    elements.importFile.value = '';
  }
}

function wireEvents() {
  elements.referenceFile.addEventListener('change', () => {
    const file = elements.referenceFile.files?.[0];
    if (file) setReferenceFile(file);
  });
  elements.referenceUrl.addEventListener('change', setReferenceUrl);
  elements.clearReferenceButton.addEventListener('click', () => {
    state.reference = null;
    elements.referenceUrl.value = '';
    elements.referenceFile.value = '';
    renderReference();
    saveProject();
    setBanner('info', 'Reference cleared.');
  });
  for (const eventName of ['dragenter', 'dragover']) {
    elements.referenceDrop.addEventListener(eventName, (event) => {
      event.preventDefault();
      elements.referenceDrop.classList.add('drag');
    });
  }
  for (const eventName of ['dragleave', 'drop']) {
    elements.referenceDrop.addEventListener(eventName, (event) => {
      event.preventDefault();
      elements.referenceDrop.classList.remove('drag');
    });
  }
  elements.referenceDrop.addEventListener('drop', (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (file) setReferenceFile(file);
  });
  elements.referenceDrop.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') elements.referenceFile.click();
  });
  elements.parseButton.addEventListener('click', () => {
    const scenes = parseScript(elements.scriptInput.value);
    if (!scenes.length) return setBanner('bad', 'The script does not contain any scenes.');
    state.scenes = scenes;
    renderScenes();
    saveProject();
    setBanner('ok', `Parsed ${scenes.length} scene${scenes.length === 1 ? '' : 's'}.`);
  });
  elements.addSceneButton.addEventListener('click', () => {
    state.scenes.push({
      id: createId(), n: state.scenes.length + 1, title: `Scene ${state.scenes.length + 1}`,
      description: '', visual: '', voiceover: '', imageStatus: 'idle', videoStatus: 'idle', imageUrl: null, videoUrl: null,
    });
    renderScenes();
    saveProject();
  });
  elements.providerSelect.addEventListener('change', () => { updateGenerateLabel(); saveProject(); });
  elements.aspectSelect.addEventListener('change', saveProject);
  elements.qualitySelect.addEventListener('change', saveProject);
  elements.styleInput.addEventListener('change', saveProject);
  elements.scriptInput.addEventListener('change', saveProject);
  elements.generateButton.addEventListener('click', () => runPipeline());
  elements.createAllVideosButton.addEventListener('click', () => runAllVideos());
  elements.stopButton.addEventListener('click', () => state.abortController?.abort());
  elements.downloadAllImagesButton.addEventListener('click', downloadAllImages);
  elements.downloadAllVideosButton.addEventListener('click', downloadAllVideos);
  elements.settingsButton.addEventListener('click', () => elements.settingsDialog.showModal());
  elements.saveSettingsButton.addEventListener('click', saveCredentials);
  elements.wipeButton.addEventListener('click', () => {
    if (!confirm('Delete the saved project AND all saved API keys (OpenAI, A2E, app token) from this browser?')) return;
    localStorage.removeItem(PROJECT_KEY);
    localStorage.removeItem(SESSION_KEY);
    location.reload();
  });
  elements.exportButton.addEventListener('click', exportProject);
  elements.importFile.addEventListener('change', () => {
    const file = elements.importFile.files?.[0];
    if (file) importProject(file);
  });
  // Tabs
  for (const tab of [elements['tab-setup'], elements['tab-scenes'], elements['tab-album']]) {
    if (tab) tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  }
  // Album
  elements.refreshAlbumButton.addEventListener('click', () => refreshAlbum());
  elements.clearAlbumButton.addEventListener('click', () => clearAlbum());
}

function init() {
  const credentials = readCredentials();
  elements.openaiKeyInput.value = credentials.openaiKey || '';
  elements.a2eKeyInput.value = credentials.a2eKey || '';
  elements.appTokenInput.value = credentials.appToken || '';
  wireEvents();
  loadProject();
  switchTab('setup');
  refreshAlbum();
  renderReference();
  renderScenes();
  updateGenerateLabel();
  probeProxy();
  if (state.reference && state.scenes.length) setBanner('ok', `${state.scenes.length} saved scene${state.scenes.length === 1 ? '' : 's'} ready.`);
}

init();

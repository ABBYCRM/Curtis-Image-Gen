'use strict';

const API_BASE = 'https://curtis-a2e-proxy.onrender.com';
const PROJECT_KEY = 'curtis-studio:project:v2';
// Credentials now persist in localStorage so they survive a page reload
// and a new tab. Use the Wipe button (top-right) to clear them.
// (We previously used sessionStorage, which silently dropped keys on
// tab close — that was a real footgun for non-technical users.)
const SESSION_KEY = 'curtis-studio:credentials:v2';

// All hard-coded limits and timings live here so they're easy to
// find and tweak. Any value that has bitten us in production goes
// in this block, with a comment explaining why.
const LIMITS = {
  // Script parser
  MAX_SCENES: 50,                // hard cap on the number of scenes in one run
  MAX_TITLE_CHARS: 120,          // fits comfortably in a scene card
  MAX_DESCRIPTION_CHARS: 12000,  // ~3k words, well above any reasonable script
  MAX_FIELD_CHARS: 4000,         // visual / voiceover per scene

  // Reference image
  REFERENCE_MAX_EDGE: 1600,      // px; the long edge is resized to this
  REFERENCE_JPEG_QUALITY: 0.9,   // 0.9 looks visually lossless at 1600px
  REFERENCE_MAX_FILE_BYTES: 12 * 1024 * 1024,  // 12 MB upload limit

  // Album
  ALBUM_DOWNLOAD_STAGGER_MS: 200, // delay between two bulk-downloads

  // A2E polling (image + video)
  A2E_POLL_MAX_ATTEMPTS: 72,     // ~3 minutes at the long end of the backoff
  A2E_POLL_BASE_MS: 2500,
  A2E_POLL_STEP_MS: 150,
  A2E_POLL_CAP_MS: 6000,

  // OpenAI Sora 2 polling
  OPENAI_VIDEO_POLL_MAX_ATTEMPTS: 90,  // Sora 2 is slower than A2E
  OPENAI_VIDEO_POLL_BASE_MS: 2500,
  OPENAI_VIDEO_POLL_STEP_MS: 200,
  OPENAI_VIDEO_POLL_CAP_MS: 6000,

  // Cold-start UX
  PROXY_HEALTHZ_TIMEOUT_MS: 8000,     // above this we assume Render free-tier cold start
  PROXY_HEALTHZ_SLOW_THRESHOLD_MS: 3000,
  GENERATION_RETRY_MAX: 1,             // retry a once on transient 5xx / network error
  GENERATION_RETRY_BACKOFF_MS: 1500,
};

// OpenAI supported image sizes per aspect ratio
const OPENAI_SIZES = {
  '16:9': '1536x1024',
  '9:16': '1024x1536',
  '1:1':  '1024x1024',
};

// A2E resolution mapping
const A2E_RESOLUTIONS = {
  low:    '1K',
  medium: '2K',
  high:   '4K',
};

const elements = Object.fromEntries([
  'connectionPill', 'banner', 'referenceDrop', 'referenceFile', 'referenceUrl',
  'referencePreview', 'referenceEmpty', 'clearReferenceButton', 'scriptInput',
  'parseButton', 'addSceneButton', 'providerSelect', 'aspectSelect', 'qualitySelect',
  'styleInput', 'storyboardCheck', 'generateButton', 'createAllVideosButton', 'stopButton',
  'runProgress', 'progressText', 'sceneList', 'log', 'settingsButton',
  'settingsDialog', 'openaiKeyInput', 'a2eKeyInput',
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
  // storyboard: when true, runPipeline stops after the stills (no
  // Sora 2). Use this for fast iteration on the script and style
  // — once every scene looks right, flip it off and run Generate
  // again to promote the stills to clips. Default true so a brand
  // new user doesn't burn $5 in Sora 2 minutes on a script
  // they're still editing.
  storyboard: true,
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
  };
  localStorage.setItem(SESSION_KEY, JSON.stringify(credentials));
  updateGenerateLabel();
  updateCreateAllVideosButton();
  setBanner('ok', 'Credentials saved in this browser. They survive page reloads. Use Wipe to clear.');
}

function providerHeaders(provider) {
  const credentials = readCredentials();
  const headers = { 'Content-Type': 'application/json' };
  if (provider === 'openai' && credentials.openaiKey) headers['x-openai-key'] = credentials.openaiKey;
  if (provider === 'a2e' && credentials.a2eKey) headers['x-a2e-key'] = credentials.a2eKey;
  return headers;
}

function hasProviderKey(provider) {
  const credentials = readCredentials();
  return provider === 'openai' ? Boolean(credentials.openaiKey) : Boolean(credentials.a2eKey);
}

function setBanner(kind, message, actionLabel = null, onAction = null) {
  elements.banner.className = `banner ${kind}`;
  // Wipe any prior action button so banners don't accumulate.
  elements.banner.replaceChildren();
  const text = document.createElement('span');
  text.textContent = message;
  elements.banner.append(text);
  if (actionLabel && typeof onAction === 'function') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button ghost small banner-action';
    button.textContent = actionLabel;
    button.addEventListener('click', onAction);
    elements.banner.append(button);
  }
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
  // The button label reflects what's actually about to happen, so
  // the user always knows whether Sora 2 minutes are about to be
  // spent. Storyboard mode (default ON) skips video entirely —
  // uncheck it when ready to promote stills to clips.
  const hasVideoKey = hasProviderKey('openai') || hasProviderKey('a2e');
  if (state.storyboard) {
    elements.generateButton.textContent = 'Storyboard scenes';
    elements.generateButton.title = 'Generates 1K stills only — no Sora 2 minutes will be spent. Uncheck the Storyboard mode box below when every scene looks right, then click Generate again to promote stills to video clips.';
  } else {
    elements.generateButton.textContent = hasVideoKey
      ? 'Generate images + videos'
      : 'Generate images';
    elements.generateButton.title = hasVideoKey
      ? 'Generates the scene image and the video clip for every scene in one click. OpenAI Sora 2 first for video, A2E fallback.'
      : 'Add a video provider key in Settings to also generate clips.';
  }
  updateCreateAllVideosButton();
}

// Enable Create all videos only when at least one scene has an
// image ready and at least one video provider key is configured.
// The button is always visible (so the user can see the option
// exists) but disabled with a helpful title when there's nothing
// to create.
function updateCreateAllVideosButton() {
  if (!elements.createAllVideosButton) return;
  const hasVideoProvider = hasProviderKey('openai') || hasProviderKey('a2e');
  const hasImageReady = state.scenes.some((s) => s.imageUrl);
  const ready = hasVideoProvider && hasImageReady && !state.running;
  elements.createAllVideosButton.disabled = !ready;
  elements.createAllVideosButton.title = !hasVideoProvider
    ? 'Add an OpenAI or A2E key in Settings to enable video generation.'
    : !hasImageReady
      ? 'Generate scene images first — clips need a source frame.'
      : state.running
        ? 'Generation already in progress…'
        : 'OpenAI Sora 2 first, A2E as fallback.';
}

function projectSnapshot() {
  // Note: state.reference is intentionally NOT included here. The
  // reference image is a data: URL that can be 0.8-2.5 MB; storing it
  // in the project blob in localStorage was the source of the quota
  // bomb that silently lost the user's work. The reference now lives
  // in IndexedDB (see idb.js) and is fetched on demand.
  return {
    version: 2,
    reference_present: state.reference ? 'data' : null,
    script: elements.scriptInput.value,
    provider: elements.providerSelect.value,
    aspect: elements.aspectSelect.value,
    quality: elements.qualitySelect.value,
    style: elements.styleInput.value,
    storyboard: state.storyboard,
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
    // The reference now lives in IndexedDB; load it asynchronously.
    // We don't await it here so the rest of the UI (script, scenes,
    // settings) renders immediately. The reference drop will fill in
    // once the IndexedDB read returns.
    elements.scriptInput.value = typeof project.script === 'string' ? project.script : '';
    elements.providerSelect.value = ['openai', 'a2e'].includes(project.provider) ? project.provider : 'openai';
    elements.aspectSelect.value = ['16:9', '9:16', '1:1'].includes(project.aspect) ? project.aspect : '16:9';
    elements.qualitySelect.value = ['low', 'medium', 'high'].includes(project.quality) ? project.quality : 'medium';
    elements.styleInput.value = typeof project.style === 'string' ? project.style : elements.styleInput.value;
    state.storyboard = project.storyboard !== false;  // default true for new users
    if (elements.storyboardCheck) elements.storyboardCheck.checked = state.storyboard;
    state.scenes = Array.isArray(project.scenes)
      ? project.scenes.slice(0, LIMITS.MAX_SCENES).map((scene, index) => ({
          id: typeof scene.id === 'string' ? scene.id : createId(),
          n: index + 1,
          title: String(scene.title || `Scene ${index + 1}`).slice(0, LIMITS.MAX_TITLE_CHARS),
          description: String(scene.description || '').slice(0, LIMITS.MAX_DESCRIPTION_CHARS),
          visual: String(scene.visual || '').slice(0, LIMITS.MAX_FIELD_CHARS),
          voiceover: String(scene.voiceover || '').slice(0, LIMITS.MAX_FIELD_CHARS),
          imageStatus: 'idle', videoStatus: 'idle', imageUrl: null, videoUrl: null,
        }))
      : [];
    renderReference();
    renderScenes();
    updateGenerateLabel();
    // Pull the reference from IndexedDB (with a fallback to the
    // legacy localStorage field for users who had a v1 save before
    // the migration — that field is the *only* place the old
    // reference could have been, and we silently retire it now).
    loadReferenceFromIdb().catch((err) => {
      log(`Reference could not be restored: ${err.message}`, 'warn');
    });
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
      : scene.videoStatus === 'skipped' && scene.imageStatus === 'done'
        ? 'skipped'
        : scene.videoStatus === 'done' || scene.imageStatus === 'done'
          ? 'done'
          : 'idle';
  status.className = `status ${combined}`;
  status.textContent = combined;
  // Surface the last error on the badge so the user can see it
  // without scrolling to the run log. The combined status already
  // reflects image + video; pick the most recent error to display.
  const lastError = scene.videoError || scene.imageError;
  if (lastError && (combined === 'failed' || combined === 'skipped')) {
    status.title = lastError;
    status.classList.add('has-error');
  }
  titleRow.append(title, status);

  // Inline error message — visible on the card itself when the
  // image or video failed OR when the video was skipped. The
  // .scene-error class is reused for both; the message + status
  // tell the user which.
  if (lastError && (combined === 'failed' || combined === 'skipped')) {
    const errorBanner = document.createElement('p');
    errorBanner.className = 'scene-error';
    errorBanner.textContent = lastError;
    body.append(titleRow);
    body.append(errorBanner);
  } else {
    body.append(titleRow);
  }

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
  // Create video — only when there's an image to animate from.
  // Previously the button was always visible, which led to "why is
  // it failing when I click Create video with no image?" confusion.
  // (The runSingleVideo guard refused anyway, but the user had to
  // click to find out.)
  if (scene.imageUrl) {
    const videoLabel = scene.videoUrl
      ? 'Recreate clip'
      : scene.videoStatus === 'skipped'
        ? 'Try clip again'
        : 'Create video';
    const videoButton = actionButton(videoLabel, async () => runSingleVideo(scene));
    videoButton.title = scene.videoStatus === 'skipped'
      ? 'Sora 2 was skipped earlier (likely gated). This will retry the video for this scene.'
      : 'Uses OpenAI Sora 2 first; falls back to A2E automatically.';
    actions.append(videoButton);
  }
  if (scene.imageUrl) actions.append(actionButton('Download image', () => downloadAsset(scene.imageUrl, `scene-${scene.n}.png`, 'image/png'), 'ghost'));
  if (scene.videoUrl) actions.append(actionButton('Download clip', () => downloadAsset(scene.videoUrl, `scene-${scene.n}.mp4`, 'video/mp4'), 'ghost'));
  actions.append(actionButton('Delete', () => {
    state.scenes = state.scenes.filter((item) => item.id !== scene.id);
    renumberScenes();
    renderScenes();
    saveProject();
  }, 'danger'));

  body.append(description, actions);
  card.append(media, body);
  return card;
}

function actionButton(label, handler, variant = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `button small ${variant}`.trim();
  button.textContent = label;
  // NOTE: scene-card and album-card buttons are NOT disabled while
  // a generation is running. The user should be able to download or
  // delete an existing asset even while a new one is being generated.
  // The state.running flag is for the top-level Run/Stop controls
  // (Generate, Create all videos, Stop) and the per-scene Regenerate
  // image / Recreate clip buttons, not for the passive Download /
  // Delete / Clear actions.
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
  updateCreateAllVideosButton();
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
  return blocks.slice(0, LIMITS.MAX_SCENES).map((block, index) => {
    const lines = block.split(/\r?\n/);
    let titleLine = lines.shift()?.trim() || `Scene ${index + 1}`;
    titleLine = titleLine.replace(/^\[[^\]]+\]\s*/i, '').replace(/^Scene\s+\d+\s*:\s*/i, '');
    const description = lines.join('\n').trim() || titleLine;
    const fields = extractFields(description);
    return {
      id: createId(), n: index + 1, title: titleLine.slice(0, LIMITS.MAX_TITLE_CHARS), description,
      visual: fields.visual, voiceover: fields.voiceover,
      imageStatus: 'idle', videoStatus: 'idle', imageUrl: null, videoUrl: null,
    };
  });
}

function aspectToOpenAISize(aspect) {
  return OPENAI_SIZES[aspect] || OPENAI_SIZES['16:9'];
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
  // Retry once on transient errors (5xx, network). Up to
  // GENERATION_RETRY_MAX retries with a small backoff. The
  // generation abort signal still wins: if the user clicks
  // Stop, the AbortError propagates and the retry does not
  // run.
  let attempt = 0;
  while (true) {
    try {
      const response = await fetch(`${API_BASE}${path}`, {
        ...options,
        headers: { ...providerHeaders(provider), ...(options.headers || {}) },
        signal: state.abortController?.signal,
      });
      const text = await response.text();
      let body;
      try { body = JSON.parse(text); } catch { body = { friendly: text.slice(0, 500) }; }
      if (!response.ok) {
        // Make the cause obvious: a 401 with `invalid_api_key` is
        // ALWAYS a key problem (typo, rotated, missing project
        // access). A 429 is ALWAYS a rate-limit problem. A 5xx
        // is the upstream being unhappy. The user should not have
        // to read the proxy's response body to know which.
        const upstreamMessage = body.friendly || body?.error?.message || `HTTP ${response.status}`;
        const upstreamCode = body?.error?.code || '';
        const actionable = body.actionable || null;
        const codeFromProxy = body?.error?.code || '';
        let humanMessage = upstreamMessage;
        let kind = 'provider_error';
        if (response.status === 401 && upstreamCode === 'invalid_api_key') {
          humanMessage = `OpenAI rejected your API key (HTTP 401). The key is wrong, rotated, or lacks project access. Open Settings, paste a fresh key from https://platform.openai.com/account/api-keys, and Save.`;
          kind = 'invalid_key';
        } else if (codeFromProxy === 'openai_org_not_verified') {
          humanMessage = `Sora 2 is gated: your OpenAI organization is not verified. Go to https://platform.openai.com/settings/organization/general and click Verify Organization (phone + ID required). Allow up to 15 minutes for access to propagate. Until then, the video phase is skipped and the image phase continues.`;
          kind = 'sora_org_not_verified';
        } else if (codeFromProxy === 'openai_model_not_enabled') {
          humanMessage = `Your OpenAI project does not have access to this model. Enable it at https://platform.openai.com/settings/project (Limits → Model Usage), or switch the Provider dropdown to A2E and re-run.`;
          kind = 'sora_model_not_enabled';
        } else if (codeFromProxy === 'openai_billing_issue') {
          humanMessage = `OpenAI suspended access for billing. Settle the outstanding invoice at https://platform.openai.com/account/billing, or switch to A2E.`;
          kind = 'billing_issue';
        } else if (response.status === 401 && codeFromProxy === 'missing_provider_key') {
          humanMessage = `A ${provider === 'openai' ? 'OpenAI' : 'A2E'} API key is required. Open Settings, paste a key, and Save.`;
          kind = 'missing_key';
        } else if (response.status === 403) {
          humanMessage = `Provider returned HTTP 403 (forbidden). The key may lack access to this endpoint (e.g. Sora 2 is gated). Open Settings to check your key, or try the A2E provider.`;
          kind = 'forbidden';
        } else if (response.status === 429) {
          humanMessage = `Provider rate-limited the request (HTTP 429). Wait a minute and try again, or use a smaller batch.`;
          kind = 'rate_limited';
        } else if (response.status >= 500) {
          humanMessage = `The provider is having trouble (HTTP ${response.status}). ${upstreamMessage}`;
          kind = 'upstream_5xx';
        }
        const error = new Error(humanMessage);
        error.retryable = Boolean(body.retryable) || response.status >= 500;
        error.status = response.status;
        error.upstreamCode = upstreamCode;
        error.actionable = actionable;
        error.kind = kind;
        throw error;
      }
      return body;
    } catch (error) {
      const transient = !error.status
        || error.status === 429
        || (error.status >= 500 && error.status < 600)
        || error.retryable;
      if (!transient || attempt >= LIMITS.GENERATION_RETRY_MAX) throw error;
      attempt += 1;
      log(`${path} failed (${error.message}); retrying in ${LIMITS.GENERATION_RETRY_BACKOFF_MS}ms…`, 'warn');
      await sleep(LIMITS.GENERATION_RETRY_BACKOFF_MS);
    }
  }
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
  for (let attempt = 0; attempt < LIMITS.A2E_POLL_MAX_ATTEMPTS; attempt += 1) {
    const body = await apiRequest(`/a2e/status?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(id)}`, 'a2e', { method: 'GET' });
    const status = a2eState(body);
    const data = body.data || body;
    if (status === 'done') {
      return kind === 'image'
        ? data.image_urls?.[0] || data.image_url || data.result_url || data.output_url
        : data.result_url || data.video_url || data.output_url;
    }
    if (status === 'failed') throw new Error(data.failed_message || data.error || `A2E ${kind} job failed.`);
    await sleep(Math.min(LIMITS.A2E_POLL_BASE_MS + attempt * LIMITS.A2E_POLL_STEP_MS, LIMITS.A2E_POLL_CAP_MS));
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
      resolution: A2E_RESOLUTIONS[elements.qualitySelect.value] || A2E_RESOLUTIONS.medium,
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
  for (let attempt = 0; attempt < LIMITS.OPENAI_VIDEO_POLL_MAX_ATTEMPTS; attempt += 1) {
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
    await sleep(Math.min(LIMITS.OPENAI_VIDEO_POLL_BASE_MS + attempt * LIMITS.OPENAI_VIDEO_POLL_STEP_MS, LIMITS.OPENAI_VIDEO_POLL_CAP_MS));
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
  scene.videoError = null;
  scene.videoUrl = null;
  renderScenes();
  try {
    let url = null;
    let provider = 'openai';
    if (useOpenAI) {
      try {
        log(`Scene ${scene.n}: submitting Sora 2 clip (OpenAI).`);
        url = await generateOpenAIVideo(scene);
      } catch (openaiErr) {
        if (useA2E) {
          log(`Scene ${scene.n}: Sora 2 failed (${openaiErr.message}); falling back to A2E.`, 'warn');
          url = await generateA2EVideo(scene);
          provider = 'a2e';
        } else {
          throw openaiErr;
        }
      }
    } else {
      log(`Scene ${scene.n}: submitting A2E clip.`);
      url = await generateA2EVideo(scene);
      provider = 'a2e';
    }
    scene.videoUrl = url;
    scene.videoProvider = provider;
    scene.videoStatus = 'done';
    scene.videoError = null;
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
          provider,
          scene_n: scene.n,
        });
      }
    } catch (e) { log(`Album clip save failed: ${e.message}`, 'warn'); }
  } catch (error) {
    scene.videoStatus = 'failed';
    scene.videoError = error.message || String(error);
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
    scene.videoError = null;
    scene.videoUrl = null;
    renderScenes();
    try {
      let url = null;
      let provider = 'openai';
      if (hasProviderKey('openai')) {
        try {
          log(`Scene ${scene.n}: submitting Sora 2 clip.`);
          url = await generateOpenAIVideo(scene);
        } catch (openaiErr) {
          if (hasProviderKey('a2e')) {
            log(`Scene ${scene.n}: Sora 2 failed (${openaiErr.message}); falling back to A2E.`, 'warn');
            url = await generateA2EVideo(scene);
            provider = 'a2e';
          } else {
            throw openaiErr;
          }
        }
      } else {
        log(`Scene ${scene.n}: submitting A2E clip.`);
        url = await generateA2EVideo(scene);
        provider = 'a2e';
      }
      scene.videoUrl = url;
      scene.videoProvider = provider;
      scene.videoStatus = 'done';
      scene.videoError = null;
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
            provider,
            scene_n: scene.n,
          });
        }
      } catch (e) { log(`Album clip save failed: ${e.message}`, 'warn'); }
    } catch (error) {
      scene.videoStatus = 'failed';
      scene.videoError = error.message || String(error);
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

async function runPipeline(scenes = state.scenes, includeVideos = true) {
  if (state.running) return;
  const provider = elements.providerSelect.value;
  if (!state.reference) return setBanner('bad', 'Add a valid reference image first.');
  if (!scenes.length) return setBanner('bad', 'Parse at least one scene first.');
  if (!hasProviderKey(provider)) {
    setBanner('bad', `Open Settings and add a ${provider === 'openai' ? 'OpenAI' : 'A2E'} key.`);
    elements.settingsDialog.showModal();
    return;
  }
  // Storyboard mode (default ON) overrides includeVideos — the
  // user wants to iterate on stills only, no Sora 2 spend.
  if (state.storyboard) includeVideos = false;

  state.running = true;
  state.abortController = new AbortController();
  elements.generateButton.disabled = true;
  elements.stopButton.disabled = false;
  renderScenes();
  const operations = scenes.length * (includeVideos ? 2 : 1);
  let completed = 0;

  try {
    setBanner('info', state.storyboard
      ? `Storyboarding ${scenes.length} scene${scenes.length === 1 ? '' : 's'} — 1K stills only. No Sora 2 minutes will be spent.`
      : `Generating with ${provider === 'openai' ? 'GPT Image 2' : 'A2E'}…`);
    for (const scene of scenes) {
      scene.imageStatus = 'running';
      scene.imageError = null;
      scene.imageUrl = null;
      renderScenes();
      log(`Scene ${scene.n}: submitting image to ${provider}.`);
      try {
        // Try the user's selected provider first; on any failure
        // (auth, content moderation, size, network) fall back to
        // A2E if the user has a key for it. The fallback was only
        // present on the video path before — the image path silently
        // failed if OpenAI rejected the request, leaving the user
        // with a 'failed' card and no clue.
        if (provider === 'openai') {
          try {
            scene.imageUrl = await generateOpenAIImage(scene);
          } catch (openaiErr) {
            if (hasProviderKey('a2e')) {
              log(`Scene ${scene.n}: OpenAI image failed (${openaiErr.message}); falling back to A2E.`, 'warn');
              scene.imageUrl = await generateA2EImage(scene);
              scene.imageProvider = 'a2e';
            } else {
              throw openaiErr;
            }
          }
        } else {
          scene.imageUrl = await generateA2EImage(scene);
          scene.imageProvider = 'a2e';
        }
      } catch (imgErr) {
        scene.imageStatus = 'failed';
        scene.imageError = imgErr.message || String(imgErr);
        scene.imageUrl = null;
        throw imgErr;
      }
      scene.imageStatus = 'done';
      scene.imageError = null;
      // Convert the (possibly cross-origin) image URL into a same-origin
      // blob URL so per-scene Download works without a cross-origin
      // fetch. Browsers do NOT honor `<a download=...>` on cross-origin
      // URLs — the click would just navigate to the URL. We fetch the
      // bytes through the proxy (which already saves to the album
      // anyway) and synthesize a blob URL. The blob URL is then used
      // for the scene card's `<img>` source, the per-scene Download
      // button, and the album-uploaded bytes.
      //
      // If `dataUrlToBlob` fails (e.g. CSP blocks the cross-origin
      // fetch) fall back to the original URL — the album tab still
      // works because it uses the proxy's saved copy.
      try {
        const blob = await dataUrlToBlob(scene.imageUrl);
        const blobUrl = URL.createObjectURL(blob);
        scene.imageUrl = blobUrl;
        // Save the same bytes to the album.
        await saveToAlbum({
          kind: 'image', blob,
          prompt: sceneImagePrompt(scene),
          title: `Scene ${scene.n} — ${scene.title}`,
          provider: scene.imageProvider || provider,
          scene_n: scene.n,
        });
      } catch (e) { log(`Album image save failed: ${e.message}`, 'warn'); }
      completed += 1;
      setProgress(completed, operations, `Scene ${scene.n} image complete.`);
      log(`Scene ${scene.n}: image complete.`, 'success');
      renderScenes();

      if (includeVideos) {
        // Skip the entire video phase if no video provider key is
        // configured. The user can add a key and re-run, or use
        // the per-scene Recreate clip button later.
        if (!hasProviderKey('openai') && !hasProviderKey('a2e')) {
          scene.videoStatus = 'failed';
          scene.videoError = 'No video provider key configured — add OpenAI or A2E in Settings to enable clips.';
          log(`Scene ${scene.n}: no video provider key, skipping clip.`, 'warn');
          completed += 1;
          setProgress(completed, operations, `Scene ${scene.n} video skipped.`);
          renderScenes();
          continue;
        }
        scene.videoStatus = 'running';
        scene.videoError = null;
        renderScenes();
        // Hybrid video path: OpenAI Sora 2 first, A2E on any error.
        // Same logic as the per-scene Create video button so the
        // one-click Generate and the per-scene button give the same
        // result. setVideoError happens in the catch below.
        try {
          let url = null;
          let vidProvider = 'openai';
          if (hasProviderKey('openai')) {
            try {
              log(`Scene ${scene.n}: submitting Sora 2 clip.`);
              url = await generateOpenAIVideo(scene);
            } catch (openaiErr) {
              // Three distinct fall-through paths after a Sora 2
              // failure:
              //  1. A2E key set → try A2E
              //  2. Sora 2 is gated (org not verified / model not
              //     enabled / billing) and no A2E key → mark the
              //     VIDEO as "skipped" (not "failed") and continue
              //     with the image phase. The banner turns warn,
              //     not bad.
              //  3. Any other Sora 2 error → surface it as "failed".
              if (hasProviderKey('a2e')) {
                log(`Scene ${scene.n}: Sora 2 failed (${openaiErr.message}); falling back to A2E.`, 'warn');
                url = await generateA2EVideo(scene);
                vidProvider = 'a2e';
              } else if (openaiErr.kind === 'sora_org_not_verified'
                  || openaiErr.kind === 'sora_model_not_enabled'
                  || openaiErr.kind === 'billing_issue') {
                // Soft-skip: the image succeeded, the video is
                // gated. Don't fail the run; the user can fix
                // access at platform.openai.com and re-run clips.
                log(`Scene ${scene.n}: Sora 2 is gated for this project. Skipping clip.`, 'warn');
                scene.videoStatus = 'skipped';
                scene.videoError = openaiErr.message;
                scene.videoSkipKind = openaiErr.kind;
                // Throw a sentinel to jump out of the inner try
                // without re-running the "scene.videoStatus = 'done'"
                // block below.
                throw { __skip: true, message: openaiErr.message, kind: openaiErr.kind };
              } else {
                throw openaiErr;
              }
            }
          } else if (hasProviderKey('a2e')) {
            log(`Scene ${scene.n}: submitting A2E clip.`);
            url = await generateA2EVideo(scene);
            vidProvider = 'a2e';
          }
          // If neither provider has a key, just skip the video
          // (the user can still get the images and add a key
          // later for the next run). Don't fail the whole run.
          // Convert the (possibly cross-origin) video URL into a
          // same-origin blob URL so per-scene Download works.
          // Browsers do NOT honor `<a download=...>` on cross-origin
          // URLs — the click would just navigate. The blob URL is
          // used for the scene card's `<video>` source, the per-scene
          // Download button, and the album-uploaded bytes.
          let videoBlobUrl = null;
          try {
            const videoResponse = await fetch(url);
            if (videoResponse.ok) {
              const blob = await videoResponse.blob();
              videoBlobUrl = URL.createObjectURL(blob);
              await saveToAlbum({
                kind: 'video', blob,
                prompt: sceneVideoPrompt(scene),
                title: `Scene ${scene.n} — ${scene.title}`,
                provider: vidProvider,
                scene_n: scene.n,
              });
            }
          } catch (e) { log(`Album clip save failed: ${e.message}`, 'warn'); }
          // Prefer the blob URL (same-origin, works for `<a download>`).
          // Fall back to the remote URL if blob creation failed.
          scene.videoUrl = videoBlobUrl || url;
          scene.videoProvider = vidProvider;
          scene.videoStatus = 'done';
          scene.videoError = null;
        } catch (vidErr) {
          // The Sora-2-gated path throws a sentinel object with
          // __skip: true; honor it without re-stamping the status.
          if (vidErr && vidErr.__skip) {
            log(`Scene ${scene.n}: ${vidErr.message}`, 'warn');
            if (!state.videoSkips) state.videoSkips = [];
            state.videoSkips.push({ n: scene.n, kind: vidErr.kind, message: vidErr.message });
          } else {
            scene.videoStatus = 'failed';
            scene.videoError = (vidErr && vidErr.message) || String(vidErr);
            scene.videoUrl = null;
            log(`Scene ${scene.n} video failed: ${scene.videoError}`, 'error');
            if (!state.videoFailures) state.videoFailures = [];
            state.videoFailures.push({ n: scene.n, message: scene.videoError });
          }
          // Don't re-throw — a single failed / skipped video
          // shouldn't stop the rest of the pipeline. The user can
          // re-run a single scene's video from the scene card.
        }
        completed += 1;
        setProgress(completed, operations, `Scene ${scene.n} ${scene.videoStatus === 'done' ? 'clip complete' : 'video skipped'}.`);
        log(scene.videoStatus === 'done'
          ? `Scene ${scene.n}: clip complete.`
          : `Scene ${scene.n}: video skipped (see card for details).`,
          scene.videoStatus === 'done' ? 'success' : 'warn');
        renderScenes();
      }
    }
    // Banner tone depends on what happened:
    //  - all videos done, all images done → "ok" (green)
    //  - some videos skipped because Sora 2 is gated → "warn"
    //    (yellow) with the actionable next step
    //  - some videos failed for other reasons → "warn" with
    //    the count + first reason
    //  - images failed → "bad" (red) — surfaced by the outer catch
    const skipCount = (state.videoSkips || []).length;
    const failCount = (state.videoFailures || []).length;
    const videoOk = (state.scenes || []).filter((s) => s.videoStatus === 'done').length;
    state.videoSkips = [];
    state.videoFailures = [];
    if (state.storyboard) {
      setBanner('ok', 'Storyboard done. Review each scene, then uncheck "Storyboard mode" and Generate again to promote the stills to Sora 2 clips.');
    } else if (skipCount > 0 && includeVideos) {
      const firstSkip = state.videoSkips && state.videoSkips[0];
      const msg = `All scene images are ready. ${skipCount} clip${skipCount === 1 ? '' : 's'} skipped — ${firstSkip?.message || 'Sora 2 is gated for this project.'} Add an A2E key in Settings to render clips via A2E.`;
      setBanner('warn', msg);
    } else if (failCount > 0 && videoOk > 0 && includeVideos) {
      setBanner('warn', `All scene images are ready. ${videoOk} clip${videoOk === 1 ? '' : 's'} complete; ${failCount} failed (see scene cards for details).`);
    } else {
      setBanner('ok', includeVideos
        ? 'All scene images and clips are ready. Open the Album tab to download.'
        : 'All scene images are ready.');
    }
    setProgress(operations, operations, 'Complete');
  } catch (error) {
    const stopped = error.name === 'AbortError';
    let anyImageFailed = false;
    for (const scene of scenes) {
      if (scene.imageStatus === 'running') {
        scene.imageStatus = stopped ? 'idle' : 'failed';
        if (!stopped) {
          scene.imageError = error.message || String(error);
          anyImageFailed = true;
        }
      }
      if (scene.videoStatus === 'running') {
        scene.videoStatus = stopped ? 'idle' : 'failed';
        if (!stopped) scene.videoError = error.message || String(error);
      }
    }
    if (stopped) {
      setBanner('warn', 'Generation stopped.');
    } else if (anyImageFailed && !hasProviderKey('a2e') && elements.providerSelect.value === 'openai') {
      // Image failed on OpenAI and the user has no A2E key. Offer a
      // one-click switch to the A2E provider. The user can still
      // type a new A2E key first; the button is just a shortcut.
      setBanner(
        'bad',
        error.message,
        'Switch to A2E',
        () => {
          elements.providerSelect.value = 'a2e';
          elements.providerSelect.dispatchEvent(new Event('change', { bubbles: true }));
          setBanner('info', 'Switched to A2E. Add an A2E key in Settings, then re-run Generate.');
        }
      );
    } else {
      setBanner('bad', error.message);
    }
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

async function migrateLegacyReference() {
  if (!globalThis.CurtisIndexedDb?.isAvailable()) return;
  // If the user already has a v2 reference in IndexedDB, skip the
  // migration — the most recent upload wins.
  const existing = await globalThis.CurtisIndexedDb.getReference();
  if (existing) return;
  // Look for a v1-style project blob that still inlines the
  // reference field. If we find one, copy the data URL into
  // IndexedDB and rewrite the project blob to the v2 shape.
  let project;
  try { project = JSON.parse(localStorage.getItem(PROJECT_KEY) || 'null'); }
  catch { return; }
  if (!project || project.version !== 2) return;
  if (typeof project.reference !== 'string' || !project.reference.startsWith('data:')) return;
  await globalThis.CurtisIndexedDb.putReference(project.reference);
  log('Migrated reference image from localStorage to IndexedDB.');
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
  // trusts the front-end origin via CORS. The proxy's APP_PROXY_TOKEN
  // env var is server-only; the front-end never sends x-app-token.
  const headers = { ...(options.headers || {}) };
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
    // The proxy's APP_PROXY_TOKEN is server-side; the front-end
    // never sends x-app-token. The proxy rejects no token for
    // writes that don't need auth.
    const headers = { 'Content-Type': mime };
    const response = await fetch(`${API_BASE}/album/upload?${params}`, {
      method: 'POST',
      headers,
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
// We do this with a manual base64 decode + Uint8Array so we don't need
// to fetch the data: URL (the front-end's CSP forbids fetching from
// data: origins via the connect-src directive).
async function dataUrlToBlob(url) {
  // Two URL flavors are accepted:
  //   - data:image/png;base64,…  — OpenAI image responses in b64_json
  //     mode. Decode the base64 directly to bytes.
  //   - https://…                — OpenAI image responses in url mode
  //     (the default). Fetch the bytes via the proxy (CORS-allowed)
  //     and return them as a blob.
  //
  // Why not fetch the data URL? data: URLs are blocked by Chrome's CSP
  // connect-src (see do-app-platform-curl memory). The base64 path is
  // safer — we never invoke fetch on a data URL.
  if (typeof url !== 'string' || !url) throw new Error('Empty URL.');
  if (url.startsWith('data:')) {
    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(url);
    if (!match) throw new Error('Not a base64 data URL');
    const bytes = Uint8Array.from(atob(match[2].replace(/\s/g, '')), (c) => c.charCodeAt(0));
    return new Blob([bytes], { type: match[1] });
  }
  // Remote URL — fetch via the proxy if cross-origin, else fetch
  // directly. The proxy is the same origin as the front-end, so we
  // can stream any same-origin remote URL through it.
  let fetchUrl = url;
  if (!url.startsWith(`${API_BASE}/`) && !url.startsWith('/')) {
    // Cross-origin remote URL. Route through the proxy's
    // /album/save-from-url, then read back from the album.
    const save = await fetch(`${API_BASE}/album/save-from-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'image', url, prompt: 'download', title: 'download' }),
    });
    if (!save.ok) throw new Error(`Proxy save-from-url failed (HTTP ${save.status}).`);
    const saved = await save.json();
    fetchUrl = `${API_BASE}${saved.url}`;
  }
  const resp = await fetch(fetchUrl);
  if (!resp.ok) throw new Error(`Fetch failed (HTTP ${resp.status}).`);
  return resp.blob();
}

// Save bytes the browser to disk. Three URL forms are supported:
//   - data:  URLs (OpenAI image responses): the browser handles the save
//   - blob:  URLs (Sora 2 byte streams):     the browser handles the save
//   - https: URLs (proxy /album/ bytes):     the browser handles the save
// All three are public, anonymous reads — none of them need an auth
// header. We just click an anchor with a `download` attribute. The
// previous fetch+blob approach was here, but it triggered a CORS
// preflight race in some browsers and offered no benefit since the
// proxy already sends the bytes with the right Content-Disposition.
async function downloadAsset(url, filename, mime = 'application/octet-stream') {
  try {
    if (!url) throw new Error('No URL to download.');
    // The scene card's URL is now a same-origin blob: URL (the image
    // and video paths convert the cross-origin remote URL into a blob
    // immediately after generation). The album's URL is /album/... on
    // the same proxy origin. Both are same-origin, so the anchor +
    // download trick works directly.
    //
    // The OLD bug: scene.imageUrl was a cross-origin OpenAI URL
    // (oaidalleapiprodscus.blob.core.windows.net/...). Browsers do
    // NOT honor `<a download=...>` on cross-origin URLs — the click
    // navigated to the URL instead of downloading. Fix: convert the
    // URL to a blob at generation time (above). Now downloadAsset is
    // back to the simple anchor pattern.
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
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
    setTimeout(() => downloadAsset(scene.imageUrl, `scene-${scene.n}.png`, 'image/png'), index * LIMITS.ALBUM_DOWNLOAD_STAGGER_MS);
  });
}

function downloadAllVideos() {
  const scenes = state.scenes.filter((scene) => scene.videoUrl);
  if (!scenes.length) return setBanner('warn', 'No scene clips are ready yet.');
  setBanner('info', `Downloading ${scenes.length} clip${scenes.length === 1 ? '' : 's'}…`);
  scenes.forEach((scene, index) => {
    setTimeout(() => downloadAsset(scene.videoUrl, `scene-${scene.n}.mp4`, 'video/mp4'), index * LIMITS.ALBUM_DOWNLOAD_STAGGER_MS);
  });
}

async function resizeImage(file) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Choose a JPEG, PNG, or WebP image.');
  if (file.size > LIMITS.REFERENCE_MAX_FILE_BYTES) throw new Error('Image must be 12 MB or smaller.');
  const source = await createImageBitmap(file);
  const scale = Math.min(1, LIMITS.REFERENCE_MAX_EDGE / Math.max(source.width, source.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  canvas.getContext('2d', { alpha: false }).drawImage(source, 0, 0, canvas.width, canvas.height);
  source.close();
  return canvas.toDataURL('image/jpeg', LIMITS.REFERENCE_JPEG_QUALITY);
}

async function setReferenceFile(file) {
  try {
    const dataUrl = await resizeImage(file);
    await saveReferenceToIdb(dataUrl);
    state.reference = dataUrl;
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
  // Fetch the URL through the proxy so the bytes live on the same
  // origin we serve from. The proxy's /album/save-from-url will
  // download the URL, run the SSRF guard, and write the bytes into
  // a data URL we can put in IndexedDB. If the proxy is offline
  // we fall back to using the URL directly (the front-end can send
  // an HTTPS URL as input_reference to GPT Image 2 / A2E without
  // conversion).
  try {
    const headers = { 'Content-Type': 'application/json' };
    const response = await fetch(`${API_BASE}/album/save-from-url`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        kind: 'image',
        url: value,
        prompt: 'reference image',
        title: 'Reference (from URL)',
      }),
    });
    if (response.ok) {
      const body = await response.json();
      // Re-read the bytes from the album so we end up with a data
      // URL in IndexedDB. This costs one round-trip but keeps the
      // SSRF guard, the size probe, and the same-origin story
      // consistent for both file uploads and URL references.
      const r2 = await fetch(`${API_BASE}${body.url}`);
      if (r2.ok) {
        const blob = await r2.blob();
        const dataUrl = await blobToDataUrl(blob);
        await saveReferenceToIdb(dataUrl);
        state.reference = dataUrl;
        renderReference();
        saveProject();
        setBanner('ok', 'Reference URL loaded through the proxy.');
        return;
      }
    }
  } catch (error) {
    // Log the proxy failure so the user can see why the URL was
    // not proxied — the fallback below uses the URL as-is, which
    // can be slower and may fail downstream if the host blocks the
    // proxy. The original error is the most useful diagnostic.
    log(`Proxy reference fetch failed (${error.message}); using URL directly.`, 'warn');
  }
  // Fallback: keep the URL as-is. The provider endpoints accept an
  // HTTPS URL for input_reference; the proxy resizes with sharp if
  // needed. This is the behavior we had before the IndexedDB
  // migration, kept for resilience.
  state.reference = value;
  renderReference();
  saveProject();
  setBanner('ok', 'Reference URL loaded (direct — proxy offline?).');
}

async function saveReferenceToIdb(dataUrl) {
  if (!globalThis.CurtisIndexedDb?.isAvailable()) {
    log('IndexedDB unavailable; reference will not survive a reload.', 'warn');
    return;
  }
  try {
    await globalThis.CurtisIndexedDb.putReference(dataUrl);
  } catch (error) {
    log(`Reference could not be written to IndexedDB: ${error.message}`, 'warn');
  }
}

async function loadReferenceFromIdb() {
  if (!globalThis.CurtisIndexedDb?.isAvailable()) return;
  const dataUrl = await globalThis.CurtisIndexedDb.getReference();
  if (dataUrl) {
    state.reference = dataUrl;
    renderReference();
  }
}

async function clearReferenceInIdb() {
  if (!globalThis.CurtisIndexedDb?.isAvailable()) return;
  try { await globalThis.CurtisIndexedDb.deleteReference(); }
  catch (error) { log(`IndexedDB clear failed: ${error.message}`, 'warn'); }
}

// Blob -> data URL (manual base64 path so we don't fight the CSP).
async function blobToDataUrl(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  const base64 = btoa(binary);
  return `data:${blob.type || 'application/octet-stream'};base64,${base64}`;
}

async function probeProxy() {
  elements.connectionPill.className = 'pill checking';
  elements.connectionPill.textContent = 'Checking proxy…';
  const started = Date.now();
  try {
    // Use an AbortController so a slow /healthz (Render free-tier
    // cold start can take 30-60s) doesn't hang the banner forever.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LIMITS.PROXY_HEALTHZ_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(`${API_BASE}/healthz`, { cache: 'no-store', signal: controller.signal });
    } finally { clearTimeout(timer); }
    // 429 means the proxy is up but is rate-limiting us. The pill
    // shouldn't claim the proxy is "unavailable" — that misleads the
    // user into debugging a non-problem. Show a distinct busy state.
    if (response.status === 429) {
      elements.connectionPill.className = 'pill bad';
      elements.connectionPill.textContent = 'Proxy busy';
      elements.connectionPill.title = 'Rate limit hit on the healthz probe. Wait a minute and the next request will succeed.';
      return;
    }
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error(`HTTP ${response.status}`);
    const elapsed = Date.now() - started;
    if (elapsed > LIMITS.PROXY_HEALTHZ_SLOW_THRESHOLD_MS) {
      log(`Proxy woke up in ${(elapsed/1000).toFixed(1)}s — Render free-tier cold start is the usual cause.`);
    }
    elements.connectionPill.className = 'pill ok';
    elements.connectionPill.textContent = `Proxy online · v${body.version || '?'}`;
  } catch (error) {
    elements.connectionPill.className = 'pill bad';
    elements.connectionPill.textContent = 'Proxy unreachable';
    elements.connectionPill.title = `${error.message}. The proxy may be down or your network may be blocking the request.`;
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
    // Reset the input so the user can re-pick the SAME file (the
    // 'change' event only fires when the selected file changes).
    elements.referenceFile.value = '';
  });
  elements.referenceUrl.addEventListener('change', setReferenceUrl);
  elements.clearReferenceButton.addEventListener('click', async () => {
    state.reference = null;
    elements.referenceUrl.value = '';
    elements.referenceFile.value = '';
    renderReference();
    saveProject();
    await clearReferenceInIdb();
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
  elements.storyboardCheck.addEventListener('change', () => {
    state.storyboard = elements.storyboardCheck.checked;
    updateGenerateLabel();
    saveProject();
  });
  elements.aspectSelect.addEventListener('change', saveProject);
  elements.qualitySelect.addEventListener('change', saveProject);
  elements.styleInput.addEventListener('change', saveProject);
  elements.scriptInput.addEventListener('change', saveProject);
  elements.generateButton.addEventListener('click', () => runPipeline());
  elements.createAllVideosButton.addEventListener('click', () => runAllVideos());
  // The Create all videos button is only useful when at least one
  // scene is image-ready and at least one video provider key is
  // configured. Disabled state is updated after every state change
  // by updateCreateAllVideosButton().
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
  wireEvents();
  // One-time migration: if a v1 project blob had a reference field
  // inlined as a data URL, copy it to IndexedDB and clear the legacy
  // field. v2 snapshots use reference_present instead.
  migrateLegacyReference().catch(() => {});
  loadProject();
  // Make sure the storyboard checkbox matches the loaded state
  // even on first run (when loadProject is a no-op).
  if (elements.storyboardCheck) elements.storyboardCheck.checked = state.storyboard;
  switchTab('setup');
  refreshAlbum();
  renderReference();
  renderScenes();
  updateGenerateLabel();
  probeProxy();
  if (state.reference && state.scenes.length) setBanner('ok', `${state.scenes.length} saved scene${state.scenes.length === 1 ? '' : 's'} ready.`);
}

init();

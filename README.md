# Curtis Image Studio

A static browser app for generating consistent scene images and short video clips from one reference photo and a script. The live deployment is at **<https://curtis-image-gen.onrender.com>**, served by the companion proxy at **<https://curtis-a2e-proxy.onrender.com>**.

The app is a single self-contained HTML page (no build step, no framework, no third-party runtime). All generation happens server-side through the proxy, so the app works in any modern browser and is phone-friendly.

## What it does

- Parse a script (timed headers `[0:00 - 0:04] Scene N: Title` or `---` separators).
- One click does **images + videos** for every scene. OpenAI GPT Image 2 for stills (with A2E fallback), OpenAI Sora 2 for clips (with A2E fallback).
- Persist every successful image and clip to the **Album** tab so you can re-download them across browser sessions and tabs.

## Supported production paths

| Provider | Image | Video | Notes |
|----------|-------|-------|-------|
| **OpenAI GPT Image 2** (`gpt-image-2`) | yes (multipart `/v1/images/edits` with `input_reference`, or `/v1/images/generations`) | — | face-locked when a reference is supplied |
| **OpenAI Sora 2** (`sora-2`) | — | yes (4 / 8 / 12 second clips) | **scheduled for removal 2026-09-24** — fallback path below is the long-term story |
| **A2E** `userNanoBanana` / `userImage2Video` | yes | yes | long-term video path; used automatically when Sora fails or is missing |

The Create Video button tries **OpenAI Sora 2 first**, then falls back to A2E on any error (auth, content moderation, size mismatch, etc.). The fallback is logged so the user can see which path produced each clip.

## Security model

- **Provider keys are stored in `localStorage`** (not `sessionStorage`) so they survive page reloads and new tabs. The Wipe button under Settings clears both project data and credentials.
- Project structure (script, scenes, prompt text) lives in `localStorage`. The **resized reference image is stored in IndexedDB** (`public/idb.js`) so the project blob never approaches the per-origin `localStorage` quota. A migration (`migrateLegacyReference`) copies any v1 inlined data URL into IndexedDB on first load.
- The app has a strict Content Security Policy in a `<meta http-equiv="Content-Security-Policy">` tag. No third-party scripts, no third-party fonts, no external analytics.
- The proxy never exposes env-stored provider keys to anonymous callers. If `APP_PROXY_TOKEN` is set on the proxy, callers must send the matching `x-app-token` header to use those keys.
- All XSS-prone fields use `textContent` (never `innerHTML`). A static contract check (`static-contract.js`) blocks the string `innerHTML =` from re-entering the codebase.

## Files

```
public/
  index.html   — semantic shell, CSP, 3-tab layout (Setup / Scenes / Album)
  styles.css   — responsive dark theme
  app.js       — state, parsing, provider client, generation, album
  idb.js       — IndexedDB wrapper for the reference image blob
static-contract.js  — Node-only DOM / runtime contract check (no deps)
smoke-newui.js          — end-to-end Playwright test for image generation
smoke-newui-video.js    — end-to-end Playwright test for Create Video (Sora 2)
smoke-newui-album.js    — end-to-end Playwright test for Album + download
```

The earlier `smoke-workflow.js`, `smoke-openai.js`, `smoke-conn-pill.js`, `smoke-curtis-slade.js`, `smoke-e2e.js`, and `smoke-persistence.js` were written for the previous single-file UI and referenced deleted IDs (`makeTrailerBtn`, `openaiKey` etc.). They have been removed.

## Album

The Album tab stores every successful image and clip on the proxy in `data/album/<id>.<ext>` + `data/album/index.json`. The store is capped at 500 entries or 500 MB (configurable via `ALBUM_MAX_BYTES`); when the cap is hit, the oldest entries are pruned automatically.

API (CORS-restricted, `x-app-token` forwarded when set):

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/album` | list (newest first) |
| POST | `/album/upload?kind=image\|video&…` | raw bytes upload |
| GET | `/album/:id` | stream bytes (`Accept-Ranges: bytes`, `Content-Disposition: attachment`) |
| DELETE | `/album/:id` | remove one |
| DELETE | `/album` | remove all |

The proxy also auto-saves successful `/openai/images` and `/openai/videos/:id/content` responses server-side. The front-end re-uploads after each generation so the album stays in sync even if the proxy miss was for any reason.

## Local development

Serve `public/` from an HTTP server; opening the file directly is not supported because the CSP and asset paths expect an origin.

```bash
python3 -m http.server 8080 --directory public
node static-contract.js
```

The production client points to `https://curtis-a2e-proxy.onrender.com`. The proxy repository is **<https://github.com/ABBYCRM/curtis-a2e-proxy>**.

## Smoke tests

Each smoke test exercises the full path against the live app and proxy. They require:

- Node ≥ 20
- The Playwright Chromium binary at `/root/.cache/ms-playwright/chromium-1223/chrome-linux/chrome`
- An `OPENAI_KEY` env var (the real OpenAI key; the test does real round-trips)

```bash
cd Curtis-Image-Gen
export OPENAI_KEY=sk-...
node smoke-newui.js          # image generation
node smoke-newui-video.js    # Create Video (Sora 2 ~ 90s)
node smoke-newui-album.js    # Album tab + Download
```

The video test takes ~2 minutes end-to-end because Sora 2 takes 30–60 seconds per 4-second clip.

## Known limitations

- Reference image is in IndexedDB, which has no practical quota. The front-end was migrated from `localStorage` to fix a silent quota failure.
- Sora 2 returns 422 if the inpaint reference dimensions don't match the requested size. The proxy resizes the reference to exactly the requested size with `sharp` before forwarding — but a square reference sent for 16:9 is the closest match `sharp` can do without distorting; users who want pure face-lock should use a 16:9 reference.
- A2E free plan rejects video generation with HTTP 403. The Settings dialog links to upgrade at `video.a2e.ai` if the user wants A2E clips.
- Album is file-backed on the proxy. Render's free web service has ephemeral disk; redeploying the proxy will wipe the album. A future change can move the same `saveAssetToAlbum` interface onto Postgres or S3.
- Failed scenes surface the actual error message inline on the card (red-bordered paragraph). The status badge also gets a `title=` tooltip with the error for hover discoverability.

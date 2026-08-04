# Curtis Image Studio

A static browser application for generating consistent scene images from one reference photo and a script.

## Supported production paths

- **OpenAI / GPT Image 2** — generates or edits one image per scene through the companion proxy. When a reference image is supplied, the proxy uses the OpenAI image-edit endpoint so the image is actually included in the request.
- **A2E** — generates scene images and can animate each approved scene image into a clip.

OpenAI video generation is intentionally disabled. The previously configured Sora models are deprecated, and the old proxy sent the reference image using an invalid JSON contract.

## Security model

- Provider API keys are stored in `sessionStorage`, not `localStorage`.
- Project data and the resized reference image are stored locally under the app namespace.
- The frontend has a restrictive Content Security Policy and uses no third-party runtime scripts.
- The proxy never exposes environment-held provider keys to anonymous callers. Environment keys require `APP_PROXY_TOKEN`.

## Files

- `public/index.html` — semantic application shell
- `public/styles.css` — responsive styles
- `public/app.js` — parser, state, provider client, generation workflow
- `static-contract.js` — dependency-free DOM/runtime contract check

## Local development

Serve `public/` from an HTTP server; opening the file directly is not supported because the CSP and assets expect an origin.

```bash
python3 -m http.server 8080 --directory public
node static-contract.js
```

The production client points to `https://curtis-a2e-proxy.onrender.com`.

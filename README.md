# Curtis Image Gen

A face-locked image and video generator UI for building trailers with a consistent on-screen identity.

Drop in one reference photo, paste an A2E-style API key, write a script, and the same face is sent on every image and video call so the model can't drift the identity between scenes.

## What's inside

- `index.html` — single-file static UI. No build step, no server, no login. Open it in any browser.
- Designed to be paired with an A2E (avatar / talking-head) API such as Hedra, HeyGen, D-ID, fal.ai hedra, Replicate, or a custom endpoint.

## How face lock works

Every call sends the reference image as `image_url` / `reference_image_url`. The style prompt reinforces *"the same adult man from the reference photo, identical face, identical skin tone, identical build, identical wardrobe"*. That double-pinning is what stops the model from inventing a new face between scenes.

## Quick start

1. Open `index.html` in your browser (double-click works).
2. Upload **one** clear face photo in the "Identity Reference" panel. This is the only face the model is allowed to use.
3. Pick a provider in "A2E API Connection", paste your API key, click **Test connection**.
4. Paste your trailer script. Separate scenes with `---` on its own line.
5. Click **Generate stills only** to lock down visuals, then **Generate videos from stills** to animate. Or use **Generate all** to do it in one pass.

## Project files

- `index.html` — the app
- `LICENSE` — MIT

## License

MIT

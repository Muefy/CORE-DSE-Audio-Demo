# CORE-DSE Audio Demo

This repository contains the public CORE-DSE demo website and only the media used by its six audio scenes. It does not include the manuscript or research workspace.

The three Easy scenes also include an eight-image `Inside CORE` view. Its internal analysis uses a separate CE-Probe experiment rather than the ID 9 audio model; the exported metadata preserves this distinction and the original color scales without local filesystem paths. Unused spectral-head images and analysis audio are not included.

## Local development

```sh
pnpm install --frozen-lockfile
pnpm dev
```

## Checks and deployment

```sh
pnpm typecheck
pnpm build
```

Pushing to `main` builds the Vite site and publishes `dist` to GitHub Pages.

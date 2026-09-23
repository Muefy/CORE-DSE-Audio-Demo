# CORE-DSE Audio Demo

This repository contains the public CORE-DSE demo website and only the media used by its six audio scenes. It does not include the manuscript or research workspace.

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

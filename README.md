# CORE-DSE Audio Demo

This repository contains the public CORE-DSE demo website and the media used by one real recording and six simulated scenes, with 43 audio tracks in total. It does not include the manuscript or research workspace.

The Real Recordings, Simulated (Easy), and Simulated (Hard) sections start collapsed; opening one closes the others. The three buttons below the paper title open the corresponding section. The real recording compares close-talking speech, a 50 ms far-field reference, SpatialNet-Concat, and SpatialNet-CORE for each of three speakers; enhanced tracks display P808_MOS. Refreshing returns to the top of the page with all three sections collapsed.

The three Easy scenes also include an eight-image visualization of the CORE extraction process, opened with `View Details`. Its internal analysis uses a separate CE-Probe experiment rather than the ID 9 audio model; the exported metadata preserves this distinction and the original color scales without local filesystem paths. Unused spectral-head images and analysis audio are not included.

Displayed images use smaller, pixel-identical lossless WebP variants. Scene controls and players do not wait for all images to finish loading. Media is requested only after a section is first opened; default-scene images, remaining audio-scene images, and original WAV files are then prepared in that order, with two background downloads at most and foreground requests taking priority. Internal images remain on-demand. Audio cards use subtle shadows and a small hover lift, disabled when reduced motion is requested.

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

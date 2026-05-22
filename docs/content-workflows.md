# Content workflows

## Photo gallery data flow

The photo gallery is driven by two checked-in JSON files:

- `assets/photos/photos.json`: generated manifest containing dimensions, variant filenames, titles, descriptions, and EXIF-derived metadata.
- `assets/photos/gallery-sequence.json`: hand-authored sequence/order metadata and editorial overrides.

`js/gallery.js` merges those two inputs at runtime to build the gallery cards, hero feature, and lightbox state.

## Adding or updating photos

1. Add original files under `assets/photos/`.
2. Update `assets/photos/descriptions.md` if descriptions need to be authored or revised.
3. Run:

```bash
npm run optimize-images
```

This generates optimized variants under:

- `assets/photos/thumbs/`
- `assets/photos/medium/`
- `assets/photos/large/`

It also refreshes `assets/photos/photos.json`.

4. If ordering, featured placement, or editorial metadata needs adjustment, update `assets/photos/gallery-sequence.json`.
5. Verify with:

```bash
npm run quality
```

## Gallery diagnostics

The Playwright gallery scripts are for regression and investigation, not for shipped assets:

- `npm run gallery:shots`
- `npm run gallery:perf`
- `npm run gallery:check`

These write to `output/`, which is intentionally ignored.

## Utilities build workflow

The utilities page also has a strict source/build split:

- Editable source: `utilities-src/`
- Shipped build output: `pages/utilities/assets/`

When `utilities-src/` changes, rebuild the shipped page assets with:

```bash
npm run utilities:build
```

Then rerun:

```bash
npm run utilities:check
npm run utilities:browser-check
npm run utilities:perf
npm run smoke
```

Do not hand-edit the generated utilities bundle or the hashed worker chunks in `pages/utilities/assets/assets/`.

## Deploy build workflow

`npm run build:deploy` copies the shipped static site into `dist/`. The deploy build mirrors the repo's checked-in source plus generated utilities output and gallery assets. `dist/` is disposable output, not source.

## Local artifact policy

The following are intentionally local-only:

- `output/`
- `.omx/`
- IDE/editor directories
- temporary logs such as `server.log` and `server.pid`
- ad hoc workstation logs matching `*.log` and `*.pid`

If a script generates them, keep them out of commits.

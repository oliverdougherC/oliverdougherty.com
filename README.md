# `Oliver-Unified`

Static portfolio site for me (Oliver Dougherty, duh), with a hand-authored site shell, a metadata-driven photo gallery, an archive of technical writeups, a generated utilities experience, and a separate `game-src/` project that builds into the shipped game page.

## Repo map

- `index.html`: landing page entrypoint.
- `mobile/`: dedicated mobile site with only Home and Resume.
- `pages/`: routed HTML pages for resume, gallery, archive, utilities, and the built game.
- `js/`: shared browser scripts plus gallery-specific logic and the alternate WebGL gallery code.
- `css/`: shared design system and page-specific stylesheets.
- `assets/`: static media, gallery photo originals, optimized variants, and metadata manifests.
- `utilities-src/`: editable TypeScript source for the utilities page app bundle.
- `game-src/`: editable TypeScript source for the game.
- `config/`: Vite, Vitest, and TypeScript config files for the generated utilities and game projects.
- `scripts/`: repo checks, image processing, deploy build, and Playwright utilities.
- `docs/`: maintainer documentation for architecture and workflows.

## Setup

```bash
npm install
```

This repo uses custom Node scripts rather than a framework CLI. Most work happens directly against the checked-in static files.

## Common commands

```bash
npm run quality
npm run mobile:check
npm run quality:full
npm run utilities:build
npm run utilities:check
npm run utilities:browser-check
npm run utilities:perf
npm run game:dev
npm run game:check
npm run game:build
npm run build:deploy
npm run optimize-images
```

- `npm run quality`: lint, formatting check, local link validation, and smoke checks for the static site.
- `npm run mobile:check`: Playwright regression for the dedicated mobile Home/Resume routes and mobile redirects from desktop-only pages.
- `npm run quality:full`: site quality plus the game and utilities typecheck/test suites.
- `npm run utilities:build`: rebuild the shipped utilities bundle into `pages/dashboard/assets/`.
- `npm run utilities:check`: typecheck and test the editable utilities app source.
- `npm run utilities:browser-check`: run the Playwright regression flow against the shipped utilities page.
- `npm run utilities:perf`: capture utilities transform timing telemetry for representative image cases.
- `npm run game:dev`: run the game source with Vite during development.
- `npm run game:build`: rebuild `pages/game/` from `game-src/`.
- `npm run build:deploy`: copy the shipped site into `dist/`.
- `npm run optimize-images`: regenerate gallery image variants and refresh `assets/photos/photos.json`.

## Source-of-truth rules

- Edit `game-src/`; do not hand-edit `pages/game/` or `pages/game/assets/`.
- Edit `utilities-src/`; do not hand-edit `pages/dashboard/assets/` or the hashed worker chunks nested under `pages/dashboard/assets/assets/`.
- Edit source files in the repo root, `pages/`, `js/`, `css/`, and `assets/`; `dist/` is deploy output.
- Keep dedicated mobile work in `mobile/` and `css/mobile.css`. The mobile surface is intentionally limited to Home and Resume; do not add Gallery, Utilities, Game, or Archive mobile routes without changing that contract explicitly.
- Keep build/test config changes in `config/` so the repo root stays limited to shipped site files and top-level package metadata.
- `assets/photos/photos.json` and `assets/photos/gallery-sequence.json` are the gallery data contracts.
- `output/`, `.omx/`, IDE folders, and local logs are workstation artifacts and are intentionally ignored.

## Verification expectations

Run these before considering cleanup or feature work complete:

```bash
npm run quality
npm run utilities:check
npm run utilities:browser-check
npm run game:check
```

If you change `utilities-src/`, also rebuild the shipped utilities bundle:

```bash
npm run utilities:build
npm run utilities:perf
npm run smoke
```

If you change `game-src/`, also rebuild the shipped game page:

```bash
npm run game:build
npm run smoke
```

## Documentation

- [Site architecture](docs/site-architecture.md)
- [Content workflows](docs/content-workflows.md)
- [Game architecture](docs/game-architecture.md)

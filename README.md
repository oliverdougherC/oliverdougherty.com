# `oliverdougherty.com`

Static portfolio site for me (Oliver Dougherty, duh).

## Repo map

- `index.html` — Landing page and main navigation hub
- `mobile/` — Dedicated mobile site (Home + Resume only)
- `pages/` — Routed desktop pages: resume, gallery, archive, utilities, game
- `js/` — Shared browser scripts (nav, gallery, starfield, mobile gate, etc.)
- `css/` — Design system tokens + page-specific stylesheets
- `assets/` — Static media, gallery photos, utilities assets (demo images, audio, VM ISO)
- `utilities-src/` — Editable TypeScript source for the utilities dashboard
- `game-src/` — Editable TypeScript source for survivor roguelike game (currently disabled)
- `vm-src/` — Tiny Core Linux rootfs overlay for the Retro VM utility
- `config/` — Vite, Vitest, and TypeScript configs for generated projects
- `scripts/` — Image processing, linting, build deploy, Playwright testing
- `docs/` — Architecture documentation and content workflows

## Quick start

**Prerequisites:** Node.js 22+, npm, git

```bash
# Clone
git clone git@github.com:oliverdougherC/Oliver-Unified.git
cd oliverdougherty.com

# One-command setup (installs deps, builds bundles, runs quality checks)
npm run setup
```

Then serve locally:

```bash
npx serve -l 3000
```

Open `http://localhost:3000`. Done.

### Step-by-step (if you prefer manual control)

```bash
git clone git@github.com:oliverdougherC/Oliver-Unified.git
cd oliverdougherty.com

npm install              # dependencies
npm run utilities:build  # build utilities dashboard
npm run game:build       # build game
```

### IDE setup — WebStorm / VS Code

1. Open the repo root in your IDE
2. `npm run setup` from the IDE terminal
3. No additional configuration needed

**Dev servers:**
- **Site:** `npx serve -l 3000` — static file server, open `http://localhost:3000`
- **Game (hot reload):** `npm run game:dev` — Vite dev server on port 5174

## Common commands

```bash
npm run quality
npm run quality:full
npm run mobile:check
npm run utilities:build
npm run utilities:check
npm run utilities:browser-check
npm run game:dev
npm run game:check
npm run game:build
npm run build:deploy
npm run optimize-images
```

### Site-quality

- `npm run lint` — JS syntax validation, JSON parse check, external-link rel policy
- `npm run format` / `format:check` — Text normalization (line endings, trailing whitespace, EOF newline)
- `npm run check-links` — Local href/src link validation across all HTML files
- `npm run smoke` — Structural checks: critical routes, gallery data, game assets, utilities bundle
- `npm run quality` — Lint + format check + link check + smoke
- `npm run quality:full` — Site quality + game check + utilities check (complete verification)

### Utilities

- `npm run utilities:build` — Rebuild shipped bundle into `pages/utilities/assets/`
- `npm run utilities:check` — TypeScript check + 17 unit tests
- `npm run utilities:browser-check` — Playwright regression (Image Transform, Audio Fourier, Retro VM, Local Assistant, Stress Test)
- `npm run utilities:perf` — Transform timing probe (image + audio)
- `npm run utilities:cache:build` — Precompute built-in transform cache JSON
- `npm run utilities:data:update` — Fetch live CDC/WHO/SSA mortality data

### Game

- `npm run game:dev` — Vite dev server (port 5174) with hot reload
- `npm run game:build` — Rebuild `pages/game/` from `game-src/`
- `npm run game:check` — TypeScript check + 35 unit tests
- `npm run game:perf` — Frame-time performance gate (4 renderer profiles)

### Gallery

- `npm run optimize-images` — Regenerate gallery variants (3 sizes × 3 formats) + `photos.json`
- `npm run gallery:shots` — Desktop + mobile screenshot capture
- `npm run gallery:perf` — WebGL performance measurements
- `npm run gallery:check` — Editorial regression (chrome, lightbox, theme toggle)

### Playwright regression

- `npm run mobile:check` — Mobile Home/Resume across 3 phone viewports + redirect gate
- `npm run nav:check` — Navigation overlay geometry regression (desktop + mobile)

## Source-of-truth rules

- **Edit** `game-src/`, `utilities-src/`, `vm-src/`, and files in the repo root, `pages/`, `js/`, `css/`, `assets/`.
- **Do not hand-edit** `pages/game/assets/`, `pages/utilities/assets/`, or `dist/` — these are generated outputs.
- **Mobile** is intentionally limited to Home and Resume in `mobile/`. Pages like Gallery, Utilities, Game, and Archive redirect mobile visitors via `js/mobile-gate.js` (bypass with `?full=1`).
- **Gallery data** is driven by `assets/photos/photos.json` (auto-generated) and `assets/photos/gallery-sequence.json` (handwritten).
- **Build/test config** lives in `config/` so the repo root stays limited to shipped site files.

## Verification expectations

Run these before considering work complete:

```bash
npm run quality
npm run utilities:check
npm run game:check
```

After changing `utilities-src/`, also:

```bash
npm run utilities:build
npm run utilities:browser-check
```

After changing `game-src/`, also:

```bash
npm run game:build
npm run smoke
```

## CI

GitHub Actions runs lint, format check, typecheck, tests, build, and smoke on every push and PR to `main` and `beta`.

## Documentation

- [Site architecture](docs/site-architecture.md)
- [Content workflows](docs/content-workflows.md)
- [Game architecture](docs/game-architecture.md)
- [Design system](Design.md)

# `oliverdougherty.com`

Static portfolio site for me (Oliver Dougherty, duh).

## Repo map

- `index.html` — Landing page and main navigation hub
- `mobile/` — Dedicated mobile site (Home, Resume, and Gallery)
- `pages/` — Routed desktop pages: resume, gallery, and utilities
- `js/` — Shared browser scripts (navigation, gallery, page effects, mobile gate, etc.)
- `css/` — Design system tokens + page-specific stylesheets
- `assets/` — Static media, gallery photos, utilities assets (demo images, audio, VM ISO)
- `utilities-src/` — Editable TypeScript source for the utilities workbench
- `vm-src/` — Tiny Core Linux rootfs overlay for the Retro VM utility
- `config/` — Vite, Vitest, and TypeScript configs for generated projects
- `scripts/` — Image processing, linting, build deploy, Playwright testing
- `docs/` — Architecture documentation and content workflows

## Quick start

**Prerequisites:** Node.js 22+, npm, git

```bash
# Clone
git clone git@github.com:oliverdougherC/oliverdougherty.com.git
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
git clone git@github.com:oliverdougherC/oliverdougherty.com.git
cd oliverdougherty.com

npm install              # dependencies
npm run utilities:build  # build utilities workbench
```

### IDE setup — WebStorm / VS Code

1. Open the repo root in your IDE
2. `npm run setup` from the IDE terminal
3. No additional configuration needed

**Dev servers:**
- **Site:** `npx serve -l 3000` — static file server, open `http://localhost:3000`

## Common commands

```bash
npm run quality
npm run quality:full
npm run mobile:check
npm run utilities:build
npm run utilities:check
npm run utilities:browser-check
npm run build:deploy
npm run optimize-images
```

### Site-quality

- `npm run lint` — JS syntax validation, JSON parse check, external-link rel policy
- `npm run format` / `format:check` — Text normalization (line endings, trailing whitespace, EOF newline)
- `npm run check-links` — Local href/src link validation across all HTML files
- `npm run smoke` — Structural checks: critical routes, gallery data, utilities bundle
- `npm run quality` — Lint + format check + link check + smoke
- `npm run quality:full` — Site quality + utilities typecheck and unit tests

### Utilities

- `npm run utilities:build` — Rebuild shipped bundle into `pages/utilities/assets/`
- `npm run utilities:check` — TypeScript check + unit tests
- `npm run utilities:browser-check` — Playwright regression for visible tools and hidden-feature routing guards
- `npm run utilities:perf` — Transform timing probe (image + audio)
- `npm run utilities:cache:build` — Precompute built-in transform cache JSON

Utilities is a desktop-only, curiosity-driven workbench with Image Transform, Fourier Reconstruction, and Stress Test. Its name-only index opens individual workspaces with shared controls and navigation. Virtual Machine remains hidden; preserve its source, build inputs, runtime assets, and tests for future development. The old Local Assistant implementation is retired. See [Adding a utility](docs/utilities/adding-a-utility.md) for the extension workflow.

### Gallery

- `npm run optimize-images` — Regenerate gallery variants (3 sizes × 3 formats) + `photos.json`
- `npm run gallery:shots` — Desktop + mobile screenshot capture
- `npm run gallery:check` — Editorial regression (inline navigation and lightbox, including the narrow full-site layout)

### Playwright regression

- `npm run home:check` — Nighthawks artwork and introduction on both homepages, from 320px phones through 2560px desktops, including short landscape, resize, 200% CSS zoom and zoom-equivalent layout, exact character content, font/color-map failure fallbacks, no-JavaScript, reduced motion, absence of painting downloads during text rendering, four selected projects, sticky navigation, and readable project stories, responsive text columns, and keyboard/touch contact interactions. Set `HOME_CHECK_BROWSERS=chromium,firefox,webkit` to exercise all three engines. Screenshots go to `output/playwright/home-check/`.
- `npm run mobile:check` — Mobile Home/Resume/Gallery across 3 phone viewports + redirect gate
- `npm run nav:check` — Inline desktop and mobile navigation regression

## Source-of-truth rules

- **Edit** `utilities-src/`, `vm-src/`, and files in the repo root, `pages/`, `js/`, `css/`, `assets/`.
- **Do not hand-edit** `pages/utilities/assets/` or `dist/` — these are generated outputs.
- **Mobile** has dedicated Home, Resume, and Gallery pages in `mobile/`. Desktop pages use `js/mobile-gate.js` to redirect phone visitors to mobile Home (bypass with `?full=1`); use the mobile navigation to reach Resume or Gallery.
- **Homepage art** renders the actual 200 × 63 character grid from `assets/art/nighthawks-binary.txt` in one `<pre>` on both homepages. White credit letters occupy rows 58/60 of that same grid. `js/nighthawks.js` waits for the locally hosted `assets/fonts/nighthawks-mono-bold.ttf` font and tiny `nighthawks-colors.png` color map before revealing text. Successful text rendering downloads no painting raster; unavailable fonts/color maps and no-JavaScript visits use the credited PNG/WebP fallback. Run `npm run build:art` after changing source artwork to refresh the embedded grid, color map, and fallback derivatives. Keep the 6000 × 3274 composition, black backdrop, and 1880px size cap. Source inputs are excluded from deployment.
- **Homepage content** is shared in intent across `index.html` and `mobile/index.html`: a sticky header, prose introduction with an accessible OSU cheer button, four selected GitHub projects, and the “say hi back.” contact section. `js/home-interactions.js` handles email copying. Each project has a name, hook, personal or factual paragraph, and descriptive repository link in a responsive text layout. Edit the `project-list` section in both homepages; no build step is needed. See `docs/home-projects.md`. Keep project claims grounded in repository README material and use personal anecdotes only when supplied by Oliver.
- **Gallery data** is driven by `assets/photos/photos.json` (auto-generated) and `assets/photos/gallery-sequence.json` (handwritten).
- **Build/test config** lives in `config/` so the repo root stays limited to shipped site files.

## Verification expectations

Run these before considering work complete:

```bash
npm run quality
npm run utilities:check
```

After changing `utilities-src/`, also:

```bash
npm run utilities:build
npm run utilities:browser-check
```

## CI

GitHub Actions runs lint, format check, typecheck, tests, build, and smoke on every push and PR to `main` and `beta`. Deploy to GitHub Pages runs only on push to `main`.

## Documentation

- [Site architecture](docs/site-architecture.md)
- [Content workflows](docs/content-workflows.md)
- [Design system](Design.md)

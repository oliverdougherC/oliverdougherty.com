# Site architecture

## Overview

The site is a static, hand-authored HTML/CSS/JS project. There is no templating layer or SPA router. Each page owns its HTML, while shared behavior is handled by common browser scripts and shared CSS.

## Page groups

- `index.html`: landing page and primary navigation hub.
- `mobile/index.html`: dedicated mobile Home page.
- `mobile/resume/index.html`: dedicated mobile Resume page.
- `pages/resume/index.html`: resume page using the shared site shell.
- `pages/gallery/index.html`: editorial photo gallery powered by JSON metadata in `assets/photos/`.
- `pages/archive/index.html`: archive index for technical writeups.
- `pages/archive/*/*.html`: article-style archive pages using the abstract/article layout.
- `pages/dashboard/index.html`: utilities page shell.
- `pages/game/index.html`: generated entrypoint for the shipped game build.

## Shared browser layer

- `js/main.js`: shared navigation overlay, reduced-motion handling, scroll animations, smooth scrolling, and landing-page portal glow behavior.
- `js/mobile-gate.js`: redirects phone-sized visitors away from desktop-only pages into `/mobile/`, unless `?full=1` is present.
- `js/year.js`: footer year updates and color-mode toggle handling.
- `js/archive.js`: archive index filtering/search.
- `js/gallery.js`: metadata-driven gallery rendering and lightbox behavior.
- `utilities-src/src/main.ts`: editable utilities page controller and DOM orchestration.
- `utilities-src/src/transformCore.ts`: utilities matching pipeline and donor assignment logic.
- `utilities-src/src/workerRuntime.ts`: shared worker/main-thread execution runtime for utilities transforms.
- `pages/dashboard/assets/*`: generated utilities app bundle, including nested worker chunks under `pages/dashboard/assets/assets/`.

## Shared styling

- `css/design-system.css`: cross-site tokens and shared component styles.
- `css/mobile.css`: dedicated mobile-site styles for `/mobile/` only.
- `css/landing.css`, `css/gallery.css`, `css/archive.css`, `css/resume.css`, `css/utilities.css`: page-family styles.
- `css/abstract.css`: article/report layout used by archive detail pages.
- `css/cursor.css`: shared cursor presentation.

## Verification scripts

- `scripts/lint.js`: syntax, JSON, and external-link policy checks.
- `scripts/format.js`: normalization check/write pass for repo text files.
- `scripts/check-links.js`: local asset/page link validation across HTML.
- `scripts/mobile-site-check.js`: Playwright regression check for the dedicated mobile routes and mobile redirect gate.
- `scripts/smoke.js`: structural smoke checks for critical routes, gallery data, and shipped game assets.
- `scripts/nav-overlay-check.js`: Playwright regression check for shared navigation behavior.
- `scripts/utilities-check.js`: Playwright regression check for the utilities page workflow.
- `scripts/utilities-perf.js`: utilities performance probe for representative and stress-case transforms.

## Maintenance notes

- Keep the hand-authored HTML model. Do not introduce a templating system unless the repo direction changes.
- Shared page chrome lives in repeated markup plus shared JS/CSS. Prefer small, explicit cleanup over broad structural rewrites.
- Treat `/mobile/` as a separate product surface, not as responsive overrides for the desktop site. It has exactly two pages, Home and Resume; unsupported full-site mobile routes should include `js/mobile-gate.js` and redirect to `/mobile/` unless `?full=1` is present.
- `pages/dashboard/assets/` is part of the shipped site, but it is generated from `utilities-src/` and should be treated as build output.
- Utilities deployment readiness means more than type/tests: after utilities-source changes, rebuild the shipped bundle and rerun `utilities:browser-check` plus `utilities:perf`.
- `pages/game/` is part of the shipped site, but it is generated from `game-src/` and should be treated as build output.

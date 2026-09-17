# Site architecture

## Overview

The site is a static, hand-authored HTML/CSS/JS project. There is no templating layer or SPA router. Each page owns its HTML, while shared behavior is handled by common browser scripts and shared CSS.

## Page groups

- `index.html`: Nighthawks binary-art hero, casual “hi.” introduction, and primary navigation hub.
- `mobile/index.html`: dedicated mobile Home page sharing the Nighthawks artwork and “hi.” introduction.
- `mobile/resume/index.html`: dedicated mobile Resume page.
- `mobile/gallery/index.html`: dedicated mobile photo grid and touch lightbox.
- `pages/resume/index.html`: resume page using the shared site shell.
- `pages/gallery/index.html`: editorial photo gallery powered by JSON metadata in `assets/photos/`.
- `pages/utilities/index.html`: utilities dashboard entrypoint.

## Homepage artwork

Both homepages render the actual 200 × 63 character grid from `assets/art/nighthawks-binary.txt` inside a single `pre#nighthawksCharacters`. Its binary cells include white title and artist letters at rows 58/60. CSS clips the tiny `assets/art/nighthawks-colors.png` color map to these glyphs. There are no per-character DOM elements, canvas rasterization, or separate credit overlays. The artwork container has one descriptive image role; the character grid is hidden from assistive technology.

`js/nighthawks.js` waits for the locally hosted `Nighthawks Mono` font (`assets/fonts/nighthawks-mono-bold.ttf`) and color map before selecting `data-render-mode="text"`, then fits an integer-sized internal text grid to its container on resize. Fixed internal line spacing prevents WebKit from rounding tiny mobile line boxes; a transform scales the live text to the painting’s dimensions. The artwork font is a locally packaged JetBrains Mono subset at weight 800 with its OFL license; rendering does not depend on an installed system font. Normal text mode does not request the painting PNG or responsive WebP files. If the renderer cannot initialize, the font cannot load, or the color map fails, the credited image appears as a fallback. A `<noscript>` picture provides the same composition without JavaScript. The fallback preserves the full painting with `object-fit: contain`.

Both routes share `css/home.css`, retain the 6000 × 3274 composition on black, and cap the figure at 1880px while adapting to narrow and short screens. A proportional spacer reserves the artwork’s height instead of CSS `aspect-ratio`, avoiding WebKit’s doubled-height behavior under 200% CSS zoom. The introduction does not wait for the art renderer. `scripts/build-nighthawks-art.js` produces the embedded grid, color map, credited PNG, and responsive fallback derivatives from the authoring inputs. Original PNG/TXT inputs remain local authoring assets. The former name/particle/diamond hero has been retired.

## Homepage content and interactions

Desktop and mobile Home share a sticky `.home-header`, the Nighthawks artwork, prose introduction, four selected-project features, and a dark “say hi back.” closing. Desktop places the text-based dark-mode action in the navigation row; mobile retains its three route links and a full-site escape in the closing. The former three profile-stat boxes are gone; the facts live in prose. The native OSU button exposes its cheer state with `aria-pressed` and retains the pointer confetti interaction.

Project order follows the current selection: Encoding_Database, BetterVMAF, Keiri, and Lyra. Each `.project-entry` has one title, one `.project-blurb`, one `.project-link` to its repository, and one noninteractive `.project-art` animation. Copy combines documented project behavior with personal stories supplied by Oliver; do not infer anecdotes. The illustrations use native HTML, character art, and SVG; there are no project screenshot assets.

`js/home-interactions.js` handles the copy-email action on both homepages and, on the desktop home, the “excursions” hover easter egg: hovering the word plays `assets/audio/2000-excursion-excerpt.mp3` once, fading in on mouseenter, fading out on mouseleave, and dissolving into silence at the file’s end. Both homepages also load `js/main.js` for the shared OSU interaction. The four project entries are static prose in both homepages: name, hook, paragraph, and repository link. Shared `css/home.css` provides the responsive two-column reading layout. No project animation runtime or artwork build is required. The email remains a usable `mailto:` link if scripting or clipboard access is unavailable.

## Shared browser layer

- `js/home-interactions.js`: shared homepage clipboard feedback; on the desktop home, the “excursions” hover audio easter egg.
- `js/nighthawks.js`: homepage text artwork initialization, font/color-map readiness, responsive grid fitting, and image fallback.
- `js/main.js`: shared navigation helpers, reduced-motion handling, scroll animations, and smooth scrolling.
- `js/mobile-gate.js`: redirects phone-sized visitors away from desktop-only pages into `/mobile/`, unless `?full=1` is present.
- `js/year.js`: footer year updates and color-mode toggle handling.
- `js/gallery.js`: metadata-driven gallery rendering and lightbox behavior.
- `js/iridescence-bg.js`: active Utilities WebGL background.
- `js/mobile-gallery.js`: dedicated mobile gallery and touch lightbox.
- `js/utilities-shell.js`: tabbed utilities dashboard shell (routing between utility panels).
- `js/local-llm-chat.js`: Local LLM chat UI controller.
- `js/local-llm-config.js`: Local LLM configuration (models, endpoints, worker settings).
- `js/local-llm-worker.js`: Web Worker for Local LLM inference.
- `js/local-llm-mock-worker.js`: Mock worker for Local LLM testing.
- `js/local-llm-cache.js`: Local LLM response caching layer.
- `js/local-llm-rendering.js`: Local LLM message rendering utilities.
- `js/page-animations.js`: Shared page transition and entrance animations.
- `js/favicon-swap.js`: Dynamic favicon state switching.
- `js/resume-typing.js`: Resume page typing animation effects.
- `js/utilities-title-reveal.js`: Utilities page title reveal animation.
- `utilities-src/src/main.ts`: editable utilities page controller and DOM orchestration.
- `utilities-src/src/transformCore.ts`: utilities matching pipeline and donor assignment logic.
- `utilities-src/src/workerRuntime.ts`: shared worker/main-thread execution runtime for utilities transforms.
- `pages/utilities/assets/*`: generated utilities app bundle, including nested worker chunks under `pages/utilities/assets/assets/`.

The visible Utilities routes are Image Transform, Audio Fourier, and Stress Test. Local Assistant and Virtual Machine remain implemented and bundled, but their buttons are hidden and their routes are excluded from `VALID_UTILITIES`. Image Transform uses its serial matcher inside the transform worker; there is no parallel matching worker.

Home, Resume, and Gallery use inline navigation; Utilities has Home and Back controls. Mobile pages use their own three-link navigation. The visible Resume nav label is spelled with accents (`RÉSUMÉ` on desktop, `Résumé` on mobile) so it does not read as the pause/resume verb; route slugs, file paths, and CSS/class names stay `resume`.

## Shared styling

- `css/design-system.css`: cross-site tokens and shared component styles.
- `css/home.css`: shared Nighthawks hero and introduction for desktop and dedicated mobile Home.
- `css/schematic.css`: landing page schematic mode styles (scoped to `body.schematic-mode`).
- `css/mobile.css`: dedicated mobile-site styles for `/mobile/` only.
- `css/gallery.css`, `css/mobile-gallery.css`, `css/resume.css`, `css/utilities.css`: page-family styles.
- `css/cursor.css`: shared cursor presentation.
- `css/local-llm-chat.css`: Local LLM chat UI styles.

## Verification scripts

- `scripts/lint.js`: syntax, JSON, and external-link policy checks.
- `scripts/format.js`: normalization check/write pass for repo text files.
- `scripts/check-links.js`: local asset/page link validation across HTML.
- `scripts/home-check.js`: exact character-grid content, font/color-map readiness, normal rendering without painting requests, responsive sizing, 200% CSS zoom, and zoom-equivalent resize, accessible introduction/navigation, no-JavaScript and resource-failure fallbacks, reduced motion, four selected-project links, sticky header layout, and animation playback/stills and keyboard/touch contact interactions on both routes.
- `scripts/mobile-site-check.js`: Playwright regression check for the dedicated mobile routes and mobile redirect gate.
- `scripts/smoke.js`: structural smoke checks for critical routes, gallery data, and utilities bundle.
- `scripts/nav-overlay-check.js`: Playwright regression check for shared navigation behavior.
- `scripts/utilities-check.js`: Playwright regression check for the utilities page workflow.
- `scripts/utilities-perf.js`: utilities performance probe for representative and stress-case transforms.

## Maintenance notes

- Keep the hand-authored HTML model. Do not introduce a templating system unless the repo direction changes.
- Shared page chrome lives in repeated markup plus shared JS/CSS. Prefer small, explicit cleanup over broad structural rewrites.
- Treat `/mobile/` as a separate product surface, not as responsive overrides for the desktop site. It has three pages: Home, Resume, and Gallery; unsupported full-site mobile routes should include `js/mobile-gate.js` and redirect to `/mobile/` unless `?full=1` is present.
- `pages/utilities/assets/` is part of the shipped site, but it is generated from `utilities-src/` and should be treated as build output.
- Utilities deployment readiness means more than type/tests: after utilities-source changes, rebuild the shipped bundle and rerun `utilities:browser-check` plus `utilities:perf`.

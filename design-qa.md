# Homepage QA — scanning and graphic replacements

Final result: passed implementation checks and ready for visual review.

## Scope

Better VMAF's approved artwork, sampling and timeline are unchanged. Encoding DB now follows the requested film inspection → readings → grid → database sequence. Keiri and Lyra use entirely new graphic concepts. The four-project selection, title/blurb/link structure, Nighthawks hero, header and contact remain intact.

## Changes and source ownership

Both homepages were rebuilt from assets/project-motion/. Updated Encoding's source, stylesheet and scripts/build-film-poses.js; updated Keiri's source/styles and js/keiri-motion.js; replaced Lyra's source/styles. The old tabletop SVG projector, per-frame callback and paper-book geometry are removed. scripts/build-lyra-poses.js was deleted and removed from the build command. Generated css/project-motion.css is substantially smaller. No dependencies added.

Encoding emits four abstract digit groups per scanned frame. Their reveal follows the physical beam crossing, and their delivery paths avoid rows already populated. The same numbers are retained as the completed matrix becomes the layered database. Numeric strings are illustrative, not measured benchmark data.

Keiri's two counterturning pip rings cover all36 ordered outcomes of rerolling two dice. Three held values remain fixed for each cycle. The kept face and observed pair use three independent uniform random draws. The observed pair resolves into a centered five-glyph hand; inner-ring opacity recedes to keep that hand legible. No player chooses an outcome. All per-frame motion is CSS.

Lyra reads and annotates a passage about period/frequency, extracts T and f into T=1/f, draws the corresponding waveform and recalls a missing f. Frequency doubles at the final beat and the marked period halves with it. Definitions, the bracket's geometric span and its shared scaling were independently reviewed. The rejected physical-book treatment is gone.

## Visual evidence

Final desktop and mobile compositions: output/project-motion-v3/final-chromium-grid.png and final-mobile-grid.png. The final rosette contrast refinement is captured separately in final-chromium-keiri.png and final-webkit-keiri.png. Lyra's chronological poses are in lyra-refined-sheet.png; browser-specific individual images show each final scene. Mobile captures use fresh contexts after font and SVG painting settle.

Encoding's source owner inspected881 timestamps per engine: no premature readings, overlapping output clusters during collection, or numerical overflow. Chronological desktop/280px views confirmed film→numbers→matrix→database order. Parent inspected representative scan, populated matrix and database stages.

Keiri's source owner checked1,000 cycles per engine, all36 outcomes, correct pip counts, cycle updates, static/reduced views and280px rendering. Parent refined the separation of core glyphs and cleared the inner field behind the final hand. Lyra's source-to-symbol transition was refined so the passage remains present while the symbols emerge, and the original keyword fades instead of overlapping its abbreviation.

## Verification and limits

Full Chromium and WebKit homepage suites pass: all four projects, retained VMAF grid/geometry checks, all36 ordered pairs exactly once, three matching kept values, valid observed pair, rendered pip/state agreement, stable values within a cycle, real CSS boundary updates, visible/offscreen timing, hidden-tab and motion-preference changes, static/no-JS views, responsive/200% zoom layouts, and retained hero/header/contact checks.

Independent read-only review found no actionable probability, waveform/period or lifecycle issues. Full project quality checks pass, including178 unit tests, links, syntax, formatting and smoke checks. The final local shipping build and smoke checks pass. No deployment performed.

Firefox automation remains unavailable on this host due to its pre-navigation macOS plugin-container/framebuffer failure; no Firefox result is claimed. Visual approval remains part of the ongoing workshop with Oliver.

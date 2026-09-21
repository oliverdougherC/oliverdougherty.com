# Adding a utility

Utilities is a desktop workbench for discovery through interaction. Start with the
new tool's inputs, output, and state changes. The shared shell supplies navigation,
typography, controls, focus behavior, and a consistent place in the collection.
Do not introduce another visual theme or a tool-specific navigation system.

## Design contract

- Keep the index numbered and name-only. Use `01 // Name` for numbered labels and
  switcher entries. No descriptions, tutorials, or tooltips.
- Use white surfaces, thin rules and the violet `#7050C0` accent. Keep the bold
  JetBrains Mono identity on the index; inside tools use compact Inter headings,
  labels and controls, reserving monospace for measurements and numerical readouts.
- No scrolling inside any utility, including nested panels. The active page is a
  `100dvh` control panel with one compact header. Size the output with `minmax(0,1fr)`
  and adapt the control arrangement to the tool and viewport; do not conceal controls
  or metrics to fit. Verify actual bounds, not just `overflow: hidden`.
- Give the output room. Arrange controls to suit the tool; a waveform, canvas,
  or numerical result need not use the same layout.
- Use native buttons, labelled inputs and selects, visible focus, and live status
  feedback. Discovery does not require ambiguous controls or invisible errors.
- Provide reset or stop behavior where relevant. Leave a clear distinction between
  waiting, running, finished, and failed states. Respect reduced-motion preferences.
- Do not add a mobile utility route. The dedicated mobile site remains Home,
  Resume, and Gallery, with the existing desktop-page redirect gate unchanged.

## Register the workspace

The page is hand-authored in `pages/utilities/index.html`; no page generator or
additional framework is needed.

1. Add a numbered entry inside `.utilities-buttons`. Its `data-utility` value is
   the route ID, for example `new-tool`; an anchor uses `href="#new-tool"`.
2. Add an option with that ID and tool name to `#utilitySwitcher`.
3. Add a stage inside `.utility-stage-wrapper`, using the same ID:

```html
<div class="utility-stage"
     data-utility-id="new-tool"
     data-utility-title="New Tool"
     data-utility-number="04"
     hidden>
  <section class="utility-shell" id="newToolApp"
           data-utility-root="new-tool" aria-label="New Tool">
    <!-- Tool-specific controls and output. -->
  </section>
</div>
```

4. Add the ID to the explicit allowed routes in `js/utilities-shell.js`. Do not
   remove that guard: it keeps the preserved Virtual Machine unavailable.

The shell reads the stage metadata to fill `#utilityTitle` and `#utilityNumber`.
It manages the index (`#utilitiesTitleView`), workspace (`#utilitiesUtilityView`),
stage `hidden`/`is-active` state, browser history, and workspace selection. Reuse
this behavior rather than adding independent hash or Back-button handlers.

## Add the controller

Put editable TypeScript in `utilities-src/src/`. Follow the existing controllers'
`init()` pattern, and add a lazy initialization branch in `main.ts` using the new
route ID and root element. The existing loader tracks initialized tools and shares
pending initialization promises; do not start a second controller on every visit.

The shell emits bubbling `utility-activate` and `utility-deactivate` events from
the inner `[data-utility-root]` element. Listen on that root, or at the stage or
document level and filter with the nearest `data-utility-id`. Deactivation must pause playback, stop expensive work, cancel
animation frames or workers where appropriate, and release captured input. Keep
results available for a return visit unless the tool explicitly resets them.
Do not assume hiding a stage stops its timers or computation.

Reuse the current shared controls and workspace patterns in `css/utilities.css`:

- `.utility-layout`, `.utility-rail`, and `.utility-view` arrange controls and output.
  Image Transform uses a height-adaptive input rail with settings anchored below;
  thumbnail images fill their own frame width and crop vertically in short frames. Its output
  includes a playback-linked range that pauses on manual seeking.
  Fourier uses a horizontal source/settings rack;
  Stress Test uses a top control strip and six bottom readouts. Avoid forcing new
  tools into a sidebar when a different arrangement uses the viewport better.
- `.control-label` and `.control-select-minimal` supply labelled settings.
- `.btn-primary-minimal` and `.btn-secondary-minimal` supply actions; the existing
  `-utility` button variants share the same visual treatment.
- `.workbench-status`, `.instrument-bar`, and `.instrument-stats` present state,
  grouped controls, and output readouts.

Keep any tool-specific selectors scoped to its workspace. Existing utility engines
remain independent of the shell; keep new computation similarly separate from
DOM handling, using workers when work would block interaction.

## Verify and document

Add focused unit tests for the new computation and state behavior. Extend
`scripts/utilities-check.js` to cover opening from the index and a direct hash,
using the tool, resetting or stopping it, switching away, returning to the index,
and browser Back/Forward. Include keyboard navigation and error states.

```bash
npm run utilities:check
npm run utilities:build
npm run utilities:browser-check
npm run quality
```

Inspect the page in a desktop browser at wide, narrow and short sizes (including
1440×900, 1280×720, 1024×600 and 800×600). Check idle and populated results, long file
names, errors and live resizing. All controls, status and readouts must remain within
the viewport without page or internal scrolling. Check that feedback reflects real
state and deactivated tools stop active work.
Run the performance probe when changing the transform or audio engines.

Update `docs/utilities/overview.md` and add a technical document for the new tool.
These developer documents can explain algorithms and architecture; the visitor's
workspace remains free of introductory tutorials. Never hand-edit
`pages/utilities/assets/` or its hashed worker chunks; rebuild them from source.

Preserve the hidden Virtual Machine code, assets, build inputs, and tests. The old
Local Assistant is retired; a future assistant should start as a new implementation.

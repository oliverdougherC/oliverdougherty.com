# Site design

This document describes the current site. Future visual changes are agreed page by page;
there is no pending site-wide redesign mandate.

## Current direction

The homepage opens with a binary rendition of Edward Hopper’s Nighthawks on black,
followed by a casual “hi.” introduction. The art is a complete composition: keep its
aspect ratio, preserve the black backdrop, and cap its size so it remains deliberate
on wide screens. The painting is actual text, colored through its glyphs; its title
and artist are white characters within the same grid. Keep that quiet integration
instead of adding a caption strip. A raster fallback preserves the composition when
JavaScript or the required font/color map is unavailable. The same art and introduction
are present on the dedicated mobile homepage.

Below the art, Home retains the white schematic vocabulary shared with Gallery and
Resume: black type, thin rules, generous spacing, and small per-page accents.
JetBrains Mono supplies the main voice, with Inter for supporting interface text.
The blackout flashlight, OSU surprise, and gallery photo presentation remain intentional
interactions. A sticky black header anchors both homepage routes, with a text-based
dark-mode action in the desktop navigation. The introduction puts personal facts in
prose, including an accessible OSU cheer button and a hidden easter egg on the desktop home: hovering the word “excursions” plays a short, non-looping audio excerpt with a smooth fade in and out. Four selected projects introduce Oliver’s interests through a name, hook, personal prose, and descriptive repository link. Each entry spans a full row, with a narrower title column and a wider reading column; on phones the title sits above the writing. Thin rules and generous spacing provide rhythm. Project artwork and animations are retired.
The closing returns to black with
“say hi back.”, a prominent email address, and copy feedback.
The former oversized name, particle wordmark, diamond divider, and profile-stat boxes
are retired.

| Page | Accent | Main stylesheet |
| --- | --- | --- |
| Home | Orange `#FF6700` | `css/home.css`, `css/schematic.css` |
| Gallery | Blue `#004BA8` | `css/gallery.css` |
| Resume | Green `#2BA84A` | `css/resume.css` |
| Utilities | Violet `#7050C0` | `css/utilities.css` |

Utilities is a desktop-only curiosity-driven workbench. It shares white surfaces, black
type, thin rules, and deliberate alignment with the other pages. The index retains
the bold JetBrains Mono identity. Inside each utility, compact Inter typography serves
controls and labels; monospace is reserved for numerical readouts. Every active utility
is a viewport-sized control panel with no page or internal scrolling. Use a compact
header and adapt each tool’s arrangement to fit: image input rail, horizontal audio
rack, stress control strip and bottom telemetry. Output expands to the remaining space.
Use double slashes for numbered labels (`01 // Name`). Image Transform’s sidebar
allocates spare height to source/target frames while settings stay anchored below.
Thumbnail images always fill their own frame width and remain vertically centered;
height changes crop them, while narrower side-by-side frames reduce image size.
The image animation has a playback-linked scrubber that stays paused after seeking.
Violet marks active controls and selections. The numbered, name-only index opens
individual workspaces with a consistent heading, switcher, and return to the index.
No descriptions, tutorials, or tooltips advertise or explain each experiment; clear
control labels, visible state changes, and reset actions support discovery by doing.
Real outputs and useful measurements supply the engineering character. Avoid fake
telemetry, decorative equations, blanket blueprint grids, glass, and ambient backgrounds.

Image Transform, Fourier Reconstruction, and Stress Test retain their existing engines.
Reuse shared controls and lifecycle behavior while allowing each tool to arrange its
own workspace. Stress Test presents the largest actual prime in oversized, right-anchored black
JetBrains Mono, beginning its search at 1. The GPU sculpture uses violet/graphite
on the light workbench surface; combined mode separates sculpture and number.
Start uses all browser-reported CPU threads and sustained GPU loading. There is no
GPU intensity selector; do not present unmeasured utilization or power percentages.
The Virtual Machine implementation and assets remain preserved but
hidden. The old Local Assistant implementation is removed; any return starts fresh.
See `docs/utilities/adding-a-utility.md` for the implementation contract.

The mobile site has separate Home, Resume, and Gallery pages styled by `css/mobile.css`
and `css/mobile-gallery.css`. Maintain these until a responsive consolidation is explicitly
agreed.

## Working rules

- Start from each page's actual markup and stylesheet. `css/design-system.css` provides
  shared defaults, some of which are overridden by page styles; it is not a redesign brief.
- Preserve existing appearance and behavior during cleanup. Agree visible changes as part
  of the page being reviewed.
- Reuse existing styles and assets before adding new patterns or dependencies.
- Keep text readable, controls keyboard-accessible, and motion compatible with reduced-motion
  preferences. Check both desktop and the dedicated mobile pages when shared styles change.
- Keep photo originals, generated variants, metadata, and attribution files. They support
  the gallery's build and runtime behavior.

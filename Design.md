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
| Utilities | Dark background, translucent controls, iridescent light | `css/utilities.css` |

Utilities has its own current visual treatment. Its image transform, Fourier reconstruction,
and stress test are available; the Local Assistant and Virtual Machine remain hidden.
Keep functional utility interiors intact when adjusting their presentation.

The mobile site has separate Home, Resume, and Gallery pages styled by `css/mobile.css`
and `css/mobile-gallery.css`. Maintain these until a responsive consolidation is explicitly
agreed. The blog remains disabled pending its own review.

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

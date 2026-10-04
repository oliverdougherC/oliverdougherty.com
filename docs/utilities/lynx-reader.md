# Lynx Reader

`05 // Lynx Reader` is a browser-local, pasted-text RSVP experiment. Current main
ends at `04 // Yahtzee vs. Keiri`, so it uses the next available number rather than
the tentative 07 in issue #92. Default target speed is **300 WPM** (100–1000,
25 WPM increments). No imports, storage, reading claims, or external services.

## Source and parsing

- `utilities-src/src/lynxReaderCore.ts`: parser, recognition point, timing and cancellable scheduler.
- `utilities-src/src/lynxReaderController.ts`: lazy DOM controller and session state.
- `scripts/lynx-reader-check.js`: browser flow, geometry and real-time throughput measurements; included in `utilities:browser-check`.

The deterministic parser scans non-whitespace runs, retaining punctuation,
apostrophes, hyphens, decimals, URLs and Unicode. CRLF/CR normalize to LF; single
line wraps and tabs are ordinary separators. Two newlines, including intervening
spaces/tabs, mark a paragraph. Extra blank lines do not stack pauses. Nonprinting
controls and bidi overrides are removed; combining marks and emoji joiners remain.
Pasted content is assigned with `textContent`, never interpreted as HTML.

Trailing closing quotes/brackets are ignored for boundary classification. Commas,
semicolons and colons indicate clauses; question/exclamation marks, periods,
ellipses and their common Unicode equivalents indicate sentences. A small
case-insensitive abbreviation list and dotted initials suppress false periods
(`Dr.`, `e.g.`, `U.S.`, `A.`). Internal decimal/domain periods do not end sentences.
This is deliberately a heuristic: an abbreviation at an actual sentence end may
not pause, and scripts without spaces remain whole reading units rather than
receiving language-specific word segmentation.

## Recognition point and layout

`Intl.Segmenter` splits each unit into grapheme clusters, so combining characters
and joined emoji are not torn apart. Focal selection counts letter, number and
symbol clusters, excluding punctuation; punctuation-only units fall back to their
visible clusters. The zero-based recognition index is 0 for length 1, 1 for 2–5,
2 for 6–9, 3 for 10–13, and 4 thereafter.

The focal grapheme's center sits at 50% of the reading stage. Prefix and suffix
are absolutely positioned on its two sides; their widths cannot move the anchor.
Violet color and fixed black ticks identify the focal position. Ligatures and
kerning are disabled across fragments. If either side would exceed its available
space, the whole word scales around the same focal center. Extremely long tokens
can therefore become small; they never displace the anchor. ResizeObserver and
font readiness re-fit the current word. There are no movement transitions.

The source textarea alone may scroll. The reader is a viewport-sized grid using
the existing white surface, Inter controls, violet accent and thin rules.

## Cadence and target WPM

For visible token length `L`, define:

```text
length bonus = 0.65 × (1 − exp(−max(0, L − 5) / 14))
density bonus = 0.20 for long numbers, mixed letters/digits, or URL-like text; else 0
boundary bonus = 0 / 0.22 / 0.65 / 1.25 for none / clause / sentence / paragraph
weight = 1 + length bonus + density bonus + boundary bonus
mean weight = sum(weight) / number of units
dwell milliseconds = (60000 / target WPM) × weight / mean weight
```

Only the strongest boundary bonus applies. Length grows smoothly toward a 0.65
cap, density is added once, and paragraph gaps cannot accumulate. Short words are
baseline weight 1; clause/sentence/paragraph multipliers for a short plain word
are **1.22 / 1.65 / 2.25** before source normalization. All weights stay at or
below 3.10. Normalization is calculated over the complete source, so total planned
time, including the final word, is exactly `units × 60000 / WPM`. Subsections can
have a different effective rate. No minimum-dwell clamp silently changes WPM.

On the 59-unit prose fixture in the browser check, mean weight is 1.1280. At
300 WPM, dwells span 177–414 ms. Plain 5/10/20/40-character words in that context
receive approximately 177/212/253/283 ms: longer words have extra time without
stalling the cadence. The 300 WPM default leaves room for structural pauses;
faster speeds remain an explicit user choice.

Actual Chromium playback of that fixture (including its two paragraphs, dialogue,
abbreviation, decimal and compound) measured:

| Target WPM | Elapsed seconds | Effective WPM |
|---|---|---|
| 150 | 23.644 | 149.7 |
| 300 | 11.849 | 298.7 |
| 450 | 7.922 | 446.8 |
| 600 | 5.941 | 595.8 |

These are timer/DOM throughput measurements, not comprehension measurements. Browser
load or throttling may reduce actual throughput; the reader never compensates
with catch-up bursts. The browser regression allows 8% timing variation and writes
fresh measurements and screenshots to ignored `output/lynx-reader/`.

## Interaction and lifecycle

Read displays the first unit paused and focuses the reading stage. Space toggles
playback; Left/Right seek 10 units and pause. Native input/select/textarea behavior
and button/link Space activation are preserved. Seek is an integer range labelled
with its exact word position. Pointer-down pauses even before its value changes.
Reset pauses at the start. Change Text retains the source for editing. Completion
holds the final word for its full dwell, then offers Replay.

Changing WPM retains position and playback state, recalculating only the remaining
fraction of the current dwell. Pausing and resuming gives the displayed word a
fresh full dwell. The scheduler has one timeout and a generation token; pause,
seek, reset, replacement text and deactivation invalidate stale callbacks.
Repeated initialization is ignored. Shared hash routing owns activation/history;
switching tools preserves text, index and WPM, then returns paused. Page hiding
and document visibility loss also pause. No session data leaves the page.

The source has a visible label, controls use native semantics and visible focus,
and Play exposes `aria-pressed`. Only playback-state changes use a live region;
neither words nor progress are announced continuously. The displayed word has a
single accessible label while its visual fragments are hidden from accessibility.
Reduced motion requires no alternate animation because words change instantly.

## Verification

Unit coverage includes parser boundaries, Unicode ORP, modifier ordering/bounds,
normalization, stale callbacks, live speed changes, exact seek/resume, completion,
keyboard exclusions and deactivation. Browser coverage uses the shipped bundle:
index and deep links, Read/play/pause/seek/speed/reset, switch/return, Back/Forward,
large paste, reduced motion and reload. All controls and word-fragment bounds are
checked at **1440×900, 1280×720, 1024×600 and 800×600**; measured ORP centers remain
within 0.6 CSS px of the fixed anchor across the token fixture.

Run `npm run utilities:check`, `npm run utilities:build`,
`npm run utilities:browser-check`, and `npm run quality`.
For focused browser iteration: `node scripts/lynx-reader-check.js`.

# Lynx Reader

`05 // Lynx Reader` is a browser-local, pasted-text RSVP experiment. It follows
`04 // Keiri’s Domain`; LLM Rumen Cannula occupies number 06 in the combined release. Default target speed is **300 WPM** (100–1000,
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
Density detection uses a single Unicode-aware scan with bounded state rather than
unanchored lookaheads, so digit-free long tokens do not trigger quadratic suffix scans.
Pasted content is assigned with `textContent`, never interpreted as HTML. The
source opens prefilled with a fixed passage so Read works without any input.
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
kerning are disabled across fragments. Fitting is bidirectional around the same
focal center: long tokens shrink so neither side can exceed its available space,
while short tokens grow to the selected size (32–144 px, default 88 px) or the
stage height, whichever binds first. Sans serif (Inter), serif (Georgia), and
monospace (JetBrains Mono) are selectable; the guide scales with the chosen size.
Words therefore fill the instrument without reading as page titles, and no token displaces the anchor. ResizeObserver and font
readiness re-fit the current word. There are no movement transitions.

The source textarea alone may scroll. The reader is a viewport-sized grid using
the existing white surface, Inter controls, violet accent and thin rules. Below
600 px window height, tighter spacing, a flexible word stage, and hidden hint
rows keep all controls—including Position—inside the visible shell.

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
are **1.22 / 1.65 / 2.25** before source normalization. At default settings,
weights stay at or below 3.10. Comma/clause and sentence pauses are independently
adjustable from 0–200% of baseline word time (defaults +22% and +65%). Semicolons/colons share
the comma setting; periods, question marks and exclamation marks share the
sentence setting. Punctuation at a paragraph ending also responds to its setting,
while retaining the additional paragraph time; unpunctuated paragraph endings
keep the 1.25 bonus. Custom settings adjust the relevant boundary bonus before
normalization, so WPM continues to include pauses. Normalization is calculated over the complete source,
so total planned time, including the final word, is exactly `units × 60000 / WPM`. Subsections can
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
playback; Left/Right and the sentence buttons skip to the start of the previous
or next sentence and pause. Back skips the entire current sentence even from
its middle. Paragraph starts count as sentence starts. At the edges, navigation
clamps to the first/final word. These shortcuts remain active after dragging a
slider or focusing any reader control; Enter activates focused buttons. Text
editing and modified browser shortcuts remain native. Interactive workbench
controls outside the reader, including Index and Switch utility, also retain
their native keyboard behavior. Scroll up/down changes
target speed by +25/−25 WPM, bounded to 100–1000; small trackpad deltas accumulate
before a change. Zoom gestures and predominantly horizontal scrolling are ignored.
Wheel handling is inactive in the text editor or another utility. Seek is an
integer range labelled with its exact word position. Pointer-down pauses even before its value changes.
Reset pauses at the start. Change Text retains the source for editing. Completion
holds the final word for its full dwell, then offers Replay.

Changing WPM or pause settings retains position and playback state, recalculating
only the remaining fraction of the current dwell. Font and size changes re-fit
the current word without restarting playback. Preferences remain for the current
page session when editing text or switching utilities. Pausing and resuming gives
the displayed word a fresh full dwell. The scheduler has one timeout and a generation token; pause,
seek, reset, replacement text and deactivation invalidate stale callbacks.
Repeated initialization is ignored. Shared hash routing owns activation/history;
switching tools preserves text, index and WPM, then returns paused. Page hiding
and document visibility loss also pause. No session data leaves the page.

The source has a visible label, controls use native semantics, and Play exposes
`aria-pressed`. The stage is a closed instrument: it draws no focus outlines and
no selection boxes anywhere except editable text in the source textarea. Keyboard
focus is visible through existing surface/border colors; primary controls and
range accents darken while preserving text contrast. Only
playback-state changes use a live region;
neither words nor progress are announced continuously. The displayed word has a
single accessible label while its visual fragments are hidden from accessibility.
Reduced motion requires no alternate animation because words change instantly.

## Verification

Unit coverage includes parser boundaries, Unicode ORP, modifier ordering/bounds,
normalization, stale callbacks, live speed changes, exact seek/resume, completion,
keyboard focus regressions and deactivation. Browser coverage uses the shipped bundle:
prefilled source with Read enabled, index and deep links, Read/play/pause/seek/
speed/reset, switch/return, Back/Forward, large paste, reduced motion and reload.
Font and size extremes are also checked through 2560×1440, including short
1280×500 and 1920×540 windows. Short-window checks also cover 800×500, actual
pointer access to Position, clipping ancestors, and keyboard use of the actual
Index button and utility switcher.
All controls and word-fragment bounds are checked at **1440×900, 1280×720,
1024×600 and 800×600**; measured ORP centers remain within 0.6 CSS px of the
fixed anchor across the token fixture, short tokens fit with scale above 1 and
the 400-character token below 1 at every size.

Run `npm run utilities:check`, `npm run utilities:build`,
`npm run utilities:browser-check`, and `npm run quality`.
For focused browser iteration: `node scripts/lynx-reader-check.js`.

Review regressions actually press Read on a 50,000-character alphabetic token
and on 59,000 words (360,998 characters) of prose at all four viewport sizes.
The local Chromium/WebKit runs measured 27 ms for the long token and 124–217 ms
for the prose. These are workstation measurements, not hardware-independent
performance guarantees. Native keyboard traversal checks every editor/reader
control and compares its visible styling before and after focus, with paired
screenshots. macOS WebKit uses Option+Tab for native full-control traversal;
other tested platforms use Tab. No system keyboard preference is modified.

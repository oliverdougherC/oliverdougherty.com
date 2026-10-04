# Issue 72: Utility Index arrow

The shared Index button uses a 12px decorative `currentColor` SVG and inline
flex centering. Native Index semantics, 30.8px target height, purple hover, focus
outline, and responsive 54px/46px toolbar heights are preserved. The validation
follow-up retains this production implementation.

![Magnified before and after: Inter and fallback, normal, hover, and keyboard focus](index-arrow-before-after.png)

Baseline: refreshed main `4cfc1c52041d929ee2b14153b28a6657b091469e`, captured
before editing at 1440 × 900, DPR 1, 100% scale. The old arrow was slightly low
on this Linux Chromium; the reporter's exact high-arrow appearance was not
reproduced. The Latin Inter fixture supplies the label but lacks U+2190, so the
baseline text arrow uses the host fallback font. Images use nearest-neighbor
magnification.

## Representative browser regression

One 13-image check replaces the old 192-image matrix plus 27-image compact run.
Chromium runs it inside `utilities-check.js`; Firefox and WebKit run the same
focused check through the release runner. Chromium has no duplicate standalone
release check. Standalone development use:

```sh
UTILITIES_BROWSER=chromium node scripts/index-arrow-check.js
# Optional installed executable when pinned Playwright is unavailable:
INDEX_ARROW_BROWSER_EXECUTABLE=/usr/bin/chromium node scripts/index-arrow-check.js
```

The representative cases cover all three tools, permanently blocked fonts,
delayed Inter followed by a real swap after first paint, DPR 1/2, normal and
representative hover/focus. Click, Enter, Space, switcher, history Back/Forward,
footer restoration, accessible name and decorative SVG semantics are checked.
Visible-ink centers must differ by at most one CSS pixel; layout checks also
verify target height and actual toolbar breakpoint behavior. Navigation reuses
geometry checks instead of repeatedly capturing an unchanged icon.

## Zoom coverage and its boundary

The test models the **effective CSS viewport** of a 1440 × 900 content area at
each requested zoom. Resizing the viewport changes media-query inputs; CSS zoom
stays at 1 and is asserted to stay at 1. Alignment is measured on both sides of
the 650px toolbar breakpoint:

| Nominal browser zoom model | Effective CSS viewport | Toolbar height |
| --- | --- | --- |
| 100% | 1440 × 900 | 54px |
| 125% | 1152 × 720 | 54px |
| 150% | 960 × 600 | 46px |
| 200% | 720 × 450 | 46px |

This automates the layout/media-query effect of browser zoom. Native browser
zoom controls and their fractional-scale rasterization remain unautomated.
DPR 1/2 are independent rendering samples. Windows/macOS system fonts require
separate platform runs. The Inter fixture is licensed, unmodified, test-only,
and served through intercepted Google Fonts routes; live font endpoints are
outside this deterministic check. Results and screenshots go to
`output/playwright/index-arrow/<browser>/`.

## Fourier CI investigation

[Original CI run](https://github.com/oliverdougherC/oliverdougherty.com/actions/runs/37226783198)
passed both arrow checks, then failed the existing rapid-slider playback
assertion. Later failures followed the 300-second termination.

[Measured comparison](fourier-validation.json) uses refreshed base `4cfc1c5`
and reviewed head `1baf44c`. Their Fourier controller blob is identical. Normal
local sequences pass on both; individual JSON-array canvas reads take 11–14
seconds. A bounded probe starts native audio sources with three seconds left:

| Product revision | Old full-RGBA transfer | State after old read | Buffer transfer | State after buffer read |
| --- | --- | --- | --- | --- |
| Base `4cfc1c5` | 10.506s | Playback complete | 0.263s | Animating |
| Reviewed head `1baf44c` | 9.380s | Playback complete | 0.249s | Animating |

This reproduces the assertion's pre-existing timing sensitivity independently
of the arrow. It is a bounded playback probe, not an exact replay of the CI
runner clock. The old CI assertion did not record terminal playback state.

The browser-check helper now transfers the same raw RGBA bytes as base64 and
decodes a Buffer, avoiding millions of serialized JSON numbers. Frozen-canvas
comparisons match all 2,995,608 bytes on each revision. Fourier production code,
playback assertions, and the 300-second limit are unchanged.

## Validation

Source quality, utilities typecheck/tests (505 passed, 5 existing skips),
utilities build and deployment build pass locally. System Chromium
151.0.7922.173 on Linux passes the focused check: 13 rendered images in 3.5s,
with ink-center differences at most 0.5 CSS px. The packaged main utility
check passes in 151.3s, including Fourier, worker recovery and reduced motion;
its embedded arrow check takes 8.5s in that local run. Local packaged checks use system
Chromium and local font responses through an untracked preload because pinned
browser downloads and live Google Fonts are blocked in this environment.
Required CI results for the final head are linked in the PR description.

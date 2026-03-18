# Gallery Visual & UX Refactor — CoverFlow-style Angled Layout + Click-to-Inspect

## Context

The 3D gallery currently renders photos nearly face-on (3-6° Y rotation), scattered across 3 lanes at 0.86-0.94 opacity with ~5 items visible at once. Result: photos look like translucent glass panes flying at the user, blending into each other with no way to pick one out. This refactor transforms the gallery into a polished, usable photo viewer inspired by the CoverFlow "record store" aesthetic — strong angles, one clear hero photo, and click-to-inspect.

---

## Phase 1: Zero out hand-placed scene data

**File:** `photos/gallery-sequence.json`

Set all 16 items' `scene` blocks to neutral values. The new layout engine computes everything dynamically.

```json
"scene": { "z": 0, "scale": 1.0, "x": 0, "y": 0, "rotX": 0, "rotY": 0, "rotZ": 0, "opacity": 1.0 }
```

Keep all `colorGrade`, `meta`, `src`, and `aspect` values unchanged.

---

## Phase 2: Rewrite SceneController layout engine (critical)

**File:** `js/gallery3d/SceneController.js`

### 2a. Replace SCENE_TUNING

Key value changes (old → new):

| Parameter | Old | New | Why |
|---|---|---|---|
| spacing (desktop/mobile) | 276 / 224 | 420 / 320 | Wider gaps, less overlap |
| visibleRange (desktop/mobile) | 2.6 / 1.9 | 1.8 / 1.2 | ~3 items visible, not ~5 |
| depthOpacityFalloff | 0.38 | 0.55 | Steeper fade, hero stands out |
| maxOpacity | 0.985 | 1.0 | Hero photo fully solid |
| flankRotY (desktop/mobile) | ~0.016 rad/delta | 0.50 / 0.44 rad | ~28° angle for flanking items |
| activeRotY | — | 0.10 rad | Center photo nearly face-on (~6°) |
| activeScaleBoost | — | 1.12 | Hero 12% larger |
| flankScaleMin | — | 0.78 | Flanking items 22% smaller |
| fresnelBase | 0.16 | 0.06 | -62% glass effect |
| refractionBase | 0.0018 | 0.0006 | -67% glass effect |
| chromaticBase | 0.00028 | 0.00008 | -71% glass effect |
| glossBase | 0.56 | 0.30 | -46% specularity |
| camera sway X (desktop) | 15px | 8px | Less drift, calmer |
| staggerX (desktop/mobile) | 3-lane [-126,0,122] | ±40 / ±24 | Gentle alternating offset only |

### 2b. New update() logic — V-shape CoverFlow

Remove the 3-lane system entirely. New core loop:

- **V-shape Y rotation:** `sign(delta) * lerp(activeRotY, flankRotY, pow(norm, 1.6))`. Items before center angle left, after angle right. Creates a "V" opening toward the viewer.
- **Scale from delta:** Active item at 1.12×, flanking at 0.78× with power-curve falloff.
- **Opacity from delta:** Active = 1.0, first flanking ≈ 0.45, second ≈ invisible.
- **Simple stagger:** Alternating ±40px X offset (not 3 lanes), only for non-center items.
- **Focus blend:** When in focus mode, lerp the focused item toward hero position (z=200, rotY=0, large scale). Other items lerp to opacity=0.

### 2c. Focus state machine

Add to constructor: `focusState='idle'`, `focusBlend=0`, `focusIndex=-1`.

States: `idle → entering → active → exiting → idle`

- `entering`: `focusBlend` lerps toward 1.0 each frame. At ≥0.99, snap to `active`.
- `exiting`: `focusBlend` lerps toward 0.0. At ≤0.01, snap to `idle`.

Methods: `enterFocus(index)`, `exitFocus()`, `isFocused()`.

In update(): focused item blends toward `{z:200, rotY:0, height: baseHeight*1.65, opacity:1}`. Non-focused items blend toward opacity 0.

**Click any visible photo:** Clicking a non-active photo first scrolls/navigates to it. App.js sets `pendingFocusIndex`. When `onActiveIndexChange` fires and matches the pending index, it auto-calls `enterFocus()`. This gives a smooth scroll→focus transition.

---

## Phase 3: Reduce glass effect in shader

**File:** `js/gallery3d/shaders.js`

Reduce hard-coded multipliers (the uniform values alone aren't enough because the shader has its own amplifiers):

| Line | Effect | Old multiplier | New multiplier |
|---|---|---|---|
| 190 | Fresnel color | `* u_fresnelStrength` | `* u_fresnelStrength * 0.6` |
| 191 | Specular 1 | `0.04 + gloss * 0.11` | `0.02 + gloss * 0.06` |
| 192 | Specular 2 | `0.02 + gloss * 0.07` | `0.01 + gloss * 0.04` |
| 194 | Edge glow | `* 0.11` | `* 0.05` |
| 195 | Edge line | `* 0.17` | `* 0.08` |
| 146 | Surface imperfection | `mix(0.0014, 0.0032, ql)` | `mix(0.0008, 0.0018, ql)` |

Photos should read as solid matte/satin prints with a touch of material quality.

---

## Phase 4: Wire click-to-inspect interaction

### 4a. InputController.js — Add click handler

- Accept new `onClick` callback in constructor
- Bind click on shell, only fire if `event.target` is the canvas
- Dispose in cleanup

### 4b. App.js — Orchestrate focus

- In `onClick` callback: if already focused → exit. Otherwise raycast. If hit is the active item → `sceneController.enterFocus(index)`. If hit is a different visible item → navigate to it first (`scrollToIndex` + set `pendingFocusIndex`), then in the `onActiveIndexChange` callback, check if `pendingFocusIndex` matches and auto-enter focus.
- In `onProgress` callback: if focused → exit focus before updating progress (scroll dismisses focus).
- Wire `uiController._onFocusExit` to exit focus from overlay/Escape.
- Add `pendingFocusIndex = -1` state to track "click a flanking photo → scroll to it → then focus".
- Breakpoint: already changed to 980px (done in previous work).

---

## Phase 5: Focus mode UI

### 5a. UIController.js — Focus overlay + Escape

- Add `setFocusMode(active)` method
- Creates/toggles a `#galleryFocusOverlay` div (fixed, z-index 3, dark semi-transparent)
- Clicking overlay calls `_onFocusExit` callback
- Auto-opens detail panel on focus enter
- Escape key checks `isFocusMode` first before closing panels

### 5b. gallery.css — Focus overlay + cursor

```css
.gallery-focus-overlay { position:fixed; inset:0; z-index:3; background:rgba(0,0,0,0); pointer-events:none; transition:background 0.6s }
.gallery-focus-overlay.is-active { background:rgba(0,0,0,0.72); pointer-events:auto; cursor:pointer }
```

---

## Implementation Order

1. `gallery-sequence.json` — zero scene data (no deps)
2. `SceneController.js` — new SCENE_TUNING + V-shape update() + focus state (core change)
3. `shaders.js` — reduce glass multipliers (independent)
4. `InputController.js` — add click handler
5. `App.js` — wire click→focus, scroll→exit, UIController callback
6. `UIController.js` — focus overlay, Escape handling
7. `gallery.css` — overlay styles

Steps 1-3 are independent visual improvements. Steps 4-7 add the interaction layer.

---

## Verification

1. **Angle:** Scroll through gallery — flanking photos should be clearly tilted (~28°), center photo nearly face-on
2. **Density:** Only ~3 photos visible on desktop, ~2 on mobile. Center photo fully opaque, flanking clearly fading
3. **Focus mode:** Click the center photo → it expands to hero size, face-on, dark overlay appears, detail panel opens. Click overlay / press Escape / scroll → exits smoothly
4. **Glass effect:** Photos should look like solid prints with subtle material quality, not translucent glass
5. **Mobile:** Touch tap on active photo enters focus. Scroll works normally
6. **Existing tests:** `node scripts/gallery-dropdown-check.js` should still pass (UI panels still work the same way)

## Key Files
- `js/gallery3d/SceneController.js` — V-shape layout, focus state machine (biggest change)
- `js/gallery3d/App.js` — click wiring, scroll-exits-focus
- `js/gallery3d/shaders.js` — reduce glass multipliers
- `js/gallery3d/InputController.js` — add click handler
- `js/gallery3d/UIController.js` — focus overlay, Escape priority
- `css/gallery.css` — overlay styles
- `photos/gallery-sequence.json` — zero scene overrides

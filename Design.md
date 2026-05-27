# Design System

This document outlines the design principles, color palette, and typography for the site. Whether you are a human contributor or an AI agent, please adhere to these guidelines to maintain a consistent aesthetic.

## Philosophy
The site follows a **dark, refined aesthetic** with per-page theme variations. Design is functional and structured, with color used for emphasis and identity per section. A global light mode toggle is supported across most pages (utilities page forces dark mode).

## Color Palette

The site is built on a dark base with warm parchment tones for text. Each page has its own accent color and theme variations.

### Base Colors (Dark Mode Default)
| Role | Hex |
| :--- | :--- |
| Background Primary | `#0a0c0a` |
| Background Secondary | `#10130f` |
| Surface | `#141812` |
| Text Primary | `#f5f0e8` |
| Text Secondary | `#a8a090` |
| Accent (default) | `#173B34` (forest green) |

### Per-Page Themes

| Page | Theme Accent | Hex |
| :--- | :--- | :--- |
| **Gallery** | Lavender | `#9693CC` |
| **Archive** | Sage | `#CDDBCD` |
| **Resume** | Steel Blue | `#6C8FD5` |
| **Utilities** | Pure White | `#ffffff` |

### Light Mode
A global light mode (`[data-color-mode="light"]`) overrides all themes with warm parchment backgrounds (`#f3f0e7`) and darker accent tones. The utilities page disables light mode via `data-disable-color-mode`.

## Typography

We utilize a serif/mono/sans-serif hierarchy.

### Font Stack
* **Display:** `Instrument Serif`, Georgia, serif
    * *Usage:* Primary display headings, hero text.
* **Body / Interface:** `Inter`, system sans-serif
    * *Usage:* Navigation labels, body text, UI labels, headings.
* **Mono:** `JetBrains Mono`, Fira Code, monospace
    * *Usage:* Code, technical content, utilities page display font.

### Font Sizes
Fluid typography using `clamp()` from `--text-xs` (0.75rem) to `--text-6xl` (4–6.5rem), plus agency-scale `--text-hero` and `--text-hero-lg`.

### Font Weights
Light (300), Normal (400), Medium (500), Semibold (600), Bold (700).

---
*Note: This design system is currently under active development. If you are modifying CSS or UI components, ensure your changes respect the hierarchy and constraints outlined above. The canonical tokens live in `css/design-system.css`.*

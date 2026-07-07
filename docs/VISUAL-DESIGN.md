---
name: Como 26/27 - Eggshell × Stripe
source: docs/wireframes/style-sketch.html (approved 2026-07-07)
extracted: 2026-07-07
role: canonical-system
colors:
  ground: "#FDFCFC"        # eggshell page background, never pure white
  card: "#FFFFFF"          # elevated surfaces
  ink: "#0A0A0A"           # headings and body
  muted: "#767676"         # secondary text, micro-labels
  hairline: "#E5E5E5"      # table rules, stat-strip dividers
  hairline-faint: "#F0F0EF" # table body rows
  orange: "#F36F1C"        # brand accent: punctuation + sealed values ONLY
  green: "#10B978"         # good value / live signal
  green-text: "#0B7A50"    # badge text on green tint
  red: "#DF4A32"           # overpay / bad value
  red-text: "#B2371F"      # badge text on red tint
  amber: "#D99A1B"         # fair value
  amber-text: "#96690A"    # badge text on amber tint
  tv-surface: "#16181A"    # TV board frame
  tv-cell: "#1D1F22"       # TV board cells
  tv-muted: "#9A9A94"      # TV labels
  tv-hairline: "rgba(255,255,255,0.14)"
shadows:
  sm: "0 1px 2px rgba(50,50,93,0.06), 0 1px 1px rgba(0,0,0,0.05)"
  md: "0 2px 5px -1px rgba(50,50,93,0.12), 0 1px 3px -1px rgba(0,0,0,0.10)"
  lg: "0 13px 27px -5px rgba(50,50,93,0.14), 0 8px 16px -8px rgba(0,0,0,0.18)"
typography:
  display:
    fontFamily: "Hanken Grotesk"
    fontWeight: 300
    letterSpacing: "-0.03em"
    fontSize: "clamp(44px, 6vw, 68px)"
    lineHeight: 1.02
  h2:
    fontFamily: "Hanken Grotesk"
    fontWeight: 300
    fontSize: "30px"
    letterSpacing: "-0.03em"
  tv-numeral:
    fontFamily: "Hanken Grotesk"
    fontWeight: 300
    fontSize: "64px+"
    fontVariantNumeric: "tabular-nums"
  body:
    fontFamily: "Inter"
    fontWeight: 400
    fontSize: "16px"
    lineHeight: 1.6
  ui:
    fontFamily: "Inter"
    fontWeight: 500-600
    fontSize: "14-15.5px"
  label:
    fontFamily: "Hanken Grotesk"
    fontWeight: 700
    fontSize: "11-12.5px"
    letterSpacing: "0.09em"
    textTransform: "uppercase"
rounded:
  card: "8px"
  tv: "12px"
  tv-cellgroup: "10px"
  pill: "999px"
spacing:
  section-y: "64px"
  card-pad: "22px 24px"
  content-max: "960px"
  table-cell: "12px 14px"
---

# Visual design system

> This is the **visual** system (colors, type, surfaces). Product design (surfaces, flows, max-bid logic) lives in `docs/DESIGN.md`. Live sample: [`docs/wireframes/style-sketch.html`](wireframes/style-sketch.html).

## Overview

A warm-minimal editorial base carried on crisp SaaS-dashboard mechanics. The ground is warm eggshell (`{colors.ground}`, never pure white), display type is **Hanken Grotesk at light 300 with -0.03em tracking** (big headings light, never bold: the defining move), body and UI are Inter. On top of that sits the surface system: **white cards floating on crisp layered blue-grey shadows** instead of borders, 8px radius, tinted pill badges, dense hairline tables with uppercase micro-headers.

Three hard exclusions, all confirmed during style review:
1. **No left accent borders**: no `border-left` callout bars anywhere.
2. **No neumorphism**: no dual-direction soft shadows, no inset/extruded surfaces.
3. **No borders on cards**: elevation comes from `{shadows.md}` only. Hairlines exist solely *inside* surfaces (table rows, stat-strip dividers), never around them.

## Colors

- `{colors.ground}` page, `{colors.card}` surfaces, `{colors.ink}` text. High contrast, no soft greys for primary text.
- `{colors.muted}` secondary text and micro-labels only.
- **Orange `{colors.orange}` is punctuation, not decoration**: the eyebrow dot, one keyword in a heading, a kicker label, sealed Claude values. Never a fill, never a background, never body text.
- **Value semantics live in tinted badges** (the one place color touches a fill on the light theme): ~12% tint of the semantic color with its darkened text pair: `{colors.green}`/`{colors.green-text}` good value and live status, `{colors.red}`/`{colors.red-text}` overpay, `{colors.amber}`/`{colors.amber-text}` fair. Numbers inside tables may also color directly for compact contexts.
- Shadows are always blue-grey (`rgba(50,50,93,...)`), never neutral black; this is what makes the elevation read crisp rather than Material.

## Typography

| Token | Face | Size | Weight | Notes |
|---|---|---|---|---|
| display | Hanken Grotesk | clamp(44-68px) | **300** | -0.03em; hero only |
| h2 | Hanken Grotesk | 30px | **300** | -0.03em |
| tv-numeral | Hanken Grotesk | 64px+ | 300 | tabular-nums, TV boards |
| body | Inter | 16px | 400 | line-height 1.6 |
| ui / buttons | Inter | 14-15.5px | 500-600 | |
| label / eyebrow | Hanken Grotesk | 11-12.5px | 700 | UPPERCASE, +0.09em |

Bold (700) exists only at micro scale (labels, badge text, button text). A bold large heading breaks the system instantly. All numerals everywhere: `font-variant-numeric: tabular-nums`.

## Surfaces

- **Card:** `{colors.card}` fill, `{rounded.card}`, `{shadows.md}`, no border. Padding `{spacing.card-pad}`.
- **Stat strip:** one elevated card divided internally by 1px `{colors.hairline}` verticals (metric-row pattern), not separate floating tiles.
- **Table:** inside a card. Uppercase micro-headers in `{colors.muted}` over a `{colors.hairline}` rule; body rows separated by `{colors.hairline-faint}`; right-aligned numeric columns; deltas as tinted badges.
- **Buttons:** pill radius. Primary = solid `{colors.ink}` with white text and `{shadows.md}`. Quiet = white with `{shadows.sm}`. Ghost = transparent, muted text, no shadow.

## The TV boards (16:9)

The boards drop all subtlety; they must read from a couch at 3 to 4 metres:

- Frame `{colors.tv-surface}` at `{rounded.tv}` with `{shadows.lg}`; cells `{colors.tv-cell}` separated by `{colors.tv-hairline}` 1px gaps (grid with 1px background showing through).
- Numerals in Hanken Grotesk 300 at 64px minimum on boards; player names larger.
- Labels `{colors.tv-muted}` uppercase micro-style.
- Sealed Claude value is the orange moment. Verdicts are tinted pills (e.g. red 16% fill, `#FF9D8F` text).
- **Nothing on a board may depend on subtle shadow or low-contrast tint to be understood.** Minimum text on boards ~15px at 1600×900 canvas scale; hierarchy comes from size and weight, not opacity alone.
- Boards are fixed 1600×900 canvases scaled to viewport width (transform: scale to `clientWidth / 1600`).
- **OLED burn-in (target TV is a 77" 4K OLED, 4+ hour night):** no permanently-static bright white elements; fixed chrome (top bar, budget strip) stays mid-luminance on dark, and the per-lot club-color re-dress provides the pixel variety.

## Do's and don'ts

- Do keep headings light (300) at every size above 20px.
- Do use blue-grey layered shadows for all elevation; never single hard shadows, never black-alpha only.
- Don't use left accent borders, card outlines, or neumorphic inset/extruded effects; all three are explicitly rejected.
- Don't let orange become a fill or appear in more than ~3 places per screen.
- Don't put semantic color on anything except values/deltas/status: tiers and structure stay neutral.
- Do use tabular numerals everywhere money or points appear.
- Do test every TV board at simulated distance (zoom out to 25%); if hierarchy dies, increase size contrast, not color.

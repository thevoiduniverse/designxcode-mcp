# DesignxCode App — Complete Screen & State Spec

All screens for Figma. Every page, every state, every interaction.

---

## Global Elements

### Sidebar (persistent across all screens)
- **Width:** 200px
- **Logo:** DesignxCode mark (28×28 rounded-8 square, primary bg) + "DesignxCode" text 17px/700
- **Nav items:** icon (20×20) + label (14px/400), gap 12px, padding 10px 12px, rounded-10
- **States:** Default (muted text), Hover (surface bg, text color), Active (surface bg, text color, icon = primary color)
- **Sections:** Main nav + "AUDIT" section label (11px/600 uppercase, 0.06em spacing)
- **Bottom:** Theme toggle + Settings
- **Items:** Overview, Tokens, Components, Styles, Variables | Health, Parity, Export | Theme toggle, Settings

### Top Bar (persistent)
- **Height:** 56px
- **Left:** Page title (18px/600, -0.02em)
- **Right:** Avatar (32×32 circle, primary bg, initials 13px/600 white) + "Sync from Figma" button (primary pill)
- **Background:** Glass (backdrop-blur 12px, 82% opacity of bg color)
- **Border:** bottom 1px border color

### Buttons (from design system)
- **Primary:** pill shape, primary bg, #fafbfc text, 14px/500, padding 8px 20px
- **Outline:** pill, transparent bg, 1px border, text color, 14px/500
- **Small variant:** 12px, padding 5px 14px

### Pills/Badges
- **Collection:** 11px/500, primary color, primary@6% bg, rounded-full, padding 2px 10px
- **Status OK:** 11px/500, green color, green@6% bg
- **Filter:** 12px/500, 1px border, rounded-full, padding 5px 14px
- **Filter active:** primary bg, white text

---

## Screen 1: Overview

### States
1. **Default (healthy)** — score 100%, all synced
2. **Syncing** — "Sync from Figma" button loading state
3. **Drift detected** — score <100%, warning indicators on token rows
4. **Empty/First run** — no data yet, onboarding prompts

### Layout
- **Hero:** "Design System Health" label (14px/400 muted) → "100%" value (42px/700, -0.03em) → green "All synced" pill → two action buttons
- **Stats strip:** 4-cell joined grid (1px border between), each: value (22px/700), label (13px muted), sub (11px mono muted). Cells: Tokens 65, Components 2, Styles 18, Modes 2
- **Two-column:** Left (main) + Right (380px sidebar)

### Left Column
- **Section:** "Color Tokens" (13px/600) + "View all →" link (12px/500 primary)
- **Token table card:**
  - Header row: Name | Light | Dark | Status (12px/500 muted)
  - Rows: circular icon (32×32, colored bg, initial letter white) + title (14px/500) + sub (12px muted) | swatch (18×18 rounded-5) + hex (mono 13px muted) | swatch + hex | "Synced" green pill
  - **Tokens shown:** Primary, Text, Muted, Surface, Border (5 rows)

### Right Column
- **Palette card:** grid of color swatches (32×32 rounded-8, 1px border), 8px gap. All 12 system colors.
- **Activity card:** header "Activity" + list items. Each: dot (8×8, colored) + text (13px, bold names in text color, rest muted) + time (11px mono muted). Items: 65 tokens extracted (green, 2m), Parity 100% (green, 2m), Theme light+dark (primary, 5m), Button regenerated (yellow, 15m), MCP connected (primary, 20m)
- **Quick Actions card:** header + stacked buttons. Each: icon (16×16 muted) + label (13px/500), 1px border, rounded-10, 10px 16px padding. Actions: Generate components, Run health audit, Create sync PR

### Overview — Drift State
- Hero shows "87%" in text color (not green pill)
- Orange "3 tokens drifted" pill instead of green
- Token rows with drift show orange "Drifted" pill instead of green "Synced"
- Activity shows "Token drift detected" with yellow dot

### Overview — Empty State
- Hero shows "—" value
- Stats strip shows 0 for all values
- Token table replaced with centered illustration + "Connect to Figma" heading + "Sync your design system to get started" subtext + primary CTA button
- Activity shows single item: "MCP connected"

---

## Screen 2: Tokens

### States
1. **All tokens** — default, showing all
2. **Filtered by Color** — only color tokens visible
3. **Filtered by Typography** — only typography tokens
4. **Filtered by Shadow** — only shadow tokens
5. **Search active** — search bar focused, results filtered
6. **Group collapsed** — token group header collapsed, rows hidden

### Layout
- **Title:** "Design Tokens" (20px/600)
- **Search bar:** surface bg, rounded-10, 8px 14px padding, magnifier icon (16×16 muted) + input (13px)
- **Filter pills:** All (active), Color, Typography, Shadow
- **Token table card:**
  - Header: Name | Light | Dark | Collection
  - Groups (collapsible): Foreground, Background, Shadows
  - Group header: chevron icon (14×14) + group name (13px/600)

### Token Data (ALL tokens)
**Foreground group:**
| Name | Light | Dark | Collection |
|------|-------|------|-----------|
| Text Primary | #0a0d14 | #fafbfc | Semantic |
| Text Muted | #6b7280 | #afb8c1 | Semantic |

**Background group:**
| Name | Light | Dark | Collection |
|------|-------|------|-----------|
| Surface | #fafbfc | #0a0d14 | Semantic |
| Primary | #d51e8c | #e04e9b | Semantic |
| Primary Hover | #b8187a | #f06ab4 | Semantic |
| Border | #e5e7eb | #1e1e1e | Semantic |
| Ghost Hover | #f3f6fa | #1a1a1a | Semantic |

**Shadows group:**
| Name | Light | Dark | Collection |
|------|-------|------|-----------|
| Card Shadow | 0 1px 3px rgba(0,0,0,.08) | 0 1px 3px rgba(0,0,0,.3) | Effects |
| Button Shadow | 0 1px 2px rgba(0,0,0,.06) | 0 1px 2px rgba(0,0,0,.2) | Effects |
| Terminal Glow | 0 4px 24px rgba(0,0,0,.5) | 0 4px 24px rgba(0,0,0,.5) | Effects |

---

## Screen 3: Components

### States
1. **Grid view** — component cards in 2-column grid
2. **Detail view — Preview** — split panel showing live buttons
3. **Detail view — Code** — split panel showing generated code
4. **Search active** — filtering component cards

### Layout
- **Title:** "Components" (20px/600)
- **Search bar:** same as Tokens page
- **Component grid:** 2 columns, 16px gap

### Component Cards
**Button card:**
- Preview area (120px height, surface bg): Primary + Outline + Ghost buttons (14px/500 pill, small size)
- Info: "Button" (14px/600) + "30 variants · 3 types · 2 sizes" (12px muted)

**ButtonWithIcon card:**
- Preview area: Outline button with GitHub SVG icon + "GitHub" text
- Info: "ButtonWithIcon" (14px/600) + "2 variants · 2 sizes" (12px muted)

### Detail Panel (below grid)
- **Header:** "Button" title (15px/600) + "30 variants" mono pill + Preview|Code tab toggle
- **Preview pane:** surface bg, centered, live buttons: Primary, Outline, Ghost (full size 16px/500)
- **Code pane:** white bg, mono 12px/20px line-height, syntax highlighted:
  - Keywords (primary color): `const`, `as const`
  - Strings (green #16a34a): class values
  - Comments (border color): `// Generated by designxcode-mcp`

### Tab States
- **Preview active:** preview pane full width, code hidden
- **Code active:** code pane full width, preview hidden
- **Both (default):** 50/50 split

---

## Screen 4: Styles

### States
1. **Typography view** — default, showing all type styles
2. **Effects view** — showing shadow styles

### Layout
- **Title:** "Typography & Effects" (20px/600)
- **Filter pills:** Typography (active), Effects

### Typography Table (14 rows)
Each row: Label (13px/500 muted, 140px) | Live preview text (at actual size/weight) | Size/Weight spec (12px mono muted) | Letter-spacing (12px mono muted)

| Label | Preview | Spec | Spacing |
|-------|---------|------|---------|
| Display | "Display" at 60px/700 | 60/700 | -1.2px |
| Heading 1 | "Heading 1" at 36px/700 | 36/700 | -0.36px |
| Heading 2 | "Heading 2" at 28px/700 | 28/700 | -0.28px |
| Heading 3 | "Heading 3" at 20px/600 | 20/600 | 0 |
| Body Large | "Body large for emphasis" at 18px/400 | 18/400 | 0 |
| Body | "Body text for paragraphs" at 16px/400 | 16/400 | 0 |
| Button Large | "Button Large" at 16px/500 | 16/500 | 0 |
| Button Small | "Button Small" at 14px/500 | 14/500 | 0 |
| Small | "Small supporting text" at 14px/400 | 14/400 | 0 |
| Caption | "CAPTION TEXT" at 12px/500 uppercase | 12/500 | 0.12px |
| Label | "LABEL TEXT" at 12px/600 uppercase | 12/600 | 0.24px |
| Mono | `const token = "value";` at JetBrains Mono 14px/400 | 14/400 | mono |
| Mono Small | `npm run build` at JetBrains Mono 12px/400 | 12/400 | mono |
| Mono XS | `--token-name` at JetBrains Mono 11px/400 | 11/400 | mono |

### Effects View
Three shadow cards:
- Card Shadow: visual demo box with `0 1px 3px rgba(0,0,0,.08)` applied
- Button Shadow: visual demo box with `0 1px 2px rgba(0,0,0,.06)` applied
- Terminal Glow: visual demo box with `0 4px 24px rgba(0,0,0,.5)` applied

---

## Screen 5: Variables

### States
1. **Default** — variable list + mode preview
2. **Variable selected** — highlight a row to show detail

### Layout (two-column split)

**Left: Variable List**
- **Section:** "Variable List" label
- **Table:** Variable | Light | Dark (3 columns)
- **Rows:** Surface, Text, Muted, Primary, Primary Hover, Border, Ghost Hover — each with swatch + hex for both modes

**Right: Mode Preview**
- Two cards side by side:
  - **Light card:** #fafbfc background, #0a0d14 text, "Light" label. Demo area (#f3f6fa bg) with Primary button (#d51e8c) + Outline button (#e5e7eb border)
  - **Dark card:** #0a0d14 background, #fafbfc text, "Dark" label. Demo area (#1a1a1a bg) with Primary button (#e04e9b) + Outline button (#1e1e1e border)

---

## Screen 6: Health

### States
1. **Score 100 — Excellent** — all green checks
2. **Score 87 — Warning** — some checks failed (orange)
3. **Score 0 — No data** — empty state

### Layout
- **Hero card:** SVG ring (100×100, 5px stroke, primary color, circle progress) + score text (28px/700) centered. "Excellent" title (20px/600) + description (14px muted)
- **Three metric cards:** row of 3, each: value (28px/700), label (13px muted), description (12px muted)
  - Token Coverage: 100% (green)
  - Component Parity: 100% (green)
  - Theme Modes: 2

### Detailed Checks Table
| Check | Status | Details |
|-------|--------|---------|
| Tokens Synced | Pass (green pill) | 65 tokens extracted from 18 published styles |
| Components Matched | Pass | Button → Button.tsx, ButtonWithIcon → ButtonWithIcon.tsx |
| Styles Verified | Pass | 14 TEXT + 4 EFFECT styles resolved |
| Modes Detected | Pass | Light + Dark via mode inference (no Enterprise required) |

### Health — Warning State
- Ring shows 87 (partial fill)
- "Warning" title with orange color
- Failed checks show orange "Warn" pill
- Example: "3 tokens drifted since last sync"

---

## Screen 7: Parity

### States
1. **100% coverage** — all matched
2. **Partial coverage** — some missing in code
3. **Components missing in Figma** — extra code components

### Layout
- **Title:** "Component Parity" (20px/600)
- **Summary bar:** "2 Figma components · 2 Code components · 100% coverage" (14px, muted with bold text values, green coverage pill)
- **Comparison table:**

| Figma Component | Code Component | Status | Figma Link |
|----------------|---------------|--------|-----------|
| Button | Button.tsx (mono) | Matched (green pill) | Open in Figma (primary link) |
| Button with Icon | ButtonWithIcon.tsx (mono) | Matched (green pill) | Open in Figma |

### Parity — Missing in Code State
- Summary: "5 Figma · 2 Code · 40% coverage" (orange pill)
- Missing rows: Figma name shown, Code column = "—", Status = "Missing" (orange pill)

---

## Screen 8: Export

### States
1. **CSS selected** — showing tokens.css
2. **SCSS selected** — showing _tokens.scss
3. **Tailwind selected** — showing tailwind.config.js
4. **Swift selected** — showing Tokens.swift
5. **Kotlin selected** — showing Tokens.kt
6. **JSON selected** — showing tokens.json
7. **Copied** — copy button shows "Copied!" temporarily

### Layout
- **Title:** "Export Tokens" (20px/600)
- **Platform pills:** CSS (active), SCSS, Tailwind, Swift, Kotlin, JSON
- **File preview card:**
  - Header: filename in mono (14px) + "Copy" button (primary pill small)
  - Code area: full-width, mono 12px/20px, syntax highlighted, max-height 500px scrollable

### CSS Content (shown by default)
```css
/**
 * Design Tokens — CSS Custom Properties
 * Generated by DesignxCode MCP
 */
:root {
  --designxcode-display-font-family: Google Sans;
  --designxcode-display-font-size: 60px;
  --designxcode-display-font-weight: 700;
  --designxcode-display-line-height: 66px;
  --designxcode-h1-font-size: 36px;
  --designxcode-h1-font-weight: 700;
  --designxcode-body-font-size: 16px;
  --designxcode-body-font-weight: 400;
  --designxcode-body-line-height: 26px;
  --designxcode-mono-font-family: JetBrains Mono;
  --designxcode-mono-font-size: 14px;
  --designxcode-card-shadow: 0px 1px 3px 0px #000000;
  --designxcode-button-shadow: 0px 1px 2px 0px #000000;
  --designxcode-terminal-glow: 0px 4px 24px 0px #000000;
}
```

---

## Screen 9: Settings

### States
1. **All connected** — green dots
2. **Figma disconnected** — red dot, "Connect" button
3. **GitHub disconnected** — red dot, "Add token" button
4. **Rules editing** — rule input field visible

### Layout (max-width 600px)
Three stacked cards:

**Figma Connection:**
- Title "Figma Connection" (14px/600)
- Status row: green dot (7×7) + "Connected" text + masked token (mono 12px muted: `figd_****xcxts`)
- File key: mono 12px muted

**GitHub Connection:**
- Same pattern
- Status: green + "Connected" + `ghp_****fDxL`
- Repo: `thevoiduniverse/designxcode-workspace`

**Design Rules:**
- Title "Design Rules" (14px/600)
- Rule list, each: text (13px muted), separated by 1px surface border
- Rules:
  1. Use Google Sans for all UI text, JetBrains Mono for code
  2. Primary color is #d51e8c — use for CTAs and main actions
  3. All buttons use rounded-full (pill shape), never squared corners

### Settings — Disconnected State
- Red dot instead of green
- "Disconnected" text
- "Connect" primary button shown

---

## Dark Mode (applies to ALL screens)

Every screen has a dark mode variant. The theme toggle in sidebar switches ALL values:

| Token | Light | Dark |
|-------|-------|------|
| bg | #fafbfc | #0a0d14 |
| card | #ffffff | #0a0d14 |
| surface | #f3f6fa | #1a1a1a |
| text | #0a0d14 | #fafbfc |
| muted | #6b7280 | #afb8c1 |
| primary | #d51e8c | #e04e9b |
| primary hover | #b8187a | #f06ab4 |
| border | #e5e7eb | #1e1e1e |
| shadow | 0 1px 3px rgba(0,0,0,.06) | none |

**Dark mode card treatment:** Cards use `border: 1px solid #1e1e1e` instead of shadow (no shadow in dark mode).

---

## Summary: Total Screens to Build

| Screen | States | Total Frames |
|--------|--------|-------------|
| Overview | Default, Syncing, Drift, Empty | 4 × 2 (light+dark) = 8 |
| Tokens | All, Color, Typography, Shadow, Search, Collapsed | 6 × 2 = 12 |
| Components | Grid, Preview, Code, Search | 4 × 2 = 8 |
| Styles | Typography, Effects | 2 × 2 = 4 |
| Variables | Default, Selected | 2 × 2 = 4 |
| Health | Excellent, Warning, Empty | 3 × 2 = 6 |
| Parity | 100%, Partial, Extra code | 3 × 2 = 6 |
| Export | CSS, SCSS, Tailwind, Swift, Kotlin, JSON, Copied | 7 × 2 = 14 |
| Settings | Connected, Figma disconnected, GitHub disconnected, Editing | 4 × 2 = 8 |
| **Total** | | **70 frames** |

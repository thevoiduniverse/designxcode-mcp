# Design Spec: generate_theme_config & generate_design_doc

## Overview

Two new tools for the designxcode-mcp server:

1. **`generate_theme_config`** — Extract multi-theme configurations from Figma Variable modes into CSS, Tailwind, or ThemeProvider formats.
2. **`generate_design_doc`** — Auto-generate a self-contained design system reference document (markdown, MDX, or HTML) with color palette, typography scale, spacing, component catalog, and patterns.

Both tools return structured JSON wrapped in the MCP response format: `{ content: [{ type: "text", text: JSON.stringify(output) }] }`. The inner `output` uses a standardized shape: `{ files: [{path, content, description}], summary }`. This is a deliberate standardization — existing tools vary slightly (`sync_tokens_to_code` omits `description`, `generate_component_scaffold` nests files inside components). No disk writes.

---

## Tool 1: `generate_theme_config`

### Purpose

Figma Variables support **modes** (e.g., Light, Dark, High Contrast). The existing `figmaVariablesToW3C()` pipeline preserves modes as separate token sets keyed like `"colors/light"` and `"colors/dark"`. This tool builds on that pipeline to generate theme-aware output files.

### Input Schema

```typescript
{
  figma_file_key: string            // required
  output_format: "css" | "tailwind" | "theme-provider" | "all"  // default "css"
  color_scheme_strategy: "data-attribute" | "media-query" | "class"  // CSS only, default "data-attribute"
  default_mode: string              // optional — which mode name is the base theme; auto-detects via defaultModeId if omitted
}
```

### Processing Pipeline

1. Call `figmaClient.getLocalVariables(fileKey)` to get variables and collections.
2. Call `figmaVariablesToW3C(variables, collections)` to get `tokenSets` (already mode-split).
3. Classify token sets:
   - **Base tokens**: from collections with a single mode (shared across all themes).
   - **Themed tokens**: from collections with multiple modes. Group by collection, keyed by mode name.
4. Identify the default mode using `collection.defaultModeId` (mapped to mode name). Override with `default_mode` input if provided.
5. Flatten tokens using `flattenW3CTokens()` from `context-formatter.ts`.
6. Pass to format-specific generators.

### Output Formats

#### CSS (`"css"`)

File: `theme.css`

```css
/* Base tokens (single-mode collections) */
:root {
  --spacing-4: 16px;
  --radius-md: 8px;
}

/* Default theme (Light) */
:root, [data-theme="light"] {
  --primary-500: #6366F1;
  --neutral-100: #F5F5F5;
  --text-primary: #171717;
}

/* Dark theme */
[data-theme="dark"] {
  --primary-500: #818CF8;
  --neutral-100: #262626;
  --text-primary: #FAFAFA;
}
```

Selector varies by `color_scheme_strategy`:
- `"data-attribute"` → `[data-theme="dark"]`
- `"media-query"` → `@media (prefers-color-scheme: dark)`
- `"class"` → `.theme-dark`

Mode names are sanitized for CSS selectors using the same logic as `sanitizeTokenName()` in `w3c-tokens.ts`: lowercase, spaces replaced with hyphens. E.g., "High Contrast" → `[data-theme="high-contrast"]`.

The default mode gets both `:root` and its specific selector. Non-default modes get only their specific selector.

#### Tailwind (`"tailwind"`)

File: `tailwind.theme.js`

```js
/** @type {import('tailwindcss').Config['theme']} */
module.exports = {
  extend: {
    colors: {
      primary: {
        500: 'var(--primary-500)',
      },
      neutral: {
        100: 'var(--neutral-100)',
      },
    },
    spacing: {
      '4': '16px',
    },
    borderRadius: {
      'md': '8px',
    },
    fontFamily: {
      'body': ['Inter', 'sans-serif'],
    },
  },
}
```

Tailwind output references CSS variables for themed tokens (so theme switching works via CSS). Non-themed tokens use literal values.

Token-to-Tailwind key mapping uses **name-based heuristics** (similar to `categorizeToken()` in `context-formatter.ts`), since Figma's resolved types are limited to `color`, `number`, `string`, `boolean`:

- `type === "color"` → `colors.{group}.{shade}` (parse group from token path, e.g., `primary/500` → `colors.primary.500`)
- `type === "number"` with name containing "spacing", "gap", "padding", "margin" → `spacing.{name}`
- `type === "number"` with name containing "radius", "corner" → `borderRadius.{name}`
- `type === "number"` with name containing "size", "width", "height" → `spacing.{name}` (Tailwind uses `spacing` for sizing too)
- `type === "number"` with name containing "font-size" or "text" → `fontSize.{name}`
- `type === "string"` with name containing "font" → `fontFamily.{name}`
- Unmatched tokens are placed under an `// Other tokens` comment block as CSS variables

**Note:** This generates Tailwind v3 format (`module.exports` in JS). Tailwind v4 uses CSS-native `@theme` directives — v4 support can be added as a future `tailwind_version` parameter.

#### ThemeProvider (`"theme-provider"`)

File: `theme.ts`

```typescript
export const themes = {
  light: {
    colors: {
      primary500: '#6366F1',
      neutral100: '#F5F5F5',
      textPrimary: '#171717',
    },
    spacing: {
      '4': '16px',
      '6': '24px',
    },
    borderRadius: {
      md: '8px',
    },
  },
  dark: {
    colors: {
      primary500: '#818CF8',
      neutral100: '#262626',
      textPrimary: '#FAFAFA',
    },
    spacing: {
      '4': '16px',
      '6': '24px',
    },
    borderRadius: {
      md: '8px',
    },
  },
} as const;

export type Theme = typeof themes.light;
export type ThemeName = keyof typeof themes;
```

Base (non-themed) tokens are merged into every theme object so each theme is self-contained. Spacing and sizing values include `px` units for web compatibility (consumers can parse to numbers if needed for React Native).

#### All (`"all"`)

Returns all three files.

### Return Format

```typescript
{
  files: Array<{
    path: string      // e.g., "theme.css", "tailwind.theme.js", "theme.ts"
    content: string   // Full file content
    description: string
  }>,
  summary: {
    modes: string[]           // e.g., ["light", "dark"]
    defaultMode: string       // e.g., "light"
    baseTokenCount: number    // Tokens shared across themes
    themedTokenCount: number  // Tokens that vary per theme
    formats: string[]         // Which formats were generated
  }
}
```

### Error Handling

- If the file has zero collections with multiple modes: return a result with `modes: ["default"]` and a warning message. Generate a single-theme output (still useful as a token export).
- If `default_mode` doesn't match any mode name: ignore it, fall back to auto-detection.

### Annotations

`readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true`

---

## Tool 2: `generate_design_doc`

### Purpose

Generate a self-contained design system reference document from a Figma file. Includes color palette, typography scale, spacing, component catalog with props/previews/usage examples, and inferred patterns.

### Input Schema

```typescript
{
  figma_file_key: string                                          // required
  output_format: "markdown" | "mdx" | "html" | "all"             // default "markdown"
  include_sections: ("tokens" | "components" | "patterns")[]      // optional, default all
  include_previews: boolean                                       // default true
  title: string                                                   // optional, defaults to Figma file name
}
```

### Document Structure

#### 1. Header

- Document title
- "Generated from Figma on {date}" with file link
- Table of contents (HTML/MDX only)

#### 2. Color Palette

Source: `getLocalVariables()` → `figmaVariablesToW3C()` → `flattenW3CTokens()`, filtered to `type === "color"`.

Group colors by semantic category (parsed from token path — e.g., `primary/500` → Primary group).

Per color entry:
- CSS variable name (`--primary-500`)
- Hex value (`#6366F1`)
- Visual swatch (format-dependent)

Format rendering:
- **Markdown**: `| ■ | --primary-500 | #6366F1 |` (unicode block char for swatch)
- **MDX**: `<ColorSwatch name="--primary-500" hex="#6366F1" />`
- **HTML**: `<div style="display:flex;align-items:center;gap:8px"><div style="width:32px;height:32px;border-radius:4px;background:#6366F1"></div><code>--primary-500</code> #6366F1</div>`

#### 3. Typography Scale

Source: Same token pipeline, filtered to font-related types (`fontFamily`, `fontWeight`, `number` tokens with "font"/"size"/"line" in name).

Per entry:
- Token name and CSS variable
- Value (font family, size in px, weight, line-height)
- Sample rendering (HTML/MDX only)

Format rendering:
- **Markdown**: Table with name, font-family, size, weight, line-height
- **MDX**: `<TypeSample name="heading-1" fontFamily="Inter" fontSize={32} fontWeight={700} />`
- **HTML**: `<p style="font-family:Inter;font-size:32px;font-weight:700">Heading 1 — The quick brown fox</p>`

#### 4. Spacing & Sizing Scale

Source: Same pipeline, filtered to spacing/sizing number tokens.

Sort by value ascending to show the scale progression.

Format rendering:
- **Markdown**: Table with name, value, visual bar (repeated `█` chars proportional to value)
- **MDX**: `<SpacingScale tokens={[{name: "--spacing-4", value: 16}, ...]} />`
- **HTML**: Inline-styled divs with proportional widths and labels

#### 5. Component Catalog

Source: `fetchComponentsWithProps()` from `component-context.ts`. Preview images via `figmaClient.getImages()` if `include_previews` is true.

Per component:
- **Name** (PascalCase)
- **Description** (from Figma component description)
- **Props table**: name, type (boolean/string/enum), possible values, default
- **Usage example**: synthesized JSX `<ComponentName prop="value" />`
- **Preview image**: Figma render URL (if enabled)
- **Figma link**: deep link to the component in Figma

Format rendering:
- **Markdown**: H3 heading, description paragraph, props as markdown table, fenced JSX code block, image as `![Preview](url)`
- **MDX**: Same structure but with `<PropsTable>` and `<ComponentPreview>` components
- **HTML**: Styled card with image, table, and `<pre><code>` for usage

#### 6. Patterns

Source: `inferPatterns()` from `pattern-inference.ts`. The tool checks `dsCache.get(fileKey, "patterns")` before calling `inferPatterns()` — if cached pattern markdown exists (from a prior `get_design_context` call), it reuses that. Otherwise it calls `inferPatterns()` and caches the result via `dsCache.set()`. This mirrors the caching pattern used in `get-design-context.ts`.

Only included if `include_sections` contains `"patterns"`.

Format rendering:
- All formats: grouped bullet lists (same as `formatPatternsMarkdown()` but adapted per format)

### Orchestration Flow

1. Fetch file name: `figmaClient.getFile(fileKey, 1)` → use `response.name` as default title (depth=1 to minimize payload).
2. Fetch tokens: `getLocalVariables()` → `figmaVariablesToW3C()` → `flattenW3CTokens()`
3. Fetch components: `fetchComponentsWithProps()` (shared utility from `component-context.ts`)
4. If `include_previews`: collect component node IDs (from component keys), call `figmaClient.getImages(fileKey, nodeIds, "png", 2)` to get preview URLs
5. If patterns requested: check `dsCache.get(fileKey, "patterns")` first; if miss, call `inferPatterns()` and cache result
6. Organize data into sections
7. Pass to format-specific doc generator function
8. Return `{ files: [{path, content, description}], summary }`

### Return Format

```typescript
{
  files: Array<{
    path: string        // e.g., "design-system.md", "design-system.mdx", "design-system.html"
    content: string     // Full document content
    description: string // e.g., "Design system documentation in Markdown format"
  }>,
  summary: {
    title: string
    colorCount: number
    typographyCount: number
    spacingCount: number
    componentCount: number
    patternCount: number
    formats: string[]
    includesPreviews: boolean
  }
}
```

### HTML Document Template

The HTML output is a fully self-contained document with embedded styles (no external CSS dependencies):

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{title} — Design System</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; max-width: 960px; margin: 0 auto; padding: 32px 24px; color: #1a1a1a; background: #fff; }
    h1 { font-size: 28px; margin-bottom: 8px; }
    h2 { font-size: 22px; margin: 40px 0 16px; border-bottom: 1px solid #e5e5e5; padding-bottom: 8px; }
    h3 { font-size: 18px; margin: 24px 0 12px; }
    table { width: 100%; border-collapse: collapse; margin: 12px 0; }
    th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #e5e5e5; font-size: 14px; }
    th { font-weight: 600; background: #f9f9f9; }
    code { background: #f3f3f3; padding: 2px 6px; border-radius: 3px; font-size: 13px; }
    pre { background: #f3f3f3; padding: 16px; border-radius: 6px; overflow-x: auto; margin: 12px 0; }
    pre code { background: none; padding: 0; }
    .swatch { width: 32px; height: 32px; border-radius: 4px; border: 1px solid #e5e5e5; display: inline-block; vertical-align: middle; }
    .color-row { display: flex; align-items: center; gap: 12px; padding: 6px 0; }
    .spacing-bar { background: #6366F1; height: 12px; border-radius: 2px; }
    .component-card { border: 1px solid #e5e5e5; border-radius: 8px; padding: 20px; margin: 16px 0; }
    .component-card img { max-width: 100%; height: auto; max-height: 300px; border-radius: 4px; margin: 12px 0; }
    .warning { background: #FEF3C7; border-left: 4px solid #F59E0B; padding: 12px 16px; margin: 12px 0; border-radius: 0 4px 4px 0; }
    .subtitle { color: #666; font-size: 14px; margin-bottom: 24px; }
    nav { margin: 24px 0; }
    nav a { color: #6366F1; text-decoration: none; display: block; padding: 4px 0; }
  </style>
</head>
<body>
  {content}
</body>
</html>
```

External fonts (e.g., Inter from Google Fonts) are NOT embedded — the doc uses system fonts to remain self-contained. Typography samples in the doc render with the actual font name specified in `style` attributes; the font will display correctly if installed locally, otherwise falls back to system fonts.

### MDX Component Expectations

The MDX output references components like `<ColorSwatch>`, `<TypeSample>`, `<SpacingScale>`, `<PropsTable>`, and `<ComponentPreview>`. These are **NOT provided** by the generated file — they are expected to exist in the user's MDX rendering setup (e.g., Storybook, Docusaurus, Next.js MDX config). The MDX output includes an import comment at the top documenting the expected components:

```mdx
{/* Required components: ColorSwatch, TypeSample, SpacingScale, PropsTable, ComponentPreview */}
{/* Provide these via your MDX provider or import them from your component library */}
```

If users don't have these components, the markdown format is a safer default.

### Image URL Expiration

Component preview images are temporary Figma CDN URLs that expire after approximately 2 weeks. The generated doc includes a note: "Preview images are temporary Figma CDN links. For permanent documentation, download images and host them separately." Users who need persistent docs should use the `export_assets` tool to download and self-host component images.

### Error Handling

- If `include_previews` is true but `getImages()` fails: generate doc without previews, add a warning note at the top.
- If tokens fetch fails: skip token sections, include warning, still generate component catalog.
- If patterns inference fails: skip patterns section, no error — patterns are always best-effort.
- Each section fails independently — partial docs are better than no doc.

### Annotations

`readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true`

---

## Reuse Map

| Existing code | Used by |
|---|---|
| `figmaVariablesToW3C()` + `mergeTokenSets()` (w3c-tokens.ts) | generate_theme_config |
| `flattenW3CTokens()` (context-formatter.ts) | both tools |
| `fetchComponentsWithProps()` (component-context.ts) | generate_design_doc |
| `inferPatterns()` (pattern-inference.ts) | generate_design_doc |
| `figmaClient.getImages()` (figma.ts) | generate_design_doc |
| `toPascalCase()` / `toCamelCase()` (scaffold-templates.ts) | both tools |
| `parseVariants()` (variant-parser.ts) | generate_design_doc (via fetchComponentsWithProps) |
| `toUserMessage()` (errors.ts) | both tools |
| `DesignSystemCache` (design-system-cache.ts) | generate_design_doc (patterns via cache) |

## New Files

| File | Purpose |
|---|---|
| `src/utils/theme-formatters.ts` | CSS, Tailwind, ThemeProvider generators for generate_theme_config |
| `src/utils/doc-generators.ts` | Markdown, MDX, HTML generators for generate_design_doc |
| `src/tools/generate-theme-config.ts` | Tool registration and orchestration |
| `src/tools/generate-design-doc.ts` | Tool registration and orchestration |

## Registration

Both tools registered in `src/index.ts`:
```typescript
registerGenerateThemeConfig(server, figmaClient);
registerGenerateDesignDoc(server, figmaClient, dsCache);
```

`generate_design_doc` receives `dsCache` so it can check for cached patterns before calling `inferPatterns()`, and cache the result for subsequent calls. The tool performs the cache check/store at the tool level (same pattern as `get-design-context.ts`), not inside `inferPatterns()` itself.

## Input Schema Conventions

Both tools use the same `figma_file_key` description as all existing tools for consistency:
```typescript
figma_file_key: z.string().min(1).describe("The Figma file key (from the URL: figma.com/design/{THIS_PART}/...)")
```

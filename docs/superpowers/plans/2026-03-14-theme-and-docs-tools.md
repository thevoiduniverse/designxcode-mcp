# Theme Config & Design Doc Tools — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two new MCP tools — `generate_theme_config` (multi-theme CSS/Tailwind/ThemeProvider from Figma Variable modes) and `generate_design_doc` (self-contained design system reference docs in markdown/MDX/HTML).

**Architecture:** Both tools reuse the existing Figma token pipeline (`figmaVariablesToW3C` → `flattenW3CTokens`). Each tool has a thin orchestration layer (tool file) that delegates formatting to a dedicated utility module. `generate_theme_config` classifies tokens by mode and feeds them to format-specific generators. `generate_design_doc` aggregates tokens, components, previews, and patterns into a structured document.

**Tech Stack:** TypeScript, MCP SDK v1.6.1, Zod, Figma REST API v1.

**Spec:** `docs/superpowers/specs/2026-03-14-theme-and-docs-tools.md`

---

## Chunk 1: Theme Config Tool

### Task 1: Create theme formatters utility

**Files:**
- Create: `src/utils/theme-formatters.ts`

This module contains three pure functions that take classified token data and produce file content strings.

- [ ] **Step 1: Write the theme formatters**

Create `src/utils/theme-formatters.ts`:

```typescript
/**
 * Format-specific generators for multi-theme output.
 * Each function takes classified tokens (base + themed) and returns file content.
 */

import type { FlatToken } from "./context-formatter.js";
import { toCamelCase } from "./scaffold-templates.js";

// ─── Shared Types ───

export interface ClassifiedTokens {
  /** Tokens from single-mode collections — shared across all themes */
  base: FlatToken[];
  /** Tokens from multi-mode collections, grouped by mode name */
  themed: Map<string, FlatToken[]>;
  /** Which mode is the default */
  defaultMode: string;
  /** All mode names in order */
  modes: string[];
}

// ─── Token Classification (name-based heuristics) ───

type TailwindCategory = "colors" | "spacing" | "borderRadius" | "fontSize" | "fontFamily" | "boxShadow" | "other";

function categorizeTailwind(token: FlatToken): TailwindCategory {
  if (token.type === "color") return "colors";
  const n = token.name.toLowerCase();
  if (token.type === "number" || token.type === "dimension") {
    if (n.includes("spacing") || n.includes("gap") || n.includes("padding") || n.includes("margin") || n.includes("size") || n.includes("width") || n.includes("height")) return "spacing";
    if (n.includes("radius") || n.includes("corner")) return "borderRadius";
    if (n.includes("font-size") || n.includes("text-size")) return "fontSize";
    return "spacing"; // default numeric to spacing
  }
  if (token.type === "string") {
    if (n.includes("font")) return "fontFamily";
  }
  return "other";
}

/** Sanitize a mode name for use in CSS selectors */
function sanitizeModeName(name: string): string {
  return name.replace(/\s+/g, "-").toLowerCase();
}

/** Parse a color token path into group + shade for Tailwind nesting */
function parseColorPath(token: FlatToken): { group: string; shade: string } {
  const parts = token.path;
  if (parts.length >= 2) {
    return { group: parts[parts.length - 2], shade: parts[parts.length - 1] };
  }
  return { group: "default", shade: token.name };
}

// ─── CSS Generator ───

export type CssStrategy = "data-attribute" | "media-query" | "class";

export function generateCSS(
  tokens: ClassifiedTokens,
  strategy: CssStrategy
): string {
  const lines: string[] = [];

  // Base tokens
  if (tokens.base.length > 0) {
    lines.push("/* Base tokens (shared across all themes) */");
    lines.push(":root {");
    for (const token of tokens.base) {
      lines.push(`  --${token.name}: ${formatCSSValue(token)};`);
    }
    lines.push("}");
    lines.push("");
  }

  // Themed tokens per mode
  for (const mode of tokens.modes) {
    const modeTokens = tokens.themed.get(mode) ?? [];
    if (modeTokens.length === 0) continue;

    const sanitized = sanitizeModeName(mode);
    const isDefault = mode === tokens.defaultMode;
    const selector = buildSelector(sanitized, isDefault, strategy);
    const comment = isDefault ? `/* Default theme (${mode}) */` : `/* ${mode} theme */`;

    lines.push(comment);
    lines.push(`${selector} {`);
    for (const token of modeTokens) {
      lines.push(`  --${token.name}: ${formatCSSValue(token)};`);
    }
    lines.push("}");
    lines.push("");
  }

  return lines.join("\n");
}

function buildSelector(modeName: string, isDefault: boolean, strategy: CssStrategy): string {
  const base = isDefault ? ":root, " : "";
  switch (strategy) {
    case "data-attribute":
      return `${base}[data-theme="${modeName}"]`;
    case "media-query":
      // media-query only works for light/dark — for other modes, fall back to data-attribute
      if (modeName === "dark") return `@media (prefers-color-scheme: dark)`;
      if (modeName === "light" && isDefault) return `:root`;
      return `${base}[data-theme="${modeName}"]`;
    case "class":
      return `${base}.theme-${modeName}`;
  }
}

function formatCSSValue(token: FlatToken): string {
  if (token.type === "color") return String(token.value);
  if (typeof token.value === "number") return `${token.value}px`;
  return String(token.value);
}

// ─── Tailwind Generator ───

export function generateTailwind(tokens: ClassifiedTokens): string {
  // Tailwind references CSS variables for themed tokens, literal values for base
  const allTokens = [
    ...tokens.base,
    ...(tokens.themed.get(tokens.defaultMode) ?? []),
  ];

  const groups: Record<string, Record<string, unknown>> = {
    colors: {},
    spacing: {},
    borderRadius: {},
    fontSize: {},
    fontFamily: {},
  };

  const otherTokens: FlatToken[] = [];

  for (const token of allTokens) {
    const category = categorizeTailwind(token);

    if (category === "other") {
      otherTokens.push(token);
      continue;
    }

    if (category === "colors") {
      const { group, shade } = parseColorPath(token);
      if (!groups.colors[group]) groups.colors[group] = {};
      const isThemed = tokens.themed.has(tokens.defaultMode) &&
        (tokens.themed.get(tokens.defaultMode) ?? []).some((t) => t.name === token.name);
      (groups.colors[group] as Record<string, string>)[shade] = isThemed
        ? `var(--${token.name})`
        : String(token.value);
      continue;
    }

    const key = token.path[token.path.length - 1] ?? token.name;
    const isThemed = tokens.themed.has(tokens.defaultMode) &&
      (tokens.themed.get(tokens.defaultMode) ?? []).some((t) => t.name === token.name);
    const value = isThemed ? `var(--${token.name})` : formatCSSValue(token);

    if (category === "fontFamily") {
      (groups.fontFamily as Record<string, string[]>)[key] = [String(token.value), "sans-serif"];
    } else {
      (groups[category] as Record<string, string>)[key] = value;
    }
  }

  // Remove empty groups
  for (const [key, val] of Object.entries(groups)) {
    if (Object.keys(val).length === 0) delete groups[key];
  }

  const lines: string[] = [
    "/** @type {import('tailwindcss').Config['theme']} */",
    "module.exports = {",
    "  extend: {",
  ];

  for (const [category, values] of Object.entries(groups)) {
    lines.push(`    ${category}: ${JSON.stringify(values, null, 6).replace(/\n/g, "\n    ")},`);
  }

  lines.push("  },");
  lines.push("}");

  if (otherTokens.length > 0) {
    lines.push("");
    lines.push("// Other tokens (use as CSS variables):");
    for (const token of otherTokens) {
      lines.push(`// --${token.name}: ${token.value}`);
    }
  }

  return lines.join("\n");
}

// ─── ThemeProvider Generator ───

export function generateThemeProvider(tokens: ClassifiedTokens): string {
  const themeObjects: Record<string, Record<string, Record<string, string>>> = {};

  for (const mode of tokens.modes) {
    const modeTokens = tokens.themed.get(mode) ?? [];
    // Merge base tokens into every theme
    const allTokens = [...tokens.base, ...modeTokens];

    const theme: Record<string, Record<string, string>> = {
      colors: {},
      spacing: {},
      borderRadius: {},
    };

    for (const token of allTokens) {
      const category = categorizeTailwind(token);
      const key = toCamelCase(token.name.replace(/-/g, " "));

      if (category === "colors") {
        theme.colors[key] = String(token.value);
      } else if (category === "spacing" || category === "fontSize") {
        theme.spacing[key] = formatCSSValue(token);
      } else if (category === "borderRadius") {
        theme.borderRadius[key] = formatCSSValue(token);
      } else if (category === "fontFamily") {
        if (!theme.fontFamily) theme.fontFamily = {};
        theme.fontFamily[key] = String(token.value);
      } else {
        theme.colors[key] = String(token.value);
      }
    }

    // Remove empty groups
    for (const [k, v] of Object.entries(theme)) {
      if (Object.keys(v).length === 0) delete theme[k];
    }

    themeObjects[sanitizeModeName(mode)] = theme;
  }

  const themesJson = JSON.stringify(themeObjects, null, 2);

  const lines: string[] = [
    `export const themes = ${themesJson} as const;`,
    "",
    `export type Theme = typeof themes.${sanitizeModeName(tokens.defaultMode)};`,
    `export type ThemeName = keyof typeof themes;`,
  ];

  return lines.join("\n");
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Zero errors

- [ ] **Step 3: Commit**

```bash
git add src/utils/theme-formatters.ts
git commit -m "feat: add theme formatters for CSS, Tailwind, and ThemeProvider output"
```

---

### Task 2: Create the generate_theme_config tool

**Files:**
- Create: `src/tools/generate-theme-config.ts`

- [ ] **Step 1: Write the tool**

Create `src/tools/generate-theme-config.ts`:

```typescript
/**
 * Tool: generate_theme_config — Extract multi-theme configurations from
 * Figma Variable modes into CSS, Tailwind, or ThemeProvider formats.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FigmaClient } from "../clients/figma.js";
import type { W3CTokenFile } from "../types/tokens.js";
import type { FigmaVariableCollection } from "../types/figma.js";
import { figmaVariablesToW3C } from "../utils/w3c-tokens.js";
import { flattenW3CTokens } from "../utils/context-formatter.js";
import type { FlatToken } from "../utils/context-formatter.js";
import {
  generateCSS,
  generateTailwind,
  generateThemeProvider,
} from "../utils/theme-formatters.js";
import type { ClassifiedTokens, CssStrategy } from "../utils/theme-formatters.js";
import { toUserMessage } from "../utils/errors.js";

const InputSchema = z.object({
  figma_file_key: z.string().min(1)
    .describe("The Figma file key (from the URL: figma.com/design/{THIS_PART}/...)"),
  output_format: z.enum(["css", "tailwind", "theme-provider", "all"])
    .default("css")
    .describe("Output format (default: 'css')"),
  color_scheme_strategy: z.enum(["data-attribute", "media-query", "class"])
    .default("data-attribute")
    .describe("CSS selector strategy for themes (CSS format only, default: 'data-attribute')"),
  default_mode: z.string().optional()
    .describe("Override which mode is the base theme (auto-detects if omitted)"),
}).strict();

type Input = z.infer<typeof InputSchema>;

export function registerGenerateThemeConfig(
  server: McpServer,
  figmaClient: FigmaClient
): void {
  server.registerTool(
    "generate_theme_config",
    {
      title: "Generate Theme Config",
      description: `Extract multi-theme configurations from Figma Variable modes.

Generates theme-aware output files (CSS custom properties with theme selectors,
Tailwind config, or TypeScript ThemeProvider) from Figma Variable modes (Light/Dark/etc).

Args:
  - figma_file_key (string): The Figma file key
  - output_format ('css' | 'tailwind' | 'theme-provider' | 'all'): Output format (default: 'css')
  - color_scheme_strategy ('data-attribute' | 'media-query' | 'class'): CSS selector strategy (default: 'data-attribute')
  - default_mode (string, optional): Override base theme mode name

Returns:
  JSON with generated file(s) and summary of modes/token counts.`,
      inputSchema: InputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: Input) => {
      try {
        // 1. Fetch variables and collections
        const response = await figmaClient.getLocalVariables(params.figma_file_key);
        const variables = response.meta.variables;
        const collections = response.meta.variableCollections;

        // 2. Convert to W3C format (preserves modes)
        const { tokenSets } = figmaVariablesToW3C(variables, collections);

        // 3. Classify tokens into base vs themed
        const classified = classifyTokens(tokenSets, collections, params.default_mode);

        // 4. Generate output files
        const files: Array<{ path: string; content: string; description: string }> = [];
        const formats = params.output_format === "all"
          ? ["css", "tailwind", "theme-provider"] as const
          : [params.output_format] as const;

        for (const format of formats) {
          switch (format) {
            case "css":
              files.push({
                path: "theme.css",
                content: generateCSS(classified, params.color_scheme_strategy as CssStrategy),
                description: `CSS custom properties with ${params.color_scheme_strategy} theme switching`,
              });
              break;
            case "tailwind":
              files.push({
                path: "tailwind.theme.js",
                content: generateTailwind(classified),
                description: "Tailwind v3 theme.extend config with CSS variable references for themed tokens",
              });
              break;
            case "theme-provider":
              files.push({
                path: "theme.ts",
                content: generateThemeProvider(classified),
                description: "TypeScript theme objects with type exports for ThemeProvider",
              });
              break;
          }
        }

        const output = {
          files,
          summary: {
            modes: classified.modes,
            defaultMode: classified.defaultMode,
            baseTokenCount: classified.base.length,
            themedTokenCount: Array.from(classified.themed.values()).reduce((sum, tokens) => sum + tokens.length, 0),
            formats: formats as unknown as string[],
          },
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: toUserMessage(error) }],
        };
      }
    }
  );
}

/**
 * Classify token sets into base (single-mode) and themed (multi-mode).
 * Token sets from figmaVariablesToW3C are keyed as "collection" or "collection/mode".
 */
function classifyTokens(
  tokenSets: Record<string, W3CTokenFile>,
  collections: Record<string, FigmaVariableCollection>,
  defaultModeOverride?: string
): ClassifiedTokens {
  const base: FlatToken[] = [];
  const themed = new Map<string, FlatToken[]>();
  const modeNames = new Set<string>();
  let defaultMode = "default";

  // Build a map of collection name → mode info
  const collectionModes = new Map<string, { modes: string[]; defaultModeName: string }>();
  for (const collection of Object.values(collections)) {
    const sanitizedName = collection.name.replace(/\s+/g, "-").toLowerCase();
    const defaultModeObj = collection.modes.find((m) => m.modeId === collection.defaultModeId);
    const defaultModeName = defaultModeObj?.name ?? collection.modes[0]?.name ?? "default";
    collectionModes.set(sanitizedName, {
      modes: collection.modes.map((m) => m.name),
      defaultModeName,
    });
  }

  for (const [setKey, tokenFile] of Object.entries(tokenSets)) {
    const flat = flattenW3CTokens(tokenFile);
    const parts = setKey.split("/");

    if (parts.length === 1) {
      // Single-mode collection → base tokens
      base.push(...flat);
    } else {
      // Multi-mode: key is "collection/mode"
      const modeName = parts.slice(1).join("/");
      // Convert sanitized mode name back to original case for display
      // Use the raw mode name from the key
      const displayMode = modeName;
      modeNames.add(displayMode);

      if (!themed.has(displayMode)) themed.set(displayMode, []);
      themed.get(displayMode)!.push(...flat);

      // Detect default mode
      const collectionKey = parts[0];
      const info = collectionModes.get(collectionKey);
      if (info) {
        const sanitizedDefault = info.defaultModeName.replace(/\s+/g, "-").toLowerCase();
        if (sanitizedDefault === modeName) {
          defaultMode = displayMode;
        }
      }
    }
  }

  // Override default mode if specified
  if (defaultModeOverride) {
    const sanitized = defaultModeOverride.replace(/\s+/g, "-").toLowerCase();
    if (modeNames.has(sanitized)) {
      defaultMode = sanitized;
    }
  }

  // If no multi-mode collections found, treat all as base with single "default" mode
  if (modeNames.size === 0) {
    modeNames.add("default");
    defaultMode = "default";
  }

  return {
    base,
    themed,
    defaultMode,
    modes: Array.from(modeNames),
  };
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Zero errors

- [ ] **Step 3: Commit**

```bash
git add src/tools/generate-theme-config.ts
git commit -m "feat: add generate_theme_config tool for multi-theme output"
```

---

## Chunk 2: Design Doc Tool

### Task 3: Add nodeId to FigmaComponentEntry

**Files:**
- Modify: `src/types/components.ts`
- Modify: `src/utils/component-parsers.ts`

Preview image fetching requires node IDs (the Figma Images API takes node IDs, not published component keys). The `FigmaComponentEntry` type currently lacks a `nodeId` field even though both parser functions have access to it.

- [ ] **Step 1: Add nodeId to FigmaComponentEntry**

In `src/types/components.ts`, add `nodeId` to the interface:

```typescript
export interface FigmaComponentEntry {
  name: string;
  key: string;
  description: string;
  nodeId?: string;       // ← ADD THIS LINE
  setName?: string;
  pageName?: string;
  figmaUrl?: string;
}
```

- [ ] **Step 2: Populate nodeId in extractFigmaComponents**

In `src/utils/component-parsers.ts`, in the `extractFigmaComponents` function:

In the component_sets loop (`for (const [_id, set] of Object.entries(response.meta.component_sets))`), change `_id` to `nodeId` and add `nodeId` to the pushed object:

```typescript
    for (const [nodeId, set] of Object.entries(response.meta.component_sets)) {
      if (pageName && set.containing_frame?.pageName !== pageName) continue;

      components.push({
        name: set.name,
        key: set.key,
        description: set.description,
        nodeId,
        pageName: set.containing_frame?.pageName,
        figmaUrl: `https://www.figma.com/design/${fileKey}?node-id=${set.containing_frame?.nodeId ?? ""}`,
      });
    }
```

In the individual components loop (`for (const [_id, comp] of Object.entries(response.meta.components))`), change `_id` to `nodeId` and add `nodeId`:

```typescript
    for (const [nodeId, comp] of Object.entries(response.meta.components)) {
      if (comp.componentSetId) continue;
      if (pageName && comp.containing_frame?.pageName !== pageName) continue;

      components.push({
        name: comp.name,
        key: comp.key,
        description: comp.description,
        nodeId,
        pageName: comp.containing_frame?.pageName,
        figmaUrl: `https://www.figma.com/design/${fileKey}?node-id=${comp.containing_frame?.nodeId ?? ""}`,
      });
    }
```

- [ ] **Step 3: Populate nodeId in extractFigmaComponentsFromFile**

In the same file, in the `extractFigmaComponentsFromFile` function, add `nodeId` to both push sites:

For component_sets: add `nodeId,` after `description: set.description,`
For individual components: add `nodeId,` after `description: comp.description,`

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: Zero errors

- [ ] **Step 5: Commit**

```bash
git add src/types/components.ts src/utils/component-parsers.ts
git commit -m "feat: add nodeId to FigmaComponentEntry for image API compatibility"
```

---

### Task 4: Create doc generators utility

**Files:**
- Create: `src/utils/doc-generators.ts`

This module contains three functions (markdown, MDX, HTML) that take structured design system data and produce document content.

- [ ] **Step 1: Write the doc generators**

Create `src/utils/doc-generators.ts`:

```typescript
/**
 * Format-specific document generators for design system documentation.
 * Each function takes structured design data and returns a complete document string.
 */

import type { FlatToken } from "./context-formatter.js";
import type { ComponentWithProps } from "./context-formatter.js";
import type { PatternGroup } from "./context-formatter.js";
import { toPascalCase, toCamelCase } from "./scaffold-templates.js";

// ─── Shared Types ───

export interface DocData {
  title: string;
  fileKey: string;
  generatedAt: string;
  colors: FlatToken[];
  typography: FlatToken[];
  spacing: FlatToken[];
  components: ComponentWithProps[];
  patterns: PatternGroup[];
  previews: Map<string, string>;  // nodeId → imageUrl
  warnings: string[];
}

// ─── Token Grouping ───

interface TokenGroup {
  name: string;
  tokens: FlatToken[];
}

function groupColorsByCategory(colors: FlatToken[]): TokenGroup[] {
  const groups = new Map<string, FlatToken[]>();
  for (const token of colors) {
    // Use the second-to-last path segment as group, or "Other" if flat
    const group = token.path.length >= 2
      ? token.path[token.path.length - 2].charAt(0).toUpperCase() + token.path[token.path.length - 2].slice(1)
      : "Other";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push(token);
  }
  return Array.from(groups.entries()).map(([name, tokens]) => ({ name, tokens }));
}

// ─── Markdown Generator ───

export function generateMarkdown(data: DocData): string {
  const lines: string[] = [];

  // Header
  lines.push(`# ${data.title}`);
  lines.push("");
  lines.push(`> Generated from Figma on ${data.generatedAt} — [Open in Figma](https://www.figma.com/design/${data.fileKey})`);
  lines.push("");

  if (data.warnings.length > 0) {
    for (const w of data.warnings) {
      lines.push(`> ⚠ ${w}`);
    }
    lines.push("");
  }

  // Colors
  if (data.colors.length > 0) {
    lines.push("## Color Palette");
    lines.push("");
    const groups = groupColorsByCategory(data.colors);
    for (const group of groups) {
      lines.push(`### ${group.name}`);
      lines.push("");
      lines.push("| Swatch | Variable | Value |");
      lines.push("|--------|----------|-------|");
      for (const token of group.tokens) {
        lines.push(`| ■ | \`--${token.name}\` | \`${token.value}\` |`);
      }
      lines.push("");
    }
  }

  // Typography
  if (data.typography.length > 0) {
    lines.push("## Typography Scale");
    lines.push("");
    lines.push("| Variable | Value |");
    lines.push("|----------|-------|");
    for (const token of data.typography) {
      lines.push(`| \`--${token.name}\` | ${token.value} |`);
    }
    lines.push("");
  }

  // Spacing
  if (data.spacing.length > 0) {
    lines.push("## Spacing Scale");
    lines.push("");
    lines.push("| Variable | Value | Visual |");
    lines.push("|----------|-------|--------|");
    const maxVal = Math.max(...data.spacing.map((t) => Number(t.value) || 0));
    for (const token of data.spacing) {
      const val = Number(token.value) || 0;
      const barLength = maxVal > 0 ? Math.round((val / maxVal) * 20) : 0;
      const bar = "█".repeat(barLength);
      lines.push(`| \`--${token.name}\` | ${token.value}px | ${bar} |`);
    }
    lines.push("");
  }

  // Components
  if (data.components.length > 0) {
    lines.push("## Component Catalog");
    lines.push("");
    lines.push("> Preview images are temporary Figma CDN links. For permanent documentation, download images and host them separately.");
    lines.push("");

    for (const { component, props, variantCount } of data.components) {
      const name = toPascalCase(component.name);
      lines.push(`### ${name}`);
      lines.push("");

      if (component.description) {
        lines.push(component.description);
        lines.push("");
      }

      // Preview
      const previewUrl = data.previews.get(component.nodeId ?? component.key);
      if (previewUrl) {
        lines.push(`![${name} preview](${previewUrl})`);
        lines.push("");
      }

      // Props table
      if (props.length > 0) {
        lines.push("| Prop | Type | Values | Default |");
        lines.push("|------|------|--------|---------|");
        for (const prop of props) {
          const values = prop.type === "enum" && prop.values ? prop.values.join(", ") : "—";
          lines.push(`| ${toCamelCase(prop.name)} | ${prop.type} | ${values} | ${prop.defaultValue ?? "—"} |`);
        }
        lines.push("");
      }

      // Usage
      const usageProps = props
        .filter((p) => p.defaultValue !== undefined)
        .map((p) => p.type === "boolean" ? toCamelCase(p.name) : `${toCamelCase(p.name)}="${p.defaultValue}"`)
        .join(" ");
      lines.push("```jsx");
      lines.push(`<${name}${usageProps ? " " + usageProps : ""}>content</${name}>`);
      lines.push("```");
      lines.push("");

      if (component.figmaUrl) {
        lines.push(`[Open in Figma](${component.figmaUrl})`);
        lines.push("");
      }
    }
  }

  // Patterns
  if (data.patterns.length > 0 && data.patterns.some((g) => g.patterns.length > 0)) {
    lines.push("## Usage Patterns");
    lines.push("");
    for (const group of data.patterns) {
      if (group.patterns.length === 0) continue;
      lines.push(`### ${group.category}`);
      for (const pattern of group.patterns) {
        lines.push(`- ${pattern}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

// ─── MDX Generator ───

export function generateMDX(data: DocData): string {
  const lines: string[] = [];

  lines.push("{/* Required components: ColorSwatch, TypeSample, SpacingScale, PropsTable, ComponentPreview */}");
  lines.push("{/* Provide these via your MDX provider or import them from your component library */}");
  lines.push("");

  // Header
  lines.push(`# ${data.title}`);
  lines.push("");
  lines.push(`> Generated from Figma on ${data.generatedAt} — [Open in Figma](https://www.figma.com/design/${data.fileKey})`);
  lines.push("");

  if (data.warnings.length > 0) {
    for (const w of data.warnings) {
      lines.push(`> ⚠ ${w}`);
    }
    lines.push("");
  }

  // Colors
  if (data.colors.length > 0) {
    lines.push("## Color Palette");
    lines.push("");
    const groups = groupColorsByCategory(data.colors);
    for (const group of groups) {
      lines.push(`### ${group.name}`);
      lines.push("");
      for (const token of group.tokens) {
        lines.push(`<ColorSwatch name="--${token.name}" hex="${token.value}" />`);
      }
      lines.push("");
    }
  }

  // Typography
  if (data.typography.length > 0) {
    lines.push("## Typography Scale");
    lines.push("");
    for (const token of data.typography) {
      const n = token.name.toLowerCase();
      if (n.includes("family") || n.includes("font-family")) {
        lines.push(`<TypeSample name="--${token.name}" fontFamily="${token.value}" fontSize={16} fontWeight={400} />`);
      } else if (n.includes("size") || n.includes("font-size")) {
        lines.push(`<TypeSample name="--${token.name}" fontFamily="inherit" fontSize={${token.value}} fontWeight={400} />`);
      } else {
        lines.push(`- \`--${token.name}\`: ${token.value}`);
      }
    }
    lines.push("");
  }

  // Spacing
  if (data.spacing.length > 0) {
    lines.push("## Spacing Scale");
    lines.push("");
    const tokenData = data.spacing.map((t) => `{name: "--${t.name}", value: ${t.value}}`);
    lines.push(`<SpacingScale tokens={[${tokenData.join(", ")}]} />`);
    lines.push("");
  }

  // Components
  if (data.components.length > 0) {
    lines.push("## Component Catalog");
    lines.push("");
    lines.push("> Preview images are temporary Figma CDN links.");
    lines.push("");

    for (const { component, props, variantCount } of data.components) {
      const name = toPascalCase(component.name);
      lines.push(`### ${name}`);
      lines.push("");

      if (component.description) {
        lines.push(component.description);
        lines.push("");
      }

      const previewUrl = data.previews.get(component.nodeId ?? component.key);
      if (previewUrl) {
        lines.push(`<ComponentPreview src="${previewUrl}" alt="${name}" />`);
        lines.push("");
      }

      if (props.length > 0) {
        const propsData = props.map((p) => ({
          name: toCamelCase(p.name),
          type: p.type,
          values: p.type === "enum" && p.values ? p.values : undefined,
          defaultValue: p.defaultValue,
        }));
        lines.push(`<PropsTable props={${JSON.stringify(propsData)}} />`);
        lines.push("");
      }

      const usageProps = props
        .filter((p) => p.defaultValue !== undefined)
        .map((p) => p.type === "boolean" ? toCamelCase(p.name) : `${toCamelCase(p.name)}="${p.defaultValue}"`)
        .join(" ");
      lines.push("```jsx");
      lines.push(`<${name}${usageProps ? " " + usageProps : ""}>content</${name}>`);
      lines.push("```");
      lines.push("");
    }
  }

  // Patterns
  if (data.patterns.length > 0 && data.patterns.some((g) => g.patterns.length > 0)) {
    lines.push("## Usage Patterns");
    lines.push("");
    for (const group of data.patterns) {
      if (group.patterns.length === 0) continue;
      lines.push(`### ${group.category}`);
      for (const pattern of group.patterns) {
        lines.push(`- ${pattern}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

// ─── HTML Generator ───

const HTML_TEMPLATE_START = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TITLE_PLACEHOLDER — Design System</title>
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
    nav a:hover { text-decoration: underline; }
  </style>
</head>
<body>`;

const HTML_TEMPLATE_END = `</body>\n</html>`;

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function generateHTML(data: DocData): string {
  const parts: string[] = [HTML_TEMPLATE_START.replace("TITLE_PLACEHOLDER", escapeHtml(data.title))];

  // Header
  parts.push(`  <h1>${escapeHtml(data.title)}</h1>`);
  parts.push(`  <p class="subtitle">Generated from Figma on ${data.generatedAt} — <a href="https://www.figma.com/design/${data.fileKey}">Open in Figma</a></p>`);

  if (data.warnings.length > 0) {
    for (const w of data.warnings) {
      parts.push(`  <div class="warning">${escapeHtml(w)}</div>`);
    }
  }

  // Table of contents
  const toc: string[] = [];
  if (data.colors.length > 0) toc.push('<a href="#colors">Color Palette</a>');
  if (data.typography.length > 0) toc.push('<a href="#typography">Typography Scale</a>');
  if (data.spacing.length > 0) toc.push('<a href="#spacing">Spacing Scale</a>');
  if (data.components.length > 0) toc.push('<a href="#components">Component Catalog</a>');
  if (data.patterns.some((g) => g.patterns.length > 0)) toc.push('<a href="#patterns">Usage Patterns</a>');

  if (toc.length > 0) {
    parts.push("  <nav>");
    parts.push("    <strong>Contents</strong>");
    parts.push(toc.map((a) => `    ${a}`).join("\n"));
    parts.push("  </nav>");
  }

  // Colors
  if (data.colors.length > 0) {
    parts.push('  <h2 id="colors">Color Palette</h2>');
    const groups = groupColorsByCategory(data.colors);
    for (const group of groups) {
      parts.push(`  <h3>${escapeHtml(group.name)}</h3>`);
      for (const token of group.tokens) {
        parts.push(`  <div class="color-row"><div class="swatch" style="background:${token.value}"></div><code>--${escapeHtml(token.name)}</code> ${escapeHtml(String(token.value))}</div>`);
      }
    }
  }

  // Typography
  if (data.typography.length > 0) {
    parts.push('  <h2 id="typography">Typography Scale</h2>');
    for (const token of data.typography) {
      const n = token.name.toLowerCase();
      if (n.includes("family") || n.includes("font-family")) {
        parts.push(`  <p style="font-family:${token.value},sans-serif;font-size:16px;margin:8px 0"><code>--${escapeHtml(token.name)}</code>: ${escapeHtml(String(token.value))} — The quick brown fox jumps over the lazy dog</p>`);
      } else if (n.includes("size") || n.includes("font-size")) {
        parts.push(`  <p style="font-size:${token.value}px;margin:8px 0"><code>--${escapeHtml(token.name)}</code>: ${token.value}px — The quick brown fox</p>`);
      } else {
        parts.push(`  <p style="margin:4px 0"><code>--${escapeHtml(token.name)}</code>: ${escapeHtml(String(token.value))}</p>`);
      }
    }
  }

  // Spacing
  if (data.spacing.length > 0) {
    parts.push('  <h2 id="spacing">Spacing Scale</h2>');
    const maxVal = Math.max(...data.spacing.map((t) => Number(t.value) || 0));
    for (const token of data.spacing) {
      const val = Number(token.value) || 0;
      const pct = maxVal > 0 ? (val / maxVal) * 100 : 0;
      parts.push(`  <div style="display:flex;align-items:center;gap:12px;padding:4px 0">`);
      parts.push(`    <code style="min-width:180px">--${escapeHtml(token.name)}</code>`);
      parts.push(`    <span style="min-width:50px">${val}px</span>`);
      parts.push(`    <div class="spacing-bar" style="width:${pct}%"></div>`);
      parts.push(`  </div>`);
    }
  }

  // Components
  if (data.components.length > 0) {
    parts.push('  <h2 id="components">Component Catalog</h2>');
    parts.push('  <p class="warning">Preview images are temporary Figma CDN links. For permanent documentation, download images and host them separately.</p>');

    for (const { component, props, variantCount } of data.components) {
      const name = toPascalCase(component.name);
      parts.push('  <div class="component-card">');
      parts.push(`    <h3>${escapeHtml(name)}</h3>`);

      if (component.description) {
        parts.push(`    <p>${escapeHtml(component.description)}</p>`);
      }

      const previewUrl = data.previews.get(component.nodeId ?? component.key);
      if (previewUrl) {
        parts.push(`    <img src="${escapeHtml(previewUrl)}" alt="${escapeHtml(name)} preview" />`);
      }

      if (props.length > 0) {
        parts.push("    <table>");
        parts.push("      <tr><th>Prop</th><th>Type</th><th>Values</th><th>Default</th></tr>");
        for (const prop of props) {
          const values = prop.type === "enum" && prop.values ? prop.values.join(", ") : "—";
          parts.push(`      <tr><td>${escapeHtml(toCamelCase(prop.name))}</td><td>${prop.type}</td><td>${escapeHtml(values)}</td><td>${prop.defaultValue ?? "—"}</td></tr>`);
        }
        parts.push("    </table>");
      }

      const usageProps = props
        .filter((p) => p.defaultValue !== undefined)
        .map((p) => p.type === "boolean" ? toCamelCase(p.name) : `${toCamelCase(p.name)}="${p.defaultValue}"`)
        .join(" ");
      parts.push(`    <pre><code>&lt;${escapeHtml(name)}${usageProps ? " " + escapeHtml(usageProps) : ""}&gt;content&lt;/${escapeHtml(name)}&gt;</code></pre>`);

      if (component.figmaUrl) {
        parts.push(`    <p><a href="${escapeHtml(component.figmaUrl)}">Open in Figma</a></p>`);
      }

      parts.push("  </div>");
    }
  }

  // Patterns
  if (data.patterns.length > 0 && data.patterns.some((g) => g.patterns.length > 0)) {
    parts.push('  <h2 id="patterns">Usage Patterns</h2>');
    for (const group of data.patterns) {
      if (group.patterns.length === 0) continue;
      parts.push(`  <h3>${escapeHtml(group.category)}</h3>`);
      parts.push("  <ul>");
      for (const pattern of group.patterns) {
        parts.push(`    <li>${escapeHtml(pattern)}</li>`);
      }
      parts.push("  </ul>");
    }
  }

  parts.push(HTML_TEMPLATE_END);
  return parts.join("\n");
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Zero errors

- [ ] **Step 3: Commit**

```bash
git add src/utils/doc-generators.ts
git commit -m "feat: add doc generators for markdown, MDX, and HTML design system docs"
```

---

### Task 5: Create the generate_design_doc tool

**Files:**
- Create: `src/tools/generate-design-doc.ts`

- [ ] **Step 1: Write the tool**

Create `src/tools/generate-design-doc.ts`:

```typescript
/**
 * Tool: generate_design_doc — Auto-generate a self-contained design system
 * reference document from a Figma file.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FigmaClient } from "../clients/figma.js";
import type { DesignSystemCache } from "../cache/design-system-cache.js";
import { figmaVariablesToW3C, mergeTokenSets } from "../utils/w3c-tokens.js";
import { flattenW3CTokens } from "../utils/context-formatter.js";
import type { FlatToken, ComponentWithProps, PatternGroup } from "../utils/context-formatter.js";
import { fetchComponentsWithProps } from "../utils/component-context.js";
import { inferPatterns } from "../utils/pattern-inference.js";
import { generateMarkdown, generateMDX, generateHTML } from "../utils/doc-generators.js";
import type { DocData } from "../utils/doc-generators.js";
import { toUserMessage } from "../utils/errors.js";

const InputSchema = z.object({
  figma_file_key: z.string().min(1)
    .describe("The Figma file key (from the URL: figma.com/design/{THIS_PART}/...)"),
  output_format: z.enum(["markdown", "mdx", "html", "all"])
    .default("markdown")
    .describe("Output format (default: 'markdown')"),
  include_sections: z.array(z.enum(["tokens", "components", "patterns"]))
    .optional()
    .describe("Sections to include (default: all)"),
  include_previews: z.boolean().default(true)
    .describe("Fetch Figma preview images for components (default: true)"),
  title: z.string().optional()
    .describe("Document title (defaults to Figma file name)"),
}).strict();

type Input = z.infer<typeof InputSchema>;

/** Categorize a flat token for doc sections */
function categorizeForDoc(token: FlatToken): "color" | "typography" | "spacing" | "other" {
  if (token.type === "color") return "color";
  const n = token.name.toLowerCase();
  if (n.includes("font") || n.includes("text-size") || n.includes("line-height") || n.includes("letter-spacing")) return "typography";
  if (n.includes("spacing") || n.includes("gap") || n.includes("padding") || n.includes("margin") || n.includes("size") || n.includes("width") || n.includes("height") || n.includes("radius")) return "spacing";
  if (token.type === "string" && n.includes("font")) return "typography";
  return "other";
}

export function registerGenerateDesignDoc(
  server: McpServer,
  figmaClient: FigmaClient,
  cache: DesignSystemCache
): void {
  server.registerTool(
    "generate_design_doc",
    {
      title: "Generate Design Doc",
      description: `Generate a self-contained design system reference document from a Figma file.

Includes color palette with visual swatches, typography scale, spacing scale,
component catalog with props/previews/usage examples, and inferred usage patterns.

Args:
  - figma_file_key (string): The Figma file key
  - output_format ('markdown' | 'mdx' | 'html' | 'all'): Output format (default: 'markdown')
  - include_sections (string[], optional): Sections to include (default: all)
  - include_previews (boolean): Fetch Figma component previews (default: true)
  - title (string, optional): Document title (defaults to Figma file name)

Returns:
  JSON with generated document file(s) and summary stats.`,
      inputSchema: InputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: Input) => {
      try {
        const sections = params.include_sections ?? ["tokens", "components", "patterns"];
        const warnings: string[] = [];

        // 1. Get file name for title
        let docTitle = params.title ?? "Design System";
        if (!params.title) {
          try {
            const file = await figmaClient.getFile(params.figma_file_key, 1);
            docTitle = file.name ?? "Design System";
          } catch {
            // Use default title
          }
        }

        // 2. Fetch and categorize tokens
        let colors: FlatToken[] = [];
        let typography: FlatToken[] = [];
        let spacing: FlatToken[] = [];

        if (sections.includes("tokens")) {
          try {
            const response = await figmaClient.getLocalVariables(params.figma_file_key);
            const { tokenSets } = figmaVariablesToW3C(response.meta.variables, response.meta.variableCollections);
            const merged = mergeTokenSets(tokenSets);
            const flat = flattenW3CTokens(merged);

            for (const token of flat) {
              const cat = categorizeForDoc(token);
              if (cat === "color") colors.push(token);
              else if (cat === "typography") typography.push(token);
              else if (cat === "spacing") spacing.push(token);
            }

            // Sort spacing by value ascending
            spacing.sort((a, b) => (Number(a.value) || 0) - (Number(b.value) || 0));
          } catch (error) {
            warnings.push(`Token extraction failed: ${toUserMessage(error)}`);
          }
        }

        // 3. Fetch components
        let componentsWithProps: ComponentWithProps[] = [];
        if (sections.includes("components")) {
          try {
            componentsWithProps = await fetchComponentsWithProps(figmaClient, params.figma_file_key);
          } catch (error) {
            warnings.push(`Component extraction failed: ${toUserMessage(error)}`);
          }
        }

        // 4. Fetch preview images (using nodeId from FigmaComponentEntry)
        const previews = new Map<string, string>();
        if (params.include_previews && componentsWithProps.length > 0) {
          try {
            const nodeIds = componentsWithProps
              .map((c) => c.component.nodeId)
              .filter((id): id is string => !!id);
            if (nodeIds.length > 0) {
              const imageResponse = await figmaClient.getImages(
                params.figma_file_key,
                nodeIds,
                "png",
                2
              );
              for (const [nodeId, url] of Object.entries(imageResponse.images)) {
                if (url) previews.set(nodeId, url);
              }
              if (previews.size > 0) {
                warnings.push(
                  "Preview images are temporary Figma CDN links (~2 weeks). " +
                  "For permanent docs, use export_assets to download and self-host."
                );
              }
            }
          } catch {
            warnings.push("Failed to fetch component preview images.");
          }
        }

        // 5. Patterns (with cache — store JSON, not markdown)
        let patternGroups: PatternGroup[] = [];
        if (sections.includes("patterns")) {
          const cachedPatterns = cache.get(params.figma_file_key, "patterns");
          if (cachedPatterns) {
            try {
              patternGroups = JSON.parse(cachedPatterns) as PatternGroup[];
            } catch {
              // Corrupted cache — re-infer
              patternGroups = [];
            }
          }
          if (patternGroups.length === 0) {
            try {
              patternGroups = await inferPatterns(figmaClient, params.figma_file_key);
              cache.set(params.figma_file_key, "patterns", JSON.stringify(patternGroups));
            } catch {
              // Patterns are best-effort
            }
          }
        }

        // 6. Assemble doc data
        const docData: DocData = {
          title: docTitle,
          fileKey: params.figma_file_key,
          generatedAt: new Date().toISOString().split("T")[0],
          colors,
          typography,
          spacing,
          components: componentsWithProps,
          patterns: patternGroups,
          previews,
          warnings,
        };

        // 7. Generate output files
        const files: Array<{ path: string; content: string; description: string }> = [];
        const formats = params.output_format === "all"
          ? ["markdown", "mdx", "html"] as const
          : [params.output_format] as const;

        for (const format of formats) {
          switch (format) {
            case "markdown":
              files.push({
                path: "design-system.md",
                content: generateMarkdown(docData),
                description: "Design system documentation in Markdown format",
              });
              break;
            case "mdx":
              files.push({
                path: "design-system.mdx",
                content: generateMDX(docData),
                description: "Design system documentation in MDX format (requires custom components)",
              });
              break;
            case "html":
              files.push({
                path: "design-system.html",
                content: generateHTML(docData),
                description: "Self-contained HTML design system documentation",
              });
              break;
          }
        }

        const output = {
          files,
          summary: {
            title: docTitle,
            colorCount: colors.length,
            typographyCount: typography.length,
            spacingCount: spacing.length,
            componentCount: componentsWithProps.length,
            patternCount: patternGroups.reduce((sum, g) => sum + g.patterns.length, 0),
            formats: formats as unknown as string[],
            includesPreviews: previews.size > 0,
          },
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: toUserMessage(error) }],
        };
      }
    }
  );
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Zero errors

- [ ] **Step 3: Commit**

```bash
git add src/tools/generate-design-doc.ts
git commit -m "feat: add generate_design_doc tool for design system documentation"
```

---

## Chunk 3: Registration and Verification

### Task 6: Wire both tools into index.ts

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add imports**

After the `import { registerUseDesignSystemPrompt }` line in `src/index.ts`, add:

```typescript
import { registerGenerateThemeConfig } from "./tools/generate-theme-config.js";
import { registerGenerateDesignDoc } from "./tools/generate-design-doc.js";
```

- [ ] **Step 2: Add registrations**

After the `registerUseDesignSystemPrompt(server);` call in `src/index.ts`, add:

```typescript
  registerGenerateThemeConfig(server, figmaClient);
  registerGenerateDesignDoc(server, figmaClient, dsCache);
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: Zero errors

- [ ] **Step 4: Verify tool count**

Run: `grep -c 'registerTool' src/tools/*.ts`
Expected: 13 tools total (11 existing + generate_theme_config + generate_design_doc)

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: register generate_theme_config and generate_design_doc in MCP server"
```

---

### Task 7: Manual verification

- [ ] **Step 1: Start MCP Inspector**

```bash
FIGMA_ACCESS_TOKEN=$FIGMA_ACCESS_TOKEN npx @modelcontextprotocol/inspector node dist/index.js
```

- [ ] **Step 2: Verify 13 tools appear**

Expected: All 13 tools listed including `generate_theme_config` and `generate_design_doc`.

- [ ] **Step 3: Test generate_theme_config**

Call with:
```json
{
  "figma_file_key": "fSXBK7qFUUyCtZVbO6qAoI",
  "output_format": "all"
}
```

Expected: Returns JSON with 3 files (theme.css, tailwind.theme.js, theme.ts) and a summary showing detected modes.

- [ ] **Step 4: Test generate_design_doc**

Call with:
```json
{
  "figma_file_key": "fSXBK7qFUUyCtZVbO6qAoI",
  "output_format": "html"
}
```

Expected: Returns JSON with 1 file (design-system.html) containing a self-contained HTML document.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: theme config and design doc tools — complete implementation"
```

# Design System Context Layer — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an MCP resource + tool + prompt system that provides persistent design system context (tokens, components, usage patterns, rules) to AI code generators.

**Architecture:** Four MCP resources expose cached design system data (tokens, components, patterns, rules). A `get_design_context` tool reads from these resources with optional task-relevant compression. A `set_design_rules` tool persists user-defined rules to disk. A `use-design-system` prompt template triggers the workflow. An in-memory cache with TTL avoids repeated Figma API calls.

**Tech Stack:** TypeScript, MCP SDK v1.6.1 (`McpServer.registerResource`, `ResourceTemplate`, `registerPrompt`), Zod, Figma REST API v1.

**Spec:** `docs/superpowers/specs/2026-03-14-design-system-context-layer.md`

---

## Chunk 1: Foundation — Types, Cache, Formatters

### Task 1: Add auto-layout properties to FigmaDetailedNode

**Files:**
- Modify: `src/types/figma.ts:193-204`

- [ ] **Step 1: Add auto-layout properties to FigmaDetailedNode**

In `src/types/figma.ts`, add the following optional properties to the `FigmaDetailedNode` interface after line 203 (`styles?: Record<string, string>;`):

```typescript
  // Auto-layout properties (only present on auto-layout frames)
  layoutMode?: "HORIZONTAL" | "VERTICAL" | "NONE";
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  itemSpacing?: number;
  counterAxisSpacing?: number;
  primaryAxisAlignItems?: "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN";
  counterAxisAlignItems?: "MIN" | "CENTER" | "MAX" | "BASELINE";
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Zero errors

- [ ] **Step 3: Commit**

```bash
git add src/types/figma.ts
git commit -m "feat: add auto-layout properties to FigmaDetailedNode"
```

---

### Task 2: Create the in-memory cache

**Files:**
- Create: `src/cache/design-system-cache.ts`

- [ ] **Step 1: Create cache directory**

```bash
mkdir -p src/cache
```

- [ ] **Step 2: Write the cache module**

Create `src/cache/design-system-cache.ts`:

```typescript
/**
 * In-memory cache with TTL for design system context data.
 * Keyed by "{fileKey}:{section}" — lost on server restart (acceptable for v1).
 */

export type CacheSection = "tokens" | "components" | "patterns" | "rules";

interface CacheEntry {
  data: string;
  fetchedAt: number;
  ttlMs: number;
}

/** TTL values in milliseconds */
const SECTION_TTLS: Record<CacheSection, number> = {
  tokens: 5 * 60 * 1000,       // 5 minutes
  components: 5 * 60 * 1000,   // 5 minutes
  patterns: 10 * 60 * 1000,    // 10 minutes
  rules: Infinity,              // No TTL — invalidated on write
};

export class DesignSystemCache {
  private entries = new Map<string, CacheEntry>();

  private key(fileKey: string, section: CacheSection): string {
    return `${fileKey}:${section}`;
  }

  /** Get cached data if it exists and hasn't expired */
  get(fileKey: string, section: CacheSection): string | null {
    const entry = this.entries.get(this.key(fileKey, section));
    if (!entry) return null;

    const age = Date.now() - entry.fetchedAt;
    if (age > entry.ttlMs) {
      this.entries.delete(this.key(fileKey, section));
      return null;
    }

    return entry.data;
  }

  /** Store data in cache with section-appropriate TTL */
  set(fileKey: string, section: CacheSection, data: string): void {
    this.entries.set(this.key(fileKey, section), {
      data,
      fetchedAt: Date.now(),
      ttlMs: SECTION_TTLS[section],
    });
  }

  /** Invalidate a specific section for a file */
  invalidate(fileKey: string, section: CacheSection): void {
    this.entries.delete(this.key(fileKey, section));
  }

  /** Invalidate all sections for a file */
  invalidateAll(fileKey: string): void {
    for (const section of Object.keys(SECTION_TTLS) as CacheSection[]) {
      this.entries.delete(this.key(fileKey, section));
    }
  }
}
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: Zero errors

- [ ] **Step 4: Commit**

```bash
git add src/cache/design-system-cache.ts
git commit -m "feat: add in-memory cache with TTL for design system context"
```

---

### Task 3: Create the context formatter

**Files:**
- Create: `src/utils/context-formatter.ts`

This module converts raw Figma data into LLM-optimized markdown. It has four formatters (tokens, components, patterns, rules) plus a `flattenW3CTokens()` utility.

- [ ] **Step 1: Write the context formatter**

Create `src/utils/context-formatter.ts`:

```typescript
/**
 * Formats design system data into LLM-optimized markdown.
 * Each formatter takes extracted Figma data and returns a markdown string
 * that an AI can directly reference when generating code.
 */

import type { FigmaColor } from "../types/figma.js";
import type { W3CTokenFile } from "../types/tokens.js";
import type { FigmaComponentEntry } from "../types/components.js";
import type { ComponentProp } from "../types/scaffold.js";
import { toPascalCase, toCamelCase } from "./scaffold-templates.js";

// ─── Token Formatting ───

interface FlatToken {
  name: string;
  path: string[];
  value: string | number | boolean;
  type: string;
}

/** Flatten a W3C nested token file into a flat array with CSS variable names */
export function flattenW3CTokens(
  tokens: W3CTokenFile,
  path: string[] = [],
  result: FlatToken[] = []
): FlatToken[] {
  for (const [key, val] of Object.entries(tokens)) {
    if (key.startsWith("$")) continue;

    if (typeof val === "object" && val !== null && "$value" in val) {
      const token = val as { $value: unknown; $type?: string };
      result.push({
        name: [...path, key].join("-"),
        path: [...path, key],
        value: token.$value as string | number | boolean,
        type: token.$type ?? "unknown",
      });
    } else if (typeof val === "object" && val !== null) {
      flattenW3CTokens(val as W3CTokenFile, [...path, key], result);
    }
  }
  return result;
}

/** Format tokens into markdown grouped by type */
export function formatTokensMarkdown(tokens: FlatToken[]): string {
  if (tokens.length === 0) {
    return "## Design Tokens\n\nNo tokens found in this file.\n";
  }

  const byType = new Map<string, FlatToken[]>();
  for (const token of tokens) {
    const category = categorizeToken(token);
    if (!byType.has(category)) byType.set(category, []);
    byType.get(category)!.push(token);
  }

  const lines: string[] = ["## Design Tokens\n"];
  for (const [category, categoryTokens] of byType) {
    lines.push(`### ${category}`);
    for (const token of categoryTokens) {
      lines.push(`--${token.name}: ${token.value};`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/** Categorize a token by its type for grouping */
function categorizeToken(token: FlatToken): string {
  switch (token.type) {
    case "color": return "Colors";
    case "number": {
      // Heuristic: if name contains spacing/size/gap/padding, it's spacing
      const n = token.name.toLowerCase();
      if (n.includes("spacing") || n.includes("gap") || n.includes("padding") || n.includes("margin")) return "Spacing";
      if (n.includes("radius") || n.includes("corner")) return "Border Radius";
      if (n.includes("size") || n.includes("width") || n.includes("height")) return "Sizing";
      return "Numbers";
    }
    case "fontFamily": return "Typography";
    case "fontWeight": return "Typography";
    case "string": {
      const n = token.name.toLowerCase();
      if (n.includes("font")) return "Typography";
      return "Strings";
    }
    case "shadow": return "Shadows";
    case "boolean": return "Flags";
    default: return "Other";
  }
}

// ─── Component Formatting ───

export interface ComponentWithProps {
  component: FigmaComponentEntry;
  props: ComponentProp[];
  variantCount: number;
}

/** Format components into markdown with props and usage examples */
export function formatComponentsMarkdown(components: ComponentWithProps[]): string {
  if (components.length === 0) {
    return "## Available Components\n\nNo components found.\n";
  }

  const lines: string[] = ["## Available Components\n"];

  for (const { component, props, variantCount } of components) {
    const pascalName = toPascalCase(component.name);
    lines.push(`### ${pascalName}`);

    if (props.length > 0) {
      const propStrings = props.map((p) => {
        if (p.type === "boolean") return `${toCamelCase(p.name)} (boolean)`;
        if (p.type === "enum" && p.values) return `${toCamelCase(p.name)} (${p.values.join(" | ")})`;
        return `${toCamelCase(p.name)} (string)`;
      });
      lines.push(`Props: ${propStrings.join(", ")}`);
    }

    lines.push(`Variants: ${variantCount}`);

    // Synthesize usage example
    const usageProps = props
      .filter((p) => p.defaultValue !== undefined)
      .map((p) => {
        const camel = toCamelCase(p.name);
        return p.type === "boolean"
          ? `${camel}`
          : `${camel}="${p.defaultValue}"`;
      })
      .join(" ");

    const propsStr = usageProps ? ` ${usageProps}` : "";
    lines.push(`Usage: <${pascalName}${propsStr}>content</${pascalName}>`);

    if (component.description) {
      lines.push(`Description: ${component.description}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ─── Pattern Formatting ───

export interface PatternGroup {
  category: string;
  patterns: string[];
}

/** Format patterns into markdown grouped by category */
export function formatPatternsMarkdown(groups: PatternGroup[]): string {
  if (groups.length === 0 || groups.every((g) => g.patterns.length === 0)) {
    return "## Usage Patterns\n\nNo recurring patterns detected — design may be too small or inconsistent to infer patterns. Consider adding explicit rules via set_design_rules.\n";
  }

  const lines: string[] = ["## Usage Patterns\n"];
  for (const group of groups) {
    if (group.patterns.length === 0) continue;
    lines.push(`### ${group.category}`);
    for (const pattern of group.patterns) {
      lines.push(`- ${pattern}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ─── Rules Formatting ───

export interface DesignRule {
  rule: string;
  category?: string;
}

/** Format rules into markdown */
export function formatRulesMarkdown(rules: DesignRule[]): string {
  if (rules.length === 0) {
    return "## Design Rules\n\nNo rules defined. Use set_design_rules to add constraints.\n";
  }

  const lines: string[] = ["## Design Rules\n"];
  for (const rule of rules) {
    lines.push(`- ${rule.rule}`);
  }
  lines.push("");

  return lines.join("\n");
}

// ─── Full Context Assembly ───

const CONTEXT_HEADER = `# Design System Context
Use these tokens, components, and patterns when generating code.
DO NOT use hardcoded colors, font sizes, or spacing values.
DO NOT create new components when an existing one matches.
`;

/** Assemble the full design system context document */
export function assembleContext(sections: {
  tokens?: string;
  components?: string;
  patterns?: string;
  rules?: string;
  warnings?: string[];
}): string {
  const parts: string[] = [CONTEXT_HEADER];

  if (sections.warnings && sections.warnings.length > 0) {
    parts.push(sections.warnings.map((w) => `> ⚠ ${w}`).join("\n"));
    parts.push("");
  }

  if (sections.tokens) parts.push(sections.tokens);
  if (sections.components) parts.push(sections.components);
  if (sections.patterns) parts.push(sections.patterns);
  if (sections.rules) parts.push(sections.rules);

  return parts.join("\n");
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Zero errors

- [ ] **Step 3: Commit**

```bash
git add src/utils/context-formatter.ts
git commit -m "feat: add context formatter for LLM-optimized markdown output"
```

---

### Task 4: Create the context compressor

**Files:**
- Create: `src/utils/context-compressor.ts`

- [ ] **Step 1: Write the context compressor**

Create `src/utils/context-compressor.ts`:

```typescript
/**
 * Task-relevant filtering and size-capped compression for design system context.
 * Ensures the context fits within LLM token budgets while preserving the most relevant information.
 */

import type { FlatToken } from "./context-formatter.js";
import type { ComponentWithProps } from "./context-formatter.js";
import type { PatternGroup } from "./context-formatter.js";

/** Maximum context size in estimated LLM tokens (chars / 4) */
export const MAX_CONTEXT_TOKENS = 4000;

// ─── Task-Relevant Filtering ───

/** Keywords mapped to relevant token categories */
const TASK_CATEGORY_MAP: Record<string, string[]> = {
  form: ["Colors", "Spacing", "Typography", "Border Radius"],
  login: ["Colors", "Spacing", "Typography", "Border Radius"],
  table: ["Colors", "Spacing", "Typography", "Sizing"],
  chart: ["Colors", "Sizing", "Numbers"],
  dashboard: ["Colors", "Spacing", "Typography", "Shadows", "Sizing"],
  card: ["Colors", "Spacing", "Shadows", "Border Radius"],
  nav: ["Colors", "Spacing", "Typography"],
  button: ["Colors", "Spacing", "Typography", "Border Radius"],
  modal: ["Colors", "Spacing", "Shadows", "Typography"],
  settings: ["Colors", "Spacing", "Typography"],
};

/** Filter tokens by task relevance */
export function filterTokensByTask(
  tokens: FlatToken[],
  taskDescription: string
): FlatToken[] {
  const keywords = taskDescription.toLowerCase().split(/\s+/);
  const relevantCategories = new Set<string>();

  for (const keyword of keywords) {
    const categories = TASK_CATEGORY_MAP[keyword];
    if (categories) {
      categories.forEach((c) => relevantCategories.add(c));
    }
  }

  // If no keywords matched, return all tokens
  if (relevantCategories.size === 0) return tokens;

  return tokens.filter((t) => {
    const category = categorizeTokenForFilter(t);
    return relevantCategories.has(category);
  });
}

function categorizeTokenForFilter(token: FlatToken): string {
  switch (token.type) {
    case "color": return "Colors";
    case "number": {
      const n = token.name.toLowerCase();
      if (n.includes("spacing") || n.includes("gap") || n.includes("padding")) return "Spacing";
      if (n.includes("radius")) return "Border Radius";
      if (n.includes("size") || n.includes("width") || n.includes("height")) return "Sizing";
      return "Numbers";
    }
    case "shadow": return "Shadows";
    default: {
      const n = token.name.toLowerCase();
      if (n.includes("font")) return "Typography";
      return "Other";
    }
  }
}

/** Filter components by task relevance using keyword matching */
export function filterComponentsByTask(
  components: ComponentWithProps[],
  taskDescription: string
): ComponentWithProps[] {
  const keywords = taskDescription.toLowerCase().split(/\s+/);

  // Score each component by keyword relevance
  const scored = components.map((c) => {
    const nameWords = c.component.name.toLowerCase();
    const desc = (c.component.description ?? "").toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      if (nameWords.includes(kw)) score += 2;
      if (desc.includes(kw)) score += 1;
    }
    return { component: c, score };
  });

  // If no components match keywords, return all
  const matched = scored.filter((s) => s.score > 0);
  if (matched.length === 0) return components;

  // Return matched + a few common components (Button, Input, etc.)
  const commonNames = ["button", "input", "card", "link", "icon", "text"];
  const common = scored.filter(
    (s) => s.score === 0 && commonNames.some((cn) => s.component.component.name.toLowerCase().includes(cn))
  );

  return [...matched, ...common].map((s) => s.component);
}

// ─── Size-Capped Compression ───

/** Estimate LLM token count from a string */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Progressively compress context to fit within token budget */
export function compressContext(
  context: string,
  maxTokens: number = MAX_CONTEXT_TOKENS
): string {
  if (estimateTokens(context) <= maxTokens) return context;

  let result = context;

  // Stage 1: Remove variant details (keep only prop names, drop values)
  result = result.replace(
    /Props: (.+)/g,
    (_, props: string) => {
      const simplified = props
        .split(", ")
        .map((p) => p.replace(/\s*\([^)]+\)/, ""))
        .join(", ");
      return `Props: ${simplified}`;
    }
  );

  if (estimateTokens(result) <= maxTokens) return result;

  // Stage 2: Remove Description lines from components
  result = result.replace(/^Description: .+$/gm, "");

  if (estimateTokens(result) <= maxTokens) return result;

  // Stage 3: Remove Usage lines from components
  result = result.replace(/^Usage: .+$/gm, "");

  if (estimateTokens(result) <= maxTokens) return result;

  // Stage 4: Truncate tokens to most important categories
  // Keep Colors, Spacing, Typography — drop rest
  const lines = result.split("\n");
  const keepCategories = ["Colors", "Spacing", "Typography", "Shadows"];
  let inDroppedCategory = false;
  const filtered = lines.filter((line) => {
    if (line.startsWith("### ")) {
      const category = line.replace("### ", "");
      inDroppedCategory = !keepCategories.includes(category);
      return !inDroppedCategory;
    }
    if (inDroppedCategory && (line.startsWith("--") || line.trim() === "")) {
      return false;
    }
    return true;
  });

  result = filtered.join("\n");

  // Stage 5: Hard truncate if still too long
  if (estimateTokens(result) > maxTokens) {
    const charLimit = maxTokens * 4;
    result = result.substring(0, charLimit) + "\n\n[Context truncated to fit token budget]";
  }

  return result;
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Zero errors

- [ ] **Step 3: Commit**

```bash
git add src/utils/context-compressor.ts
git commit -m "feat: add context compressor with task filtering and size capping"
```

---

## Chunk 2: Pattern Inference Engine

### Task 5: Create the pattern inference engine

**Files:**
- Create: `src/utils/pattern-inference.ts`

- [ ] **Step 0: Export figmaColorToHex from w3c-tokens.ts**

In `src/utils/w3c-tokens.ts`, change `function figmaColorToHex` (line 32) to `export function figmaColorToHex`. This avoids duplicating the function in pattern-inference.ts.

This is the most complex new module. It samples frames from Figma, walks node trees to collect observations about spacing, colors, typography, and effects, then aggregates them into human-readable pattern statements.

- [ ] **Step 1: Write the pattern inference engine**

Create `src/utils/pattern-inference.ts`:

```typescript
/**
 * Pattern inference engine — analyzes Figma layouts to detect
 * recurring design patterns (spacing, color usage, typography, effects).
 */

import type { FigmaClient } from "../clients/figma.js";
import type { FigmaDetailedNode, FigmaColor } from "../types/figma.js";
import type { PatternGroup } from "./context-formatter.js";
import { figmaColorToHex } from "./w3c-tokens.js";

/** An observation from a single node in a single frame */
interface Observation {
  category: "spacing" | "color" | "typography" | "effect" | "composition";
  context: string;       // What was observed on (e.g., "FRAME", "COMPONENT", "TEXT")
  property: string;      // What property (e.g., "paddingLeft", "fill", "fontSize")
  value: string;         // The raw value (e.g., "24", "#6366F1", "Inter/16/500")
  frameId: string;       // Which frame this was observed in
}

/** An aggregated pattern with frequency data */
interface AggregatedPattern {
  category: string;
  description: string;
  count: number;
  frameCount: number;
}

const MAX_FRAMES = 15;

/**
 * Run the full pattern inference pipeline on a Figma file.
 * Returns pattern groups formatted for the context formatter.
 */
export async function inferPatterns(
  figmaClient: FigmaClient,
  fileKey: string,
  tokenMap?: Map<string, string>  // raw value → token name mapping
): Promise<PatternGroup[]> {
  // 1. Sample frames
  const frameIds = await sampleFrames(figmaClient, fileKey);
  if (frameIds.length === 0) {
    return [];
  }

  // 2. Fetch detailed nodes
  const BATCH_SIZE = 50;
  const allObservations: Observation[] = [];

  for (let i = 0; i < frameIds.length; i += BATCH_SIZE) {
    const batch = frameIds.slice(i, i + BATCH_SIZE);
    try {
      const nodesResponse = await figmaClient.getNodes(fileKey, batch);
      for (const [frameId, nodeData] of Object.entries(nodesResponse.nodes)) {
        if (!nodeData) continue;
        collectObservations(nodeData.document, frameId, allObservations);
      }
    } catch {
      // If getNodes fails for a batch, skip it — partial results are fine
      continue;
    }
  }

  if (allObservations.length === 0) {
    return [];
  }

  // 3. Aggregate observations
  const patterns = aggregateObservations(allObservations, frameIds.length);

  // 4. Map values to tokens
  const mappedPatterns = patterns.map((p) => ({
    ...p,
    description: mapToTokens(p.description, tokenMap),
  }));

  // 5. Group by category
  return groupPatterns(mappedPatterns);
}

/** Sample up to MAX_FRAMES frames from the file using depth=2 */
async function sampleFrames(
  figmaClient: FigmaClient,
  fileKey: string
): Promise<string[]> {
  const file = await figmaClient.getFile(fileKey, 2);
  const frameIds: string[] = [];

  for (const page of file.document.children ?? []) {
    if (page.type !== "CANVAS") continue;
    for (const child of page.children ?? []) {
      // Top-level frames in pages (skip non-frame nodes)
      if (child.type === "FRAME" || child.type === "COMPONENT" || child.type === "COMPONENT_SET") {
        frameIds.push(child.id);
      }
      if (frameIds.length >= MAX_FRAMES) break;
    }
    if (frameIds.length >= MAX_FRAMES) break;
  }

  return frameIds;
}

/** Recursively walk a node tree collecting observations */
function collectObservations(
  node: FigmaDetailedNode,
  frameId: string,
  observations: Observation[]
): void {
  // Spacing observations (auto-layout frames)
  if (node.layoutMode && node.layoutMode !== "NONE") {
    if (node.paddingTop !== undefined) {
      const padding = [node.paddingTop, node.paddingRight ?? node.paddingTop, node.paddingBottom ?? node.paddingTop, node.paddingLeft ?? node.paddingTop];
      const uniform = padding.every((p) => p === padding[0]);
      if (uniform) {
        observations.push({
          category: "spacing",
          context: node.type,
          property: "padding",
          value: `${padding[0]}px`,
          frameId,
        });
      }
    }
    if (node.itemSpacing !== undefined && node.itemSpacing > 0) {
      observations.push({
        category: "spacing",
        context: node.type,
        property: "gap",
        value: `${node.itemSpacing}px`,
        frameId,
      });
    }
  }

  // Color observations (fills)
  if (node.fills) {
    for (const fill of node.fills) {
      if (fill.visible === false || fill.type !== "SOLID" || !fill.color) continue;
      const hex = figmaColorToHex(fill.color);
      const colorContext = node.type === "TEXT" ? "text" : "background";
      observations.push({
        category: "color",
        context: colorContext,
        property: "fill",
        value: hex,
        frameId,
      });
    }
  }

  // Typography observations
  if (node.type === "TEXT" && node.style) {
    const s = node.style;
    observations.push({
      category: "typography",
      context: "TEXT",
      property: "font",
      value: `${s.fontFamily}/${s.fontSize}/${s.fontWeight}`,
      frameId,
    });
  }

  // Effect observations
  if (node.effects) {
    for (const effect of node.effects) {
      if (effect.visible === false) continue;
      if (effect.type === "DROP_SHADOW" || effect.type === "INNER_SHADOW") {
        const x = effect.offset?.x ?? 0;
        const y = effect.offset?.y ?? 0;
        observations.push({
          category: "effect",
          context: node.type,
          property: "shadow",
          value: `${x}/${y}/${effect.radius}/${effect.spread ?? 0}`,
          frameId,
        });
      }
    }
  }

  // Recurse into children
  for (const child of node.children ?? []) {
    collectObservations(child, frameId, observations);
  }
}

/** Aggregate observations into patterns using frequency thresholds */
function aggregateObservations(
  observations: Observation[],
  totalFrames: number
): AggregatedPattern[] {
  // Group by category + property + value
  const groups = new Map<string, { obs: Observation[]; frames: Set<string> }>();

  for (const obs of observations) {
    const key = `${obs.category}:${obs.property}:${obs.value}`;
    if (!groups.has(key)) {
      groups.set(key, { obs: [], frames: new Set() });
    }
    const group = groups.get(key)!;
    group.obs.push(obs);
    group.frames.add(obs.frameId);
  }

  // Apply frequency threshold
  // Primary: 3+ occurrences across 2+ frames
  // Fallback (small files): 2+ occurrences in 1+ frame
  const minCount = totalFrames < 2 ? 2 : 3;
  const minFrames = totalFrames < 2 ? 1 : 2;

  const patterns: AggregatedPattern[] = [];

  for (const [_key, group] of groups) {
    if (group.obs.length < minCount || group.frames.size < minFrames) continue;

    const sample = group.obs[0];
    const description = generateDescription(sample, group.obs.length);

    patterns.push({
      category: sample.category,
      description,
      count: group.obs.length,
      frameCount: group.frames.size,
    });
  }

  // Sort by frequency (most common first)
  patterns.sort((a, b) => b.count - a.count);

  return patterns;
}

/** Generate a human-readable description for a pattern */
function generateDescription(sample: Observation, count: number): string {
  switch (sample.category) {
    case "spacing":
      if (sample.property === "padding") {
        return `${sample.context} nodes use ${sample.value} padding (${count}× observed)`;
      }
      return `${sample.context} nodes use ${sample.value} gap between children (${count}× observed)`;

    case "color":
      return `${sample.context} color ${sample.value} (${count}× observed)`;

    case "typography": {
      const [family, size, weight] = sample.value.split("/");
      return `Text uses ${family} at ${size}px weight ${weight} (${count}× observed)`;
    }

    case "effect":
      return `${sample.context} nodes use shadow ${sample.value.replace(/\//g, " ")} (${count}× observed)`;

    default:
      return `${sample.property}: ${sample.value} on ${sample.context} (${count}× observed)`;
  }
}

/** Replace raw values in descriptions with token names where possible */
function mapToTokens(
  description: string,
  tokenMap?: Map<string, string>
): string {
  if (!tokenMap) return description;

  let result = description;
  for (const [rawValue, tokenName] of tokenMap) {
    result = result.replace(rawValue, `${tokenName} (${rawValue})`);
  }
  return result;
}

/** Group patterns by category for output */
function groupPatterns(patterns: AggregatedPattern[]): PatternGroup[] {
  const categoryMap: Record<string, string> = {
    spacing: "Spacing",
    color: "Color Usage",
    typography: "Typography",
    effect: "Effects",
    composition: "Composition",
  };

  const groups = new Map<string, string[]>();

  for (const pattern of patterns) {
    const label = categoryMap[pattern.category] ?? pattern.category;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(pattern.description);
  }

  return Array.from(groups.entries()).map(([category, patterns]) => ({
    category,
    patterns,
  }));
}

// Uses figmaColorToHex from w3c-tokens.ts (must be exported — see Task 5 Step 0)
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Zero errors

- [ ] **Step 3: Commit**

```bash
git add src/utils/pattern-inference.ts
git commit -m "feat: add pattern inference engine for auto-detecting design patterns"
```

---

## Chunk 3: MCP Resources

### Task 6: Register the four MCP resources

**Files:**
- Create: `src/resources/design-system-resources.ts`

This module registers four `ResourceTemplate`-based resources that read from the cache or fetch fresh data from Figma.

- [ ] **Step 1: Create resources directory**

```bash
mkdir -p src/resources
```

- [ ] **Step 2: Write the resource registration module**

Create `src/resources/design-system-resources.ts`:

```typescript
/**
 * Registers four MCP resources for design system context:
 * - designsystem://tokens/{fileKey}
 * - designsystem://components/{fileKey}
 * - designsystem://patterns/{fileKey}
 * - designsystem://rules/{fileKey}
 */

import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FigmaClient } from "../clients/figma.js";
import type { DesignSystemCache } from "../cache/design-system-cache.js";
import { figmaVariablesToW3C, mergeTokenSets } from "../utils/w3c-tokens.js";
import {
  extractFigmaComponents,
  extractFigmaComponentsFromFile,
} from "../utils/component-parsers.js";
import { parseVariants } from "../utils/variant-parser.js";
import {
  flattenW3CTokens,
  formatTokensMarkdown,
  formatComponentsMarkdown,
  formatPatternsMarkdown,
  formatRulesMarkdown,
} from "../utils/context-formatter.js";
import type { ComponentWithProps } from "../utils/context-formatter.js";
import { inferPatterns } from "../utils/pattern-inference.js";
import { toUserMessage } from "../utils/errors.js";
import { readRulesFile } from "../tools/set-design-rules.js";
import type { FigmaComponentEntry } from "../types/components.js";

import * as fs from "node:fs";
import * as path from "node:path";

export function registerDesignSystemResources(
  server: McpServer,
  figmaClient: FigmaClient,
  cache: DesignSystemCache
): void {
  // ─── Tokens Resource ───
  server.registerResource(
    "design-system-tokens",
    new ResourceTemplate("designsystem://tokens/{fileKey}", { list: undefined }),
    { title: "Design System Tokens", description: "Design tokens as CSS variable mappings from a Figma file" },
    async (uri, variables) => {
      const fileKey = variables.fileKey as string;

      const cached = cache.get(fileKey, "tokens");
      if (cached) {
        return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: cached }] };
      }

      try {
        // Fetch variables
        const response = await figmaClient.getLocalVariables(fileKey);
        const variables_data = response.meta.variables;
        const collections = response.meta.variableCollections;

        let markdown: string;

        if (Object.keys(variables_data).length > 0) {
          const { tokenSets } = figmaVariablesToW3C(variables_data, collections);
          const merged = mergeTokenSets(tokenSets);
          const flat = flattenW3CTokens(merged);
          markdown = formatTokensMarkdown(flat);
        } else {
          markdown = "## Design Tokens\n\nNo variables found. Check if the file uses Figma Variables.\n";
        }

        cache.set(fileKey, "tokens", markdown);
        return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: markdown }] };
      } catch (error) {
        const msg = `## Design Tokens\n\n> ⚠ ${toUserMessage(error)}\n`;
        return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: msg }] };
      }
    }
  );

  // ─── Components Resource ───
  server.registerResource(
    "design-system-components",
    new ResourceTemplate("designsystem://components/{fileKey}", { list: undefined }),
    { title: "Design System Components", description: "Component inventory with props and variants from a Figma file" },
    async (uri, variables) => {
      const fileKey = variables.fileKey as string;

      const cached = cache.get(fileKey, "components");
      if (cached) {
        return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: cached }] };
      }

      try {
        const componentsWithProps = await fetchComponentsWithProps(figmaClient, fileKey);
        const markdown = formatComponentsMarkdown(componentsWithProps);
        cache.set(fileKey, "components", markdown);
        return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: markdown }] };
      } catch (error) {
        const msg = `## Available Components\n\n> ⚠ ${toUserMessage(error)}\n`;
        return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: msg }] };
      }
    }
  );

  // ─── Patterns Resource ───
  server.registerResource(
    "design-system-patterns",
    new ResourceTemplate("designsystem://patterns/{fileKey}", { list: undefined }),
    { title: "Design System Patterns", description: "Auto-inferred usage patterns from Figma layouts" },
    async (uri, variables) => {
      const fileKey = variables.fileKey as string;

      const cached = cache.get(fileKey, "patterns");
      if (cached) {
        return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: cached }] };
      }

      try {
        // Build token map for value → name mapping
        let tokenMap: Map<string, string> | undefined;
        try {
          const response = await figmaClient.getLocalVariables(fileKey);
          const { tokenSets } = figmaVariablesToW3C(response.meta.variables, response.meta.variableCollections);
          const merged = mergeTokenSets(tokenSets);
          const flat = flattenW3CTokens(merged);
          tokenMap = new Map(flat.map((t) => [String(t.value), `--${t.name}`]));
        } catch {
          // Token map is optional — patterns still work without it
        }

        const patternGroups = await inferPatterns(figmaClient, fileKey, tokenMap);
        const markdown = formatPatternsMarkdown(patternGroups);
        cache.set(fileKey, "patterns", markdown);
        return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: markdown }] };
      } catch (error) {
        const msg = `## Usage Patterns\n\n> ⚠ Pattern inference failed: ${toUserMessage(error)}. Tokens and components are still available.\n`;
        return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: msg }] };
      }
    }
  );

  // ─── Rules Resource ───
  server.registerResource(
    "design-system-rules",
    new ResourceTemplate("designsystem://rules/{fileKey}", { list: undefined }),
    { title: "Design System Rules", description: "User-defined design rules and overrides" },
    async (uri, variables) => {
      const fileKey = variables.fileKey as string;

      const cached = cache.get(fileKey, "rules");
      if (cached) {
        return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: cached }] };
      }

      const rules = readRulesFile(fileKey);
      const markdown = formatRulesMarkdown(rules);
      cache.set(fileKey, "rules", markdown);
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: markdown }] };
    }
  );
}

// NOTE: Component fetching uses the shared utility fetchComponentsWithProps()
// from src/utils/component-context.ts (see Task 6b below).
```

### Task 6b: Create shared component context utility

**Files:**
- Create: `src/utils/component-context.ts`

This extracts the duplicated `fetchComponentsWithProps` logic into a shared utility, fixing the variant key mismatch bug.

- [ ] **Step 1: Write the shared utility**

Create `src/utils/component-context.ts`:

```typescript
/**
 * Shared utility for fetching components with variant prop data.
 * Used by both the components MCP resource and the get_design_context tool.
 */

import type { FigmaClient } from "../clients/figma.js";
import type { FigmaComponentEntry } from "../types/components.js";
import type { ComponentWithProps } from "./context-formatter.js";
import {
  extractFigmaComponents,
  extractFigmaComponentsFromFile,
} from "./component-parsers.js";
import { parseVariants } from "./variant-parser.js";

/**
 * Fetch components with variant props from a Figma file.
 *
 * Key detail: The variantMap is keyed by componentSetId (a node ID like "1234:5678"),
 * which is NOT the same as the published component key. We build a name-based lookup
 * since extractFigmaComponents returns component sets by name, and variant children
 * reference their parent set by componentSetId.
 */
export async function fetchComponentsWithProps(
  figmaClient: FigmaClient,
  fileKey: string
): Promise<ComponentWithProps[]> {
  let topLevelComponents: FigmaComponentEntry[];
  // Map component set name → variant children
  let variantsBySetName: Map<string, Array<{ name: string; key: string; description: string }>>;

  try {
    const response = await figmaClient.getComponents(fileKey);
    topLevelComponents = extractFigmaComponents(response, fileKey);

    // Build: componentSetId → set name
    const setIdToName = new Map<string, string>();
    if (response.meta.component_sets) {
      for (const [nodeId, set] of Object.entries(response.meta.component_sets)) {
        setIdToName.set(nodeId, set.name);
      }
    }

    // Build: set name → variant children
    variantsBySetName = new Map();
    for (const [_id, comp] of Object.entries(response.meta.components)) {
      if (comp.componentSetId) {
        const setName = setIdToName.get(comp.componentSetId);
        if (setName) {
          if (!variantsBySetName.has(setName)) variantsBySetName.set(setName, []);
          variantsBySetName.get(setName)!.push({
            name: comp.name,
            key: comp.key,
            description: comp.description,
          });
        }
      }
    }
  } catch {
    // Fallback to file tree for unpublished components
    const fileResponse = await figmaClient.getFile(fileKey);
    topLevelComponents = extractFigmaComponentsFromFile(fileResponse, fileKey);
    variantsBySetName = new Map();
  }

  const result: ComponentWithProps[] = [];

  for (const comp of topLevelComponents) {
    // Look up variants by component name (which matches the set name)
    const variants = variantsBySetName.get(comp.name) ?? [];
    const variantEntries = variants.length > 0
      ? variants
      : [{ name: comp.name, key: comp.key, description: comp.description }];

    const props = parseVariants(variantEntries);

    result.push({
      component: comp,
      props,
      variantCount: variants.length || 1,
    });
  }

  return result;
}
```

- [ ] **Step 2: Update resources module to use shared utility**

In `src/resources/design-system-resources.ts`, replace the local `fetchComponentsWithProps` function with an import:

```typescript
import { fetchComponentsWithProps } from "../utils/component-context.js";
```

Remove the local `fetchComponentsWithProps` function and the now-unused imports (`extractFigmaComponents`, `extractFigmaComponentsFromFile`, `parseVariants`, `FigmaComponentEntry`).

Also remove the unused `fs` and `path` imports from the resources module.

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: May fail because `readRulesFile` doesn't exist yet — that's expected, it will be created in Task 7.

- [ ] **Step 4: Commit** (after Task 7 completes and build passes)

---

## Chunk 4: Tools and Prompt

### Task 7: Create the `set_design_rules` tool

**Files:**
- Create: `src/tools/set-design-rules.ts`

This tool must be created before the resources module because `design-system-resources.ts` imports `readRulesFile` from it.

- [ ] **Step 1: Write the set_design_rules tool**

Create `src/tools/set-design-rules.ts`:

```typescript
/**
 * Tool: set_design_rules — Persist user-defined design rules to a local JSON file.
 * Rules are stored at {cwd}/.designxcode/rules-{fileKey}.json.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DesignSystemCache } from "../cache/design-system-cache.js";
import type { DesignRule } from "../utils/context-formatter.js";
import { toUserMessage } from "../utils/errors.js";
import * as fs from "node:fs";
import * as path from "node:path";

interface RulesFileContent {
  fileKey: string;
  rules: Array<{ rule: string; category?: string }>;
  updatedAt: string;
}

/** Get the path to the rules file for a given fileKey */
function rulesFilePath(fileKey: string): string {
  return path.join(process.cwd(), ".designxcode", `rules-${fileKey}.json`);
}

/** Read rules from the local JSON file (returns empty array if file doesn't exist) */
export function readRulesFile(fileKey: string): DesignRule[] {
  const filePath = rulesFilePath(fileKey);
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(content) as RulesFileContent;
    return parsed.rules.map((r) => ({ rule: r.rule, category: r.category }));
  } catch {
    return [];
  }
}

const InputSchema = z.object({
  figma_file_key: z.string()
    .min(1)
    .describe("The Figma file key"),
  rules: z.array(z.object({
    rule: z.string().describe("The design rule text"),
    category: z.enum(["spacing", "color", "typography", "composition", "general"])
      .optional()
      .describe("Optional category for the rule"),
  }))
    .min(1)
    .describe("Design rules to add or set"),
  mode: z.enum(["replace", "append"])
    .default("append")
    .describe("'replace' overwrites all rules, 'append' adds to existing (default: 'append')"),
}).strict();

type Input = z.infer<typeof InputSchema>;

export function registerSetDesignRules(
  server: McpServer,
  cache: DesignSystemCache
): void {
  server.registerTool(
    "set_design_rules",
    {
      title: "Set Design Rules",
      description: `Define explicit design rules that the AI should follow when generating code.

Rules supplement auto-inferred patterns and take precedence over them.
Stored locally and persist across sessions.

Args:
  - figma_file_key (string): The Figma file key to associate rules with
  - rules (array): Design rules with optional category
  - mode ('replace' | 'append'): Whether to replace all rules or append (default: 'append')

Returns:
  Confirmation with total rule count.

Examples:
  - "Always use 8px grid" → set_design_rules with rules: [{ rule: "Always use 8px grid", category: "spacing" }]
  - "Reset all rules" → set_design_rules with mode: "replace", rules: [{ rule: "New rule" }]`,
      inputSchema: InputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: Input) => {
      try {
        const filePath = rulesFilePath(params.figma_file_key);
        const dir = path.dirname(filePath);

        // Ensure directory exists
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

        let existingRules: Array<{ rule: string; category?: string }> = [];

        if (params.mode === "append") {
          // Read existing rules
          try {
            const content = fs.readFileSync(filePath, "utf-8");
            const parsed = JSON.parse(content) as RulesFileContent;
            existingRules = parsed.rules;
          } catch {
            // File doesn't exist, start fresh
          }

          // Deduplicate by exact string match
          const existingTexts = new Set(existingRules.map((r) => r.rule));
          for (const newRule of params.rules) {
            if (!existingTexts.has(newRule.rule)) {
              existingRules.push(newRule);
            }
          }
        } else {
          existingRules = params.rules;
        }

        // Write rules file
        const fileContent: RulesFileContent = {
          fileKey: params.figma_file_key,
          rules: existingRules,
          updatedAt: new Date().toISOString(),
        };

        fs.writeFileSync(filePath, JSON.stringify(fileContent, null, 2), "utf-8");

        // Invalidate cache
        cache.invalidate(params.figma_file_key, "rules");

        const output = {
          success: true,
          totalRules: existingRules.length,
          mode: params.mode,
          filePath,
          message: `${existingRules.length} design rule(s) saved.`,
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

- [ ] **Step 3: Commit resources and rules tool together**

```bash
git add src/resources/design-system-resources.ts src/tools/set-design-rules.ts
git commit -m "feat: add MCP resources and set_design_rules tool"
```

---

### Task 8: Create the `get_design_context` tool

**Files:**
- Create: `src/tools/get-design-context.ts`

- [ ] **Step 1: Write the get_design_context tool**

Create `src/tools/get-design-context.ts`:

```typescript
/**
 * Tool: get_design_context — Read design system context from cached MCP resources,
 * optionally filter by task relevance, and return a compressed markdown document.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FigmaClient } from "../clients/figma.js";
import type { DesignSystemCache, CacheSection } from "../cache/design-system-cache.js";
import { figmaVariablesToW3C, mergeTokenSets } from "../utils/w3c-tokens.js";
import {
  flattenW3CTokens,
  formatTokensMarkdown,
  formatComponentsMarkdown,
  formatPatternsMarkdown,
  formatRulesMarkdown,
  assembleContext,
} from "../utils/context-formatter.js";
import type { ComponentWithProps } from "../utils/context-formatter.js";
import {
  filterTokensByTask,
  filterComponentsByTask,
  compressContext,
} from "../utils/context-compressor.js";
import { inferPatterns } from "../utils/pattern-inference.js";
import { fetchComponentsWithProps } from "../utils/component-context.js";
import { readRulesFile } from "./set-design-rules.js";
import { toUserMessage } from "../utils/errors.js";

const InputSchema = z.object({
  figma_file_key: z.string().min(1)
    .describe("The Figma file key"),
  task_description: z.string().optional()
    .describe("Optional task context for relevance filtering, e.g. 'build a login form'"),
  sections: z.array(z.enum(["tokens", "components", "patterns", "rules"]))
    .optional()
    .describe("Specific sections to include. Omit to include all sections."),
  refresh: z.boolean().default(false)
    .describe("Force cache invalidation and re-fetch from Figma API"),
}).strict();

type Input = z.infer<typeof InputSchema>;

export function registerGetDesignContext(
  server: McpServer,
  figmaClient: FigmaClient,
  cache: DesignSystemCache
): void {
  server.registerTool(
    "get_design_context",
    {
      title: "Get Design Context",
      description: `Load design system context (tokens, components, patterns, rules) from a Figma file.

Call this before generating UI code to ensure the output uses correct design tokens,
reuses existing components, and follows established patterns.

Args:
  - figma_file_key (string): The Figma file key
  - task_description (string, optional): Task context for relevance filtering
  - sections (string[], optional): Specific sections to include (default: all)
  - refresh (boolean): Force re-fetch from Figma (default: false)

Returns:
  Markdown document with design system tokens, components, patterns, and rules.

Examples:
  - "Load full design system" → get_design_context with just figma_file_key
  - "Get context for a login form" → get_design_context with task_description: "login form"
  - "Refresh tokens only" → get_design_context with sections: ["tokens"], refresh: true`,
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
        const sections = params.sections ?? ["tokens", "components", "patterns", "rules"];

        // Invalidate cache if refresh requested
        if (params.refresh) {
          cache.invalidateAll(params.figma_file_key);
        }

        const warnings: string[] = [];
        let tokensMarkdown: string | undefined;
        let componentsMarkdown: string | undefined;
        let patternsMarkdown: string | undefined;
        let rulesMarkdown: string | undefined;

        // ── Tokens ──
        // IMPORTANT: Cache stores the UNFILTERED result. Task filtering
        // is applied after retrieval to avoid poisoning the cache.
        if (sections.includes("tokens")) {
          tokensMarkdown = cache.get(params.figma_file_key, "tokens");
          if (!tokensMarkdown) {
            try {
              const response = await figmaClient.getLocalVariables(params.figma_file_key);
              const variables = response.meta.variables;
              const collections = response.meta.variableCollections;

              if (Object.keys(variables).length > 0) {
                const { tokenSets } = figmaVariablesToW3C(variables, collections);
                const merged = mergeTokenSets(tokenSets);
                const flat = flattenW3CTokens(merged);
                tokensMarkdown = formatTokensMarkdown(flat);
              } else {
                tokensMarkdown = "## Design Tokens\n\nNo variables found.\n";
              }

              cache.set(params.figma_file_key, "tokens", tokensMarkdown);
            } catch (error) {
              warnings.push(`Token extraction failed: ${toUserMessage(error)}`);
            }
          }

          // Apply task filtering AFTER cache retrieval
          if (tokensMarkdown && params.task_description) {
            // Re-parse flat tokens from cached markdown is expensive,
            // so we re-fetch from the W3C pipeline (cheap if already cached by the resource)
            try {
              const response = await figmaClient.getLocalVariables(params.figma_file_key);
              const { tokenSets } = figmaVariablesToW3C(response.meta.variables, response.meta.variableCollections);
              const merged = mergeTokenSets(tokenSets);
              const flat = flattenW3CTokens(merged);
              const filtered = filterTokensByTask(flat, params.task_description);
              tokensMarkdown = formatTokensMarkdown(filtered);
            } catch {
              // If re-fetch fails, use unfiltered cached version
            }
          }
        }

        // ── Components ──
        if (sections.includes("components")) {
          componentsMarkdown = cache.get(params.figma_file_key, "components");
          if (!componentsMarkdown) {
            try {
              const componentsWithProps = await fetchComponentsWithProps(figmaClient, params.figma_file_key);
              componentsMarkdown = formatComponentsMarkdown(componentsWithProps);
              cache.set(params.figma_file_key, "components", componentsMarkdown);
            } catch (error) {
              warnings.push(`Component extraction failed: ${toUserMessage(error)}`);
            }
          }

          // Apply task filtering AFTER cache retrieval
          if (componentsMarkdown && params.task_description) {
            try {
              let componentsWithProps = await fetchComponentsWithProps(figmaClient, params.figma_file_key);
              componentsWithProps = filterComponentsByTask(componentsWithProps, params.task_description);
              componentsMarkdown = formatComponentsMarkdown(componentsWithProps);
            } catch {
              // If re-fetch fails, use unfiltered cached version
            }
          }
        }

        // ── Patterns ──
        if (sections.includes("patterns")) {
          patternsMarkdown = cache.get(params.figma_file_key, "patterns");
          if (!patternsMarkdown) {
            try {
              // Build token map for value→name mapping
              let tokenMap: Map<string, string> | undefined;
              try {
                const response = await figmaClient.getLocalVariables(params.figma_file_key);
                const { tokenSets } = figmaVariablesToW3C(response.meta.variables, response.meta.variableCollections);
                const merged = mergeTokenSets(tokenSets);
                const flat = flattenW3CTokens(merged);
                tokenMap = new Map(flat.map((t) => [String(t.value), `--${t.name}`]));
              } catch {
                // Token map is optional
              }

              const patternGroups = await inferPatterns(figmaClient, params.figma_file_key, tokenMap);
              patternsMarkdown = formatPatternsMarkdown(patternGroups);
              cache.set(params.figma_file_key, "patterns", patternsMarkdown);
            } catch (error) {
              warnings.push(`Pattern inference failed: ${toUserMessage(error)}`);
              patternsMarkdown = formatPatternsMarkdown([]);
            }
          }
        }

        // ── Rules ──
        if (sections.includes("rules")) {
          rulesMarkdown = cache.get(params.figma_file_key, "rules");
          if (!rulesMarkdown) {
            const rules = readRulesFile(params.figma_file_key);
            rulesMarkdown = formatRulesMarkdown(rules);
            cache.set(params.figma_file_key, "rules", rulesMarkdown);
          }
        }

        // ── Assemble and compress ──
        let context = assembleContext({
          tokens: tokensMarkdown,
          components: componentsMarkdown,
          patterns: patternsMarkdown,
          rules: rulesMarkdown,
          warnings,
        });

        context = compressContext(context);

        return {
          content: [{ type: "text" as const, text: context }],
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

// Uses shared fetchComponentsWithProps() from src/utils/component-context.ts
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Zero errors

- [ ] **Step 3: Commit**

```bash
git add src/tools/get-design-context.ts
git commit -m "feat: add get_design_context tool with task filtering and compression"
```

---

### Task 9: Create the `use-design-system` prompt

**Files:**
- Create: `src/prompts/use-design-system.ts`

- [ ] **Step 1: Create prompts directory**

```bash
mkdir -p src/prompts
```

- [ ] **Step 2: Write the prompt registration module**

Create `src/prompts/use-design-system.ts`:

```typescript
/**
 * MCP Prompt: use-design-system
 * A prompt template that instructs the AI to load and follow
 * the project's design system before generating UI code.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerUseDesignSystemPrompt(server: McpServer): void {
  server.registerPrompt(
    "use-design-system",
    {
      title: "Use Design System",
      description: "Load your Figma design system context for AI-assisted code generation. Ensures generated code uses correct tokens, components, and patterns.",
      argsSchema: {
        figma_file_key: z.string().describe("The Figma file key (from the URL: figma.com/design/{THIS_PART}/...)"),
      },
    },
    async (args) => {
      return {
        messages: [{
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `You are working on a project with an established design system.
Before generating any UI code, call the get_design_context tool with figma_file_key "${args.figma_file_key}" to load the design system tokens, components, and patterns. Follow the returned context strictly:
- Use token CSS variables instead of hardcoded values
- Reuse existing components instead of creating new ones
- Follow the documented patterns and rules
- When in doubt, prefer the design system's conventions over generic defaults`,
          },
        }],
      };
    }
  );
}
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: Zero errors

- [ ] **Step 4: Commit**

```bash
git add src/prompts/use-design-system.ts
git commit -m "feat: add use-design-system MCP prompt template"
```

---

## Chunk 5: Registration and Verification

### Task 10: Wire everything into index.ts

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add imports to index.ts**

After line 23 (`import { registerDetectUnusedTokens } from "./tools/detect-unused-tokens.js";`), add:

```typescript
import { DesignSystemCache } from "./cache/design-system-cache.js";
import { registerDesignSystemResources } from "./resources/design-system-resources.js";
import { registerGetDesignContext } from "./tools/get-design-context.js";
import { registerSetDesignRules } from "./tools/set-design-rules.js";
import { registerUseDesignSystemPrompt } from "./prompts/use-design-system.js";
```

- [ ] **Step 2: Initialize cache and register new modules**

After line 55 (`});` — end of McpServer creation), add:

```typescript
  // Initialize design system cache
  const dsCache = new DesignSystemCache();
```

After line 66 (`registerDetectUnusedTokens(server, figmaClient, githubClient);`), add:

```typescript

  // Register design system context layer
  registerDesignSystemResources(server, figmaClient, dsCache);
  registerGetDesignContext(server, figmaClient, dsCache);
  registerSetDesignRules(server, dsCache);
  registerUseDesignSystemPrompt(server);
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: Zero errors

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: register design system resources, tools, and prompt in MCP server"
```

---

### Task 11: Fix any import/export issues and final build

**Additional modified files from review fixes:**
- `src/utils/w3c-tokens.ts` — Export `figmaColorToHex` (add `export` keyword)
- `src/utils/component-context.ts` — New shared utility for fetching components with variant props

- [ ] **Step 1: Export FlatToken type from context-formatter**

The `context-compressor.ts` imports `FlatToken` from `context-formatter.ts`. Make sure it's exported. In `src/utils/context-formatter.ts`, verify the `FlatToken` interface has `export`:

```typescript
export interface FlatToken {
```

- [ ] **Step 2: Full clean build**

```bash
npm run clean && npm run build
```

Expected: Zero errors

- [ ] **Step 3: Verify tool and resource count**

```bash
grep -c 'registerTool\|registerResource\|registerPrompt' dist/index.js
```

Expected: Should show the registration calls. Alternatively:

```bash
grep -c 'registerTool' dist/tools/*.js dist/resources/*.js
```

Expected: 11 tools total (9 existing + get_design_context + set_design_rules)

- [ ] **Step 4: Commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: resolve import/export issues for design system context layer"
```

---

### Task 12: Manual verification via MCP Inspector

- [ ] **Step 1: Start MCP Inspector**

Run: `npm run inspect`

Open the Inspector URL in browser.

- [ ] **Step 2: Verify all tools appear**

Expected: 11 tools listed, including `get_design_context` and `set_design_rules`

- [ ] **Step 3: Verify resources appear**

Expected: 4 resource templates listed:
- `designsystem://tokens/{fileKey}`
- `designsystem://components/{fileKey}`
- `designsystem://patterns/{fileKey}`
- `designsystem://rules/{fileKey}`

- [ ] **Step 4: Verify prompt appears**

Expected: `use-design-system` prompt listed with `figma_file_key` argument

- [ ] **Step 5: Test get_design_context**

Call `get_design_context` with `figma_file_key: "fSXBK7qFUUyCtZVbO6qAoI"`

Expected: Returns a markdown document with Design System Context header, tokens section, components section, patterns section, and rules section.

- [ ] **Step 6: Test set_design_rules**

Call `set_design_rules` with:
```json
{
  "figma_file_key": "fSXBK7qFUUyCtZVbO6qAoI",
  "rules": [{ "rule": "Always use 8px grid", "category": "spacing" }]
}
```

Expected: Returns success with `totalRules: 1`. File created at `.designxcode/rules-fSXBK7qFUUyCtZVbO6qAoI.json`.

- [ ] **Step 7: Test cache**

Call `get_design_context` again with the same file key. Second call should be noticeably faster (cached).

- [ ] **Step 8: Final commit**

```bash
git add -A
git commit -m "feat: design system context layer — complete implementation"
```

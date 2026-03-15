# generate_coded_components — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `generate_coded_components` MCP tool that produces pixel-perfect, production-ready coded components from Figma design system files, with variable binding resolution and 4 framework targets.

**Architecture:** A deterministic Figma-node-to-code engine. The node parser walks Figma node trees, extracts layout/style properties, resolves variable bindings to design tokens via a `VariableResolver`, diffs variants for state/dimensional overrides via a `StateDiffer`, detects nested component instances via a `CompositionResolver`, and delegates code generation to framework-specific emitters. All produce a framework-agnostic IR (`ParsedNode` + `ComponentIR`) as the bridge between Figma data and code output.

**Tech Stack:** TypeScript, MCP SDK v1.6.1, Zod, Figma REST API v1.

**Spec:** `docs/superpowers/specs/2026-03-14-generate-coded-components.md`

---

## Chunk 1: Foundation — Types & Modified Files

### Task 1: Create IR types

**Files:**
- Create: `src/types/node-ir.ts`

All intermediate representation types used across the pipeline. Code emitters consume these — they never import Figma types directly.

- [ ] **Step 1: Write the IR types**

Create `src/types/node-ir.ts`:

```typescript
/**
 * Intermediate Representation types for the Figma-to-code pipeline.
 * Code emitters consume these — they never touch Figma types directly.
 */

// ─── Parsed Node Tree ───

/** CSS properties extracted from a Figma node */
export interface ParsedStyles {
  // Layout
  display?: string;
  flexDirection?: string;
  justifyContent?: string;
  alignItems?: string;
  gap?: string;
  rowGap?: string;
  columnGap?: string;
  padding?: string;
  paddingTop?: string;
  paddingRight?: string;
  paddingBottom?: string;
  paddingLeft?: string;
  width?: string;
  height?: string;
  minWidth?: string;
  maxWidth?: string;
  minHeight?: string;
  maxHeight?: string;
  flex?: string;
  flexWrap?: string;
  overflow?: string;

  // Visual
  background?: string;
  color?: string;
  borderRadius?: string;
  border?: string;
  borderTop?: string;
  borderRight?: string;
  borderBottom?: string;
  borderLeft?: string;
  boxShadow?: string;
  opacity?: string;
  filter?: string;
  backdropFilter?: string;
  cursor?: string;

  // Typography
  fontFamily?: string;
  fontSize?: string;
  fontWeight?: string;
  lineHeight?: string;
  letterSpacing?: string;
  textAlign?: string;
  textTransform?: string;
  textDecoration?: string;

  // Catch-all
  [key: string]: string | undefined;
}

/** A resolved CSS value — either a token reference or a literal */
export interface ResolvedValue {
  /** CSS value — either var(--token-name) or a literal */
  css: string;
  /** Whether this value references a design token */
  isBound: boolean;
  /** The token name if bound (e.g., "colors-primary-500") */
  tokenName?: string;
  /** The resolved literal value (for React Native or fallback) */
  literal: string;
}

/** A parsed Figma node ready for code emission */
export interface ParsedNode {
  /** HTML tag inferred from node type */
  tag: "div" | "span" | "p" | "img" | "button" | "input" | "svg";
  /** Stable class name derived from node name */
  className: string;
  /** CSS properties with resolved values (CSS strings — may contain var()) */
  styles: ParsedStyles;
  /** Resolved values with both CSS and literal representations (for RN emitter) */
  resolvedValues: Map<string, ResolvedValue>;
  /** Child nodes */
  children: ParsedNode[];
  /** Text content for text nodes */
  textContent?: string;
  /** If true, textContent should become a component prop */
  isTextProp?: boolean;
  /** Reference to a nested component (INSTANCE node) */
  componentRef?: ComponentReference;
  /** Warnings generated during parsing (e.g., unsupported node type) */
  warnings?: string[];
}

/** Reference to a nested component instance */
export interface ComponentReference {
  /** PascalCase component name */
  componentName: string;
  /** Props to pass (from instance overrides) */
  props: Record<string, string>;
  /** nodeId of the referenced component set */
  sourceNodeId: string;
}

// ─── Component IR ───

/** A component prop derived from variants or text content */
export interface ComponentPropIR {
  name: string;
  type: "boolean" | "string" | "enum";
  values?: string[];
  defaultValue?: string;
  /** Where this prop came from */
  source: "variant" | "text-content";
}

/** Style changes for a CSS pseudo-class state */
export interface StateOverride {
  /** State name from Figma (e.g., "Hover") */
  stateName: string;
  /** CSS selector (e.g., ":hover:not(:disabled)") */
  selector: string;
  /** className → changed styles (CSS strings, may contain var()) */
  overrides: Record<string, Partial<ParsedStyles>>;
  /** className → resolved values for literal access (used by RN emitter) */
  resolvedOverrides?: Record<string, Map<string, ResolvedValue>>;
}

/** Style changes for a dimensional variant */
export interface DimensionalVariant {
  /** Prop name (e.g., "Size") */
  propName: string;
  /** Prop value (e.g., "Large") */
  propValue: string;
  /** CSS modifier class name (e.g., "button--large") */
  modifierClass: string;
  /** className → changed styles (CSS strings, may contain var()) */
  overrides: Record<string, Partial<ParsedStyles>>;
  /** className → resolved values for literal access (used by RN emitter) */
  resolvedOverrides?: Record<string, Map<string, ResolvedValue>>;
}

/** Full component IR with all variants resolved */
export interface ComponentIR {
  /** PascalCase component name */
  name: string;
  /** Original Figma component name */
  figmaName: string;
  /** Node ID in Figma */
  nodeId: string;
  /** Figma deep link */
  figmaUrl: string;
  /** Description from Figma */
  description: string;
  /** Default variant's parsed node tree */
  defaultTree: ParsedNode;
  /** State variant overrides (pseudo-class → changed styles per node) */
  stateOverrides: StateOverride[];
  /** Dimensional variant styles (prop value → changed styles per node) */
  dimensionalVariants: DimensionalVariant[];
  /** Props derived from variants + text content */
  props: ComponentPropIR[];
  /** Components this one depends on (for import generation) */
  dependencies: string[];
  /** Warnings accumulated during processing */
  warnings: string[];
}

// ─── Variant Info (from Figma API) ───

/** A variant entry with its node ID for fetching */
export interface VariantEntry {
  /** Node ID of this specific variant */
  nodeId: string;
  /** Variant name string, e.g., "Size=Large, State=Hover" */
  name: string;
  /** Parsed prop key-value pairs */
  propValues: Record<string, string>;
}

/** Emitter output for a single component */
export interface EmittedComponent {
  componentName: string;
  figmaName: string;
  figmaUrl: string;
  files: Array<{
    path: string;
    content: string;
    description: string;
  }>;
  props: ComponentPropIR[];
  dependencies: string[];
  warnings: string[];
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Zero errors

- [ ] **Step 3: Commit**

```bash
git add src/types/node-ir.ts
git commit -m "feat: add IR types for coded component generation pipeline"
```

---

### Task 2: Extend FigmaDetailedNode and export sanitizeTokenName

**Files:**
- Modify: `src/types/figma.ts`
- Modify: `src/utils/w3c-tokens.ts`

Add missing Figma API properties needed by the node parser, and export `sanitizeTokenName`.

- [ ] **Step 1: Extend FigmaDetailedNode**

In `src/types/figma.ts`, add these properties to the `FigmaDetailedNode` interface (after the existing `counterAxisAlignItems` field):

```typescript
  // Sizing & constraints
  layoutSizingHorizontal?: "FIXED" | "HUG" | "FILL";
  layoutSizingVertical?: "FIXED" | "HUG" | "FILL";
  layoutWrap?: "NO_WRAP" | "WRAP";
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;

  // Absolute size (for FIXED sizing)
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number };

  // Border & corner
  strokeWeight?: number;
  strokeAlign?: "INSIDE" | "OUTSIDE" | "CENTER";
  individualStrokeWeights?: { top: number; right: number; bottom: number; left: number };
  cornerRadius?: number;
  rectangleCornerRadii?: [number, number, number, number];

  // Visual
  opacity?: number;
  visible?: boolean;
  clipsContent?: boolean;

  // Text
  characters?: string;

  // Component instances
  componentId?: string;

  // Variable bindings
  boundVariables?: Record<string, FigmaVariableAlias | FigmaVariableAlias[]>;
```

- [ ] **Step 2: Extend FigmaPaint**

In the same file, add `gradientHandlePositions` to the `FigmaPaint` interface:

```typescript
  gradientHandlePositions?: Array<{ x: number; y: number }>;
```

- [ ] **Step 3: Export sanitizeTokenName**

In `src/utils/w3c-tokens.ts`, change:
```typescript
function sanitizeTokenName(name: string): string {
```
to:
```typescript
export function sanitizeTokenName(name: string): string {
```

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: Zero errors

- [ ] **Step 5: Commit**

```bash
git add src/types/figma.ts src/utils/w3c-tokens.ts
git commit -m "feat: extend FigmaDetailedNode for coded component parsing, export sanitizeTokenName"
```

---

## Chunk 2: Core Engine — Variable Resolver & Node Parser

### Task 3: Create variable resolver

**Files:**
- Create: `src/utils/variable-resolver.ts`

Resolves Figma `boundVariables` to CSS custom property references. This is the bridge between Figma's variable system and design tokens in code.

- [ ] **Step 1: Write the variable resolver**

Create `src/utils/variable-resolver.ts`:

```typescript
/**
 * Resolves Figma boundVariables to CSS custom property references.
 * Each Figma node property can be bound to a variable (design token).
 * This resolver looks up the variable by ID and converts it to a CSS var() reference.
 */

import type {
  FigmaVariable,
  FigmaVariableAlias,
  FigmaColor,
} from "../types/figma.js";
import type { ResolvedValue } from "../types/node-ir.js";
import { figmaColorToHex } from "./w3c-tokens.js";
import { sanitizeTokenName } from "./w3c-tokens.js";

export class VariableResolver {
  private variables: Record<string, FigmaVariable>;

  constructor(variables: Record<string, FigmaVariable>) {
    this.variables = variables;
  }

  /**
   * Resolve a variable alias binding to a CSS value.
   * Returns var(--token-name) for web, literal for React Native.
   */
  resolveBinding(binding: FigmaVariableAlias): ResolvedValue {
    const variable = this.variables[binding.id];
    if (!variable) {
      return { css: "/* unresolved variable */", isBound: false, literal: "" };
    }

    const tokenName = this.variableNameToToken(variable.name);
    const literal = this.resolveToLiteral(variable);

    return {
      css: `var(--${tokenName})`,
      isBound: true,
      tokenName,
      literal,
    };
  }

  /**
   * Convert a Figma variable name (e.g., "colors/primary/500") to a
   * CSS custom property name (e.g., "colors-primary-500").
   */
  private variableNameToToken(name: string): string {
    return name
      .split("/")
      .map((segment) => sanitizeTokenName(segment))
      .join("-");
  }

  /**
   * Resolve a variable to its literal value (for React Native or fallback).
   * Follows alias chains to the final value.
   */
  private resolveToLiteral(
    variable: FigmaVariable,
    visited: Set<string> = new Set()
  ): string {
    if (visited.has(variable.id)) return "";
    visited.add(variable.id);

    // Get value from the first available mode
    const value = Object.values(variable.valuesByMode)[0];
    if (value === undefined) return "";

    // Follow alias chain
    if (isAlias(value)) {
      const aliased = this.variables[value.id];
      if (aliased) return this.resolveToLiteral(aliased, visited);
      return "";
    }

    // Resolve based on type
    if (variable.resolvedType === "COLOR" && isColor(value)) {
      return figmaColorToHex(value);
    }

    if (typeof value === "number") {
      return `${value}px`;
    }

    return String(value);
  }

  /**
   * Resolve a raw (unbound) color to hex.
   */
  resolveColor(color: FigmaColor): ResolvedValue {
    const hex = figmaColorToHex(color);
    return { css: hex, isBound: false, literal: hex };
  }

  /**
   * Resolve a numeric value, checking boundVariables first.
   * @param value - The raw numeric value from the node
   * @param boundVar - The variable alias if bound, or undefined
   * @param unit - CSS unit to append (default: "px")
   */
  resolveNumber(
    value: number | undefined,
    boundVar: FigmaVariableAlias | undefined,
    unit: string = "px"
  ): ResolvedValue | null {
    if (value === undefined && !boundVar) return null;

    if (boundVar) {
      return this.resolveBinding(boundVar);
    }

    if (value !== undefined) {
      const literal = `${value}${unit}`;
      return { css: literal, isBound: false, literal };
    }

    return null;
  }

  /**
   * Resolve a fill (solid color or gradient) to a CSS value.
   * @param fill - The Figma paint object
   * @param colorBinding - The variable alias for the color, if bound
   */
  resolveFill(
    fill: { type: string; color?: FigmaColor; opacity?: number; gradientStops?: Array<{ position: number; color: FigmaColor }>; gradientHandlePositions?: Array<{ x: number; y: number }> },
    colorBinding?: FigmaVariableAlias
  ): ResolvedValue | null {
    if (fill.type === "SOLID" && fill.color) {
      if (colorBinding) {
        return this.resolveBinding(colorBinding);
      }
      const color = { ...fill.color };
      if (fill.opacity !== undefined) {
        color.a = fill.opacity;
      }
      return this.resolveColor(color);
    }

    if (fill.type === "GRADIENT_LINEAR" && fill.gradientStops && fill.gradientHandlePositions) {
      const angle = calculateGradientAngle(fill.gradientHandlePositions);
      const stops = fill.gradientStops
        .map((stop) => {
          const hex = figmaColorToHex(stop.color);
          const pct = Math.round(stop.position * 100);
          return `${hex} ${pct}%`;
        })
        .join(", ");
      const css = `linear-gradient(${angle}deg, ${stops})`;
      return { css, isBound: false, literal: css };
    }

    return null;
  }
}

// ─── Helpers ───

function isAlias(value: unknown): value is FigmaVariableAlias {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value as FigmaVariableAlias).type === "VARIABLE_ALIAS"
  );
}

function isColor(value: unknown): value is FigmaColor {
  return (
    typeof value === "object" &&
    value !== null &&
    "r" in value &&
    "g" in value &&
    "b" in value &&
    "a" in value
  );
}

/**
 * Calculate CSS gradient angle from Figma gradient handle positions.
 * Figma uses two points (start and end) in a 0-1 coordinate space.
 */
function calculateGradientAngle(
  handles: Array<{ x: number; y: number }>
): number {
  if (handles.length < 2) return 180;
  const [start, end] = handles;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  // Convert from Figma's coordinate system to CSS degrees
  // CSS: 0deg = to top, 90deg = to right
  const radians = Math.atan2(dx, -dy);
  let degrees = Math.round((radians * 180) / Math.PI);
  if (degrees < 0) degrees += 360;
  return degrees;
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Zero errors

- [ ] **Step 3: Commit**

```bash
git add src/utils/variable-resolver.ts
git commit -m "feat: add VariableResolver for Figma variable binding resolution"
```

---

### Task 4: Create node parser

**Files:**
- Create: `src/utils/node-parser.ts`

The core engine: walks a Figma node tree and extracts every visual property into the ParsedNode IR. This is the largest single file in the pipeline.

- [ ] **Step 1: Write the node parser**

Create `src/utils/node-parser.ts`:

```typescript
/**
 * Walks a Figma node tree and extracts visual properties into a ParsedNode IR.
 * Handles auto-layout, fills, strokes, effects, typography, and variable bindings.
 */

import type {
  FigmaDetailedNode,
  FigmaVariableAlias,
  FigmaPaint,
  FigmaEffect,
} from "../types/figma.js";
import type { ParsedNode, ParsedStyles, ResolvedValue } from "../types/node-ir.js";
import { VariableResolver } from "./variable-resolver.js";
import { figmaColorToHex } from "./w3c-tokens.js";

// ─── Node type constants ───

const SKIP_TYPES = new Set([
  "VECTOR",
  "BOOLEAN_OPERATION",
  "STAR",
  "LINE",
  "ELLIPSE",
  "REGULAR_POLYGON",
]);

const TEXT_TYPE = "TEXT";
const INSTANCE_TYPE = "INSTANCE";
const FRAME_TYPES = new Set([
  "FRAME",
  "GROUP",
  "COMPONENT",
  "COMPONENT_SET",
  "SECTION",
  "RECTANGLE",
]);

// ─── Public API ───

/**
 * Parse a Figma node tree into a framework-agnostic ParsedNode IR.
 */
export function parseNodeTree(
  node: FigmaDetailedNode,
  resolver: VariableResolver,
  knownComponentIds?: Set<string>
): ParsedNode {
  return walkNode(node, resolver, knownComponentIds ?? new Set(), 0);
}

// ─── Tree Walker ───

function walkNode(
  node: FigmaDetailedNode,
  resolver: VariableResolver,
  knownComponentIds: Set<string>,
  depth: number
): ParsedNode {
  const warnings: string[] = [];

  // Skip invisible nodes
  if (node.visible === false) {
    return {
      tag: "div",
      className: sanitizeClassName(node.name),
      styles: { display: "none" },
      resolvedValues: new Map(),
      children: [],
      warnings: ["Node is hidden"],
    };
  }

  // Handle unsupported node types
  if (SKIP_TYPES.has(node.type)) {
    warnings.push(
      `Vector node "${node.name}" — use export_assets tool to export as SVG`
    );
    return {
      tag: "div",
      className: sanitizeClassName(node.name),
      styles: {},
      resolvedValues: new Map(),
      children: [],
      warnings,
    };
  }

  // Handle text nodes
  if (node.type === TEXT_TYPE) {
    return parseTextNode(node, resolver);
  }

  // Handle component instances
  if (node.type === INSTANCE_TYPE && node.componentId) {
    if (knownComponentIds.has(node.componentId) && depth < 3) {
      // This is a known component — will be resolved by CompositionResolver
      return {
        tag: "div",
        className: sanitizeClassName(node.name),
        styles: {},
        resolvedValues: new Map(),
        children: [],
        componentRef: {
          componentName: "", // Filled in by CompositionResolver
          props: {},
          sourceNodeId: node.componentId,
        },
      };
    }
    // Unknown or too deep — parse inline
  }

  // Parse frame/rectangle/group nodes
  const { styles, resolvedValues } = extractStyles(node, resolver);
  const children: ParsedNode[] = [];

  if (node.children) {
    for (const child of node.children) {
      if (child.visible === false) continue;
      children.push(walkNode(child, resolver, knownComponentIds, depth + 1));
    }
  }

  return {
    tag: inferTag(node),
    className: sanitizeClassName(node.name),
    styles,
    resolvedValues,
    children,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

// ─── Style Extraction ───

function extractStyles(
  node: FigmaDetailedNode,
  resolver: VariableResolver
): { styles: ParsedStyles; resolvedValues: Map<string, ResolvedValue> } {
  const styles: ParsedStyles = {};
  const resolvedValues = new Map<string, ResolvedValue>();
  const bound = node.boundVariables ?? {};

  // Helper: store a ResolvedValue when setting a style property
  const setResolved = (prop: string, rv: ResolvedValue) => {
    styles[prop] = rv.css;
    resolvedValues.set(prop, rv);
  };

  // Layout
  extractLayout(node, resolver, bound, styles, setResolved);

  // Fills (background)
  extractFills(node, resolver, bound, styles, setResolved);

  // Strokes (border)
  extractStrokes(node, resolver, bound, styles, setResolved);

  // Effects (shadow, blur)
  extractEffects(node, styles);

  // Corner radius
  extractCornerRadius(node, resolver, bound, styles, setResolved);

  // Opacity
  if (node.opacity !== undefined && node.opacity < 1) {
    styles.opacity = String(node.opacity);
  }

  // Overflow
  if (node.clipsContent) {
    styles.overflow = "hidden";
  }

  // Populate resolvedValues from styles that came from resolver
  // Each style property that was resolved from a variable binding has
  // its ResolvedValue stored alongside the CSS string in the styles map.
  // The extractXxx helpers call storeResolved() to populate this map.

  return { styles, resolvedValues };
}

// ─── Layout ───

type SetResolved = (prop: string, rv: ResolvedValue) => void;

function extractLayout(
  node: FigmaDetailedNode,
  resolver: VariableResolver,
  bound: Record<string, FigmaVariableAlias | FigmaVariableAlias[]>,
  styles: ParsedStyles,
  setResolved: SetResolved
): void {
  if (!node.layoutMode || node.layoutMode === "NONE") return;

  styles.display = "flex";
  styles.flexDirection = node.layoutMode === "HORIZONTAL" ? "row" : "column";

  // Wrap
  if (node.layoutWrap === "WRAP") {
    styles.flexWrap = "wrap";
  }

  // Alignment
  if (node.primaryAxisAlignItems) {
    styles.justifyContent = mapAlignment(node.primaryAxisAlignItems);
  }
  if (node.counterAxisAlignItems) {
    styles.alignItems = mapAlignment(node.counterAxisAlignItems);
  }

  // Gap
  const gapBinding = getBoundVar(bound, "itemSpacing");
  const gapResolved = resolver.resolveNumber(node.itemSpacing, gapBinding);
  if (gapResolved) {
    setResolved("gap", gapResolved);
  }

  // Cross-axis gap (for wrapped layouts)
  if (node.counterAxisSpacing !== undefined) {
    const crossGapBinding = getBoundVar(bound, "counterAxisSpacing");
    const crossGapResolved = resolver.resolveNumber(
      node.counterAxisSpacing,
      crossGapBinding
    );
    if (crossGapResolved) {
      const prop = node.layoutMode === "HORIZONTAL" ? "rowGap" : "columnGap";
      setResolved(prop, crossGapResolved);
    }
  }

  // Padding
  extractPadding(node, resolver, bound, styles, setResolved);

  // Sizing
  extractSizing(node, styles);
}

function extractPadding(
  node: FigmaDetailedNode,
  resolver: VariableResolver,
  bound: Record<string, FigmaVariableAlias | FigmaVariableAlias[]>,
  styles: ParsedStyles,
  setResolved: SetResolved
): void {
  const sides = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"] as const;
  const values: (ResolvedValue | null)[] = sides.map((side) => {
    const binding = getBoundVar(bound, side);
    const raw = node[side];
    return resolver.resolveNumber(raw, binding);
  });

  // Store individual resolved values for RN emitter
  sides.forEach((side, i) => {
    if (values[i]) setResolved(side, values[i]!);
  });

  // Check if all four values exist
  if (values.every((v) => v !== null)) {
    const cssValues = values.map((v) => v!.css);
    // Try shorthand
    if (cssValues[0] === cssValues[2] && cssValues[1] === cssValues[3]) {
      if (cssValues[0] === cssValues[1]) {
        styles.padding = cssValues[0];
      } else {
        styles.padding = `${cssValues[0]} ${cssValues[1]}`;
      }
    } else {
      styles.padding = cssValues.join(" ");
    }
  } else {
    // Individual sides
    sides.forEach((side, i) => {
      if (values[i]) {
        styles[side] = values[i]!.css;
      }
    });
  }
}

function extractSizing(
  node: FigmaDetailedNode,
  styles: ParsedStyles
): void {
  // Horizontal
  if (node.layoutSizingHorizontal === "FILL") {
    styles.flex = "1";
  } else if (node.layoutSizingHorizontal === "FIXED" && node.absoluteBoundingBox) {
    styles.width = `${node.absoluteBoundingBox.width}px`;
  }
  // HUG = auto (default, no style needed)

  // Vertical
  if (node.layoutSizingVertical === "FILL") {
    // If horizontal is also FILL, use flex: 1 (already set).
    // Otherwise set height
    if (node.layoutSizingHorizontal !== "FILL") {
      styles.height = "100%";
    }
  } else if (node.layoutSizingVertical === "FIXED" && node.absoluteBoundingBox) {
    styles.height = `${node.absoluteBoundingBox.height}px`;
  }

  // Min/max constraints
  if (node.minWidth !== undefined) styles.minWidth = `${node.minWidth}px`;
  if (node.maxWidth !== undefined) styles.maxWidth = `${node.maxWidth}px`;
  if (node.minHeight !== undefined) styles.minHeight = `${node.minHeight}px`;
  if (node.maxHeight !== undefined) styles.maxHeight = `${node.maxHeight}px`;
}

// ─── Fills ───

function extractFills(
  node: FigmaDetailedNode,
  resolver: VariableResolver,
  bound: Record<string, FigmaVariableAlias | FigmaVariableAlias[]>,
  styles: ParsedStyles,
  setResolved: SetResolved
): void {
  if (!node.fills || node.fills.length === 0) return;

  // Get the first visible fill
  const fill = node.fills.find((f) => f.visible !== false);
  if (!fill) return;

  // Check for color binding on fills
  const fillBindings = bound["fills"];
  let colorBinding: FigmaVariableAlias | undefined;
  if (fillBindings) {
    if (Array.isArray(fillBindings) && fillBindings.length > 0) {
      colorBinding = fillBindings[0];
    } else if (!Array.isArray(fillBindings)) {
      colorBinding = fillBindings;
    }
  }

  const resolved = resolver.resolveFill(fill, colorBinding);
  if (resolved) {
    // Text nodes use "color", everything else uses "background"
    const prop = node.type === TEXT_TYPE ? "color" : "background";
    setResolved(prop, resolved);
  }
}

// ─── Strokes (Borders) ───

function extractStrokes(
  node: FigmaDetailedNode,
  resolver: VariableResolver,
  bound: Record<string, FigmaVariableAlias | FigmaVariableAlias[]>,
  styles: ParsedStyles,
  _setResolved: SetResolved
): void {
  if (!node.strokes || node.strokes.length === 0 || !node.strokeWeight) return;

  const stroke = node.strokes.find((s) => s.visible !== false);
  if (!stroke || !stroke.color) return;

  const strokeBinding = getBoundVar(bound, "strokes");
  const colorResolved = strokeBinding
    ? resolver.resolveBinding(strokeBinding)
    : resolver.resolveColor(stroke.color);

  const weight = node.strokeWeight;

  if (node.individualStrokeWeights) {
    const { top, right, bottom, left } = node.individualStrokeWeights;
    if (top > 0) styles.borderTop = `${top}px solid ${colorResolved.css}`;
    if (right > 0) styles.borderRight = `${right}px solid ${colorResolved.css}`;
    if (bottom > 0) styles.borderBottom = `${bottom}px solid ${colorResolved.css}`;
    if (left > 0) styles.borderLeft = `${left}px solid ${colorResolved.css}`;
  } else if (node.strokeAlign === "INSIDE") {
    // Inside strokes use box-shadow to avoid affecting layout
    styles.boxShadow = `inset 0 0 0 ${weight}px ${colorResolved.css}`;
  } else {
    styles.border = `${weight}px solid ${colorResolved.css}`;
  }
}

// ─── Effects ───

function extractEffects(
  node: FigmaDetailedNode,
  styles: ParsedStyles
): void {
  if (!node.effects || node.effects.length === 0) return;

  const shadows: string[] = [];
  const filters: string[] = [];
  const backdropFilters: string[] = [];

  for (const effect of node.effects) {
    if (effect.visible === false) continue;

    switch (effect.type) {
      case "DROP_SHADOW":
      case "INNER_SHADOW": {
        const x = effect.offset?.x ?? 0;
        const y = effect.offset?.y ?? 0;
        const blur = effect.radius;
        const spread = effect.spread ?? 0;
        const color = effect.color ? figmaColorToHex(effect.color) : "rgba(0,0,0,0.25)";
        const inset = effect.type === "INNER_SHADOW" ? "inset " : "";
        shadows.push(`${inset}${x}px ${y}px ${blur}px ${spread}px ${color}`);
        break;
      }
      case "LAYER_BLUR":
        filters.push(`blur(${effect.radius}px)`);
        break;
      case "BACKGROUND_BLUR":
        backdropFilters.push(`blur(${effect.radius}px)`);
        break;
    }
  }

  if (shadows.length > 0) {
    // Merge with existing box-shadow from inside strokes
    const existing = styles.boxShadow ? `${styles.boxShadow}, ` : "";
    styles.boxShadow = existing + shadows.join(", ");
  }
  if (filters.length > 0) styles.filter = filters.join(" ");
  if (backdropFilters.length > 0) styles.backdropFilter = backdropFilters.join(" ");
}

// ─── Corner Radius ───

function extractCornerRadius(
  node: FigmaDetailedNode,
  resolver: VariableResolver,
  bound: Record<string, FigmaVariableAlias | FigmaVariableAlias[]>,
  styles: ParsedStyles,
  setResolved: SetResolved
): void {
  if (node.rectangleCornerRadii) {
    const [tl, tr, br, bl] = node.rectangleCornerRadii;
    // Check for individual corner bindings
    const tlBinding = getBoundVar(bound, "topLeftRadius");
    const trBinding = getBoundVar(bound, "topRightRadius");
    const brBinding = getBoundVar(bound, "bottomRightRadius");
    const blBinding = getBoundVar(bound, "bottomLeftRadius");

    const tlR = resolver.resolveNumber(tl, tlBinding) ?? { css: `${tl}px` };
    const trR = resolver.resolveNumber(tr, trBinding) ?? { css: `${tr}px` };
    const brR = resolver.resolveNumber(br, brBinding) ?? { css: `${br}px` };
    const blR = resolver.resolveNumber(bl, blBinding) ?? { css: `${bl}px` };

    styles.borderRadius = `${tlR.css} ${trR.css} ${brR.css} ${blR.css}`;
  } else if (node.cornerRadius !== undefined && node.cornerRadius > 0) {
    const binding = getBoundVar(bound, "topLeftRadius"); // Figma uses topLeftRadius for uniform
    const resolved = resolver.resolveNumber(node.cornerRadius, binding);
    if (resolved) {
      styles.borderRadius = resolved.css;
    }
  }
}

// ─── Text Nodes ───

function parseTextNode(
  node: FigmaDetailedNode,
  resolver: VariableResolver
): ParsedNode {
  const styles: ParsedStyles = {};
  const resolvedValues = new Map<string, ResolvedValue>();
  const bound = node.boundVariables ?? {};
  const setResolved: SetResolved = (prop, rv) => {
    styles[prop] = rv.css;
    resolvedValues.set(prop, rv);
  };

  // Typography
  if (node.style) {
    const ts = node.style;

    if (ts.fontFamily) {
      styles.fontFamily = `'${ts.fontFamily}', sans-serif`;
    }

    const fontSizeBinding = getBoundVar(bound, "fontSize");
    if (fontSizeBinding) {
      styles.fontSize = resolver.resolveBinding(fontSizeBinding).css;
    } else if (ts.fontSize) {
      styles.fontSize = `${ts.fontSize}px`;
    }

    if (ts.fontWeight) {
      styles.fontWeight = String(ts.fontWeight);
    }

    if (ts.lineHeightPx) {
      const lhBinding = getBoundVar(bound, "lineHeight");
      if (lhBinding) {
        styles.lineHeight = resolver.resolveBinding(lhBinding).css;
      } else {
        // Use unitless ratio when possible
        const ratio = ts.fontSize ? ts.lineHeightPx / ts.fontSize : undefined;
        styles.lineHeight = ratio ? String(Math.round(ratio * 100) / 100) : `${ts.lineHeightPx}px`;
      }
    }

    if (ts.letterSpacing) {
      const lsBinding = getBoundVar(bound, "letterSpacing");
      if (lsBinding) {
        styles.letterSpacing = resolver.resolveBinding(lsBinding).css;
      } else {
        styles.letterSpacing = `${ts.letterSpacing}px`;
      }
    }

    if (ts.textAlignHorizontal) {
      const alignMap: Record<string, string> = {
        LEFT: "left", CENTER: "center", RIGHT: "right", JUSTIFIED: "justify",
      };
      styles.textAlign = alignMap[ts.textAlignHorizontal] ?? "left";
    }

    if (ts.textCase && ts.textCase !== "ORIGINAL") {
      const caseMap: Record<string, string> = {
        UPPER: "uppercase", LOWER: "lowercase", TITLE: "capitalize",
      };
      styles.textTransform = caseMap[ts.textCase];
    }

    if (ts.textDecoration && ts.textDecoration !== "NONE") {
      const decoMap: Record<string, string> = {
        UNDERLINE: "underline", STRIKETHROUGH: "line-through",
      };
      styles.textDecoration = decoMap[ts.textDecoration];
    }
  }

  // Text color from fills
  extractFills(node, resolver, bound, styles, setResolved);

  // Store resolved values for bound typography properties
  const fontSizeBinding = getBoundVar(bound, "fontSize");
  if (fontSizeBinding) {
    resolvedValues.set("fontSize", resolver.resolveBinding(fontSizeBinding));
  }
  const lhBinding = getBoundVar(bound, "lineHeight");
  if (lhBinding) {
    resolvedValues.set("lineHeight", resolver.resolveBinding(lhBinding));
  }
  const lsBinding = getBoundVar(bound, "letterSpacing");
  if (lsBinding) {
    resolvedValues.set("letterSpacing", resolver.resolveBinding(lsBinding));
  }

  // Determine tag
  const isMultiline = (node.characters ?? "").includes("\n");
  const tag = isMultiline ? "p" : "span";

  return {
    tag,
    className: sanitizeClassName(node.name),
    styles,
    resolvedValues,
    children: [],
    textContent: node.characters ?? "",
    isTextProp: true,
  };
}

// ─── Helpers ───

function mapAlignment(value: string): string {
  const map: Record<string, string> = {
    MIN: "flex-start",
    CENTER: "center",
    MAX: "flex-end",
    SPACE_BETWEEN: "space-between",
    BASELINE: "baseline",
  };
  return map[value] ?? "flex-start";
}

function inferTag(node: FigmaDetailedNode): "div" | "span" | "p" | "img" | "button" | "input" {
  // All frame-like nodes become divs
  return "div";
}

/**
 * Sanitize a Figma node name into a valid CSS class name.
 */
export function sanitizeClassName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

/**
 * Get a single bound variable from the boundVariables record.
 * Handles both single alias and array-of-aliases shapes.
 */
function getBoundVar(
  bound: Record<string, FigmaVariableAlias | FigmaVariableAlias[]>,
  key: string
): FigmaVariableAlias | undefined {
  const entry = bound[key];
  if (!entry) return undefined;
  if (Array.isArray(entry)) return entry[0];
  return entry;
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Zero errors

- [ ] **Step 3: Commit**

```bash
git add src/utils/node-parser.ts
git commit -m "feat: add node parser for Figma-to-CSS property extraction"
```

---

## Chunk 3: Variant System — State Differ & Composition Resolver

### Task 5: Create state differ

**Files:**
- Create: `src/utils/state-differ.ts`

Diffs variant node trees against the default variant. Separates state props (→ CSS pseudo-classes) from dimensional props (→ component prop-driven classes).

- [ ] **Step 1: Write the state differ**

Create `src/utils/state-differ.ts`:

```typescript
/**
 * Diffs Figma component variant node trees against the default variant.
 * Produces state overrides (CSS pseudo-classes) and dimensional variants (prop-driven classes).
 */

import type { FigmaDetailedNode } from "../types/figma.js";
import type {
  ParsedNode,
  ParsedStyles,
  StateOverride,
  DimensionalVariant,
  VariantEntry,
  ComponentPropIR,
} from "../types/node-ir.js";
import { parseNodeTree } from "./node-parser.js";
import { sanitizeClassName } from "./node-parser.js";
import { VariableResolver } from "./variable-resolver.js";

// ─── State name → CSS selector mapping ───

const STATE_SELECTOR_MAP: Record<string, string> = {
  hover: ":hover:not(:disabled)",
  hovered: ":hover:not(:disabled)",
  pressed: ":active:not(:disabled)",
  active: ":active:not(:disabled)",
  focus: ":focus-visible",
  focused: ":focus-visible",
  disabled: ":disabled, [aria-disabled=\"true\"]",
  selected: "[aria-selected=\"true\"]",
  checked: ":checked, [aria-checked=\"true\"]",
  error: "[aria-invalid=\"true\"]",
  invalid: "[aria-invalid=\"true\"]",
};

function getStateSelector(stateName: string): string {
  const key = stateName.toLowerCase();
  return STATE_SELECTOR_MAP[key] ?? `[data-state="${key}"]`;
}

// ─── Public API ───

export interface DiffResult {
  stateOverrides: StateOverride[];
  dimensionalVariants: DimensionalVariant[];
}

/**
 * Diff all variants of a component against the default variant.
 *
 * @param variants - All variant entries with parsed prop values
 * @param variantNodes - Map of variantNodeId → FigmaDetailedNode
 * @param resolver - Variable resolver for token lookups
 * @param statePropNames - Prop names that should map to CSS pseudo-classes
 * @param componentClassName - The root class name for BEM modifiers
 */
export function diffVariants(
  variants: VariantEntry[],
  variantNodes: Record<string, FigmaDetailedNode>,
  resolver: VariableResolver,
  statePropNames: string[],
  componentClassName: string
): DiffResult {
  const stateOverrides: StateOverride[] = [];
  const dimensionalVariants: DimensionalVariant[] = [];

  // Identify the default variant (all props at first value)
  const defaultVariant = findDefaultVariant(variants, statePropNames);
  if (!defaultVariant) return { stateOverrides, dimensionalVariants };

  const defaultNode = variantNodes[defaultVariant.nodeId];
  if (!defaultNode) return { stateOverrides, dimensionalVariants };

  const defaultTree = parseNodeTree(defaultNode, resolver);

  // Collect unique state values and dimensional values
  const stateNamesLower = new Set(statePropNames.map((n) => n.toLowerCase()));

  for (const variant of variants) {
    if (variant.nodeId === defaultVariant.nodeId) continue;

    const variantNode = variantNodes[variant.nodeId];
    if (!variantNode) continue;

    const variantTree = parseNodeTree(variantNode, resolver);

    // Determine what changed between this variant and the default
    const changedProps: Record<string, string> = {};
    for (const [key, val] of Object.entries(variant.propValues)) {
      if (defaultVariant.propValues[key] !== val) {
        changedProps[key] = val;
      }
    }

    // Categorize: state change or dimensional change?
    const stateChanges: Record<string, string> = {};
    const dimChanges: Record<string, string> = {};
    for (const [key, val] of Object.entries(changedProps)) {
      if (stateNamesLower.has(key.toLowerCase())) {
        stateChanges[key] = val;
      } else {
        dimChanges[key] = val;
      }
    }

    // Compute style diff
    const { overrides, resolvedOverrides } = diffTrees(defaultTree, variantTree);
    if (Object.keys(overrides).length === 0) continue;

    // If only state props changed → state override
    if (Object.keys(stateChanges).length > 0 && Object.keys(dimChanges).length === 0) {
      const stateName = Object.values(stateChanges)[0];
      stateOverrides.push({
        stateName,
        selector: getStateSelector(stateName),
        overrides,
        resolvedOverrides,
      });
    }

    // If only dimensional props changed → dimensional variant
    if (Object.keys(dimChanges).length > 0 && Object.keys(stateChanges).length === 0) {
      const propName = Object.keys(dimChanges)[0];
      const propValue = dimChanges[propName];
      dimensionalVariants.push({
        propName,
        propValue,
        modifierClass: `${componentClassName}--${sanitizeClassName(propValue)}`,
        overrides,
        resolvedOverrides,
      });
    }

    // Mixed changes (both state + dimensional) → scoped dimensional state override
    if (Object.keys(stateChanges).length > 0 && Object.keys(dimChanges).length > 0) {
      // For v1, treat as a dimensional variant with the state selector appended
      const stateName = Object.values(stateChanges)[0];
      const dimPropName = Object.keys(dimChanges)[0];
      const dimPropValue = dimChanges[dimPropName];
      stateOverrides.push({
        stateName: `${dimPropValue}-${stateName}`,
        selector: `.${componentClassName}--${sanitizeClassName(dimPropValue)}${getStateSelector(stateName)}`,
        overrides,
        resolvedOverrides,
      });
    }
  }

  return { stateOverrides, dimensionalVariants };
}

/**
 * Build ComponentPropIR array from variant entries.
 */
export function extractPropsFromVariants(
  variants: VariantEntry[],
  statePropNames: string[]
): ComponentPropIR[] {
  const propMap = new Map<string, Set<string>>();
  const stateNamesLower = new Set(statePropNames.map((n) => n.toLowerCase()));

  for (const variant of variants) {
    for (const [key, value] of Object.entries(variant.propValues)) {
      if (!propMap.has(key)) propMap.set(key, new Set());
      propMap.get(key)!.add(value);
    }
  }

  const props: ComponentPropIR[] = [];
  for (const [name, values] of propMap) {
    // Skip state props — they become CSS pseudo-classes, not component props
    if (stateNamesLower.has(name.toLowerCase())) continue;

    const sortedValues = Array.from(values);
    const isBool = sortedValues.length === 2 &&
      sortedValues.some((v) => v.toLowerCase() === "true") &&
      sortedValues.some((v) => v.toLowerCase() === "false");

    props.push({
      name: name.charAt(0).toLowerCase() + name.slice(1), // camelCase prop name
      type: isBool ? "boolean" : "enum",
      values: isBool ? undefined : sortedValues,
      defaultValue: sortedValues[0],
      source: "variant",
    });
  }

  return props;
}

// ─── Diffing ───

/**
 * Diff two ParsedNode trees and return only changed styles per className.
 * Walks both trees in parallel, matched by className.
 */
interface DiffTreeResult {
  overrides: Record<string, Partial<ParsedStyles>>;
  resolvedOverrides: Record<string, Map<string, ResolvedValue>>;
}

function diffTrees(
  defaultTree: ParsedNode,
  variantTree: ParsedNode
): DiffTreeResult {
  const overrides: Record<string, Partial<ParsedStyles>> = {};
  const resolvedOverrides: Record<string, Map<string, ResolvedValue>> = {};
  diffNodesRecursive(defaultTree, variantTree, overrides, resolvedOverrides);
  return { overrides, resolvedOverrides };
}

function diffNodesRecursive(
  defaultNode: ParsedNode,
  variantNode: ParsedNode,
  result: Record<string, Partial<ParsedStyles>>,
  resolvedResult: Record<string, Map<string, ResolvedValue>>
): void {
  // Diff styles of this node
  const changedStyles = diffStyles(defaultNode.styles, variantNode.styles);
  if (Object.keys(changedStyles).length > 0) {
    result[defaultNode.className] = changedStyles;
    // Collect resolved values for the changed properties from the variant node
    const changedResolved = new Map<string, ResolvedValue>();
    for (const prop of Object.keys(changedStyles)) {
      const rv = variantNode.resolvedValues.get(prop);
      if (rv) changedResolved.set(prop, rv);
    }
    if (changedResolved.size > 0) {
      resolvedResult[defaultNode.className] = changedResolved;
    }
  }

  // Match children by className for parallel traversal
  const defaultChildMap = new Map<string, ParsedNode>();
  for (const child of defaultNode.children) {
    defaultChildMap.set(child.className, child);
  }

  for (const variantChild of variantNode.children) {
    const defaultChild = defaultChildMap.get(variantChild.className);
    if (defaultChild) {
      diffNodesRecursive(defaultChild, variantChild, result, resolvedResult);
    }
    // If no matching child, skip (structural difference — v1 doesn't support)
  }
}

function diffStyles(
  defaultStyles: ParsedStyles,
  variantStyles: ParsedStyles
): Partial<ParsedStyles> {
  const changed: Partial<ParsedStyles> = {};

  // Check all keys in both styles
  const allKeys = new Set([
    ...Object.keys(defaultStyles),
    ...Object.keys(variantStyles),
  ]);

  for (const key of allKeys) {
    const dv = defaultStyles[key];
    const vv = variantStyles[key];
    if (dv !== vv && vv !== undefined) {
      changed[key] = vv;
    }
  }

  return changed;
}

// ─── Helpers ───

/**
 * Find the default variant — where all props are at their first listed value.
 */
function findDefaultVariant(
  variants: VariantEntry[],
  statePropNames: string[]
): VariantEntry | undefined {
  if (variants.length === 0) return undefined;
  if (variants.length === 1) return variants[0];

  // Collect first value for each prop
  const firstValues = new Map<string, string>();
  for (const variant of variants) {
    for (const [key, value] of Object.entries(variant.propValues)) {
      if (!firstValues.has(key)) {
        firstValues.set(key, value);
      }
    }
  }

  // Try to find a variant with "Default" for state props first
  const stateNamesLower = new Set(statePropNames.map((n) => n.toLowerCase()));
  const preferDefault = new Map(firstValues);
  for (const [key] of preferDefault) {
    if (stateNamesLower.has(key.toLowerCase())) {
      preferDefault.set(key, "Default");
    }
  }

  const preferred = variants.find((v) =>
    [...preferDefault].every(([key, val]) => v.propValues[key] === val)
  );
  if (preferred) return preferred;

  // Fallback: first values for everything
  return variants.find((v) =>
    [...firstValues].every(([key, val]) => v.propValues[key] === val)
  ) ?? variants[0];
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Zero errors

- [ ] **Step 3: Commit**

```bash
git add src/utils/state-differ.ts
git commit -m "feat: add state differ for variant diffing and CSS pseudo-class mapping"
```

---

### Task 6: Create composition resolver

**Files:**
- Create: `src/utils/composition-resolver.ts`

Detects nested component instances, builds a dependency graph, and determines generation order via topological sort.

- [ ] **Step 1: Write the composition resolver**

Create `src/utils/composition-resolver.ts`:

```typescript
/**
 * Detects nested component instances in Figma node trees,
 * builds a dependency graph, and determines generation order.
 */

import type { FigmaDetailedNode } from "../types/figma.js";
import type { ParsedNode, ComponentReference } from "../types/node-ir.js";
import { toPascalCase } from "./scaffold-templates.js";

// ─── Types ───

/** Map of component set nodeId → PascalCase component name */
export type ComponentNameMap = Map<string, string>;

// ─── Public API ───

/**
 * Build a map of component set nodeId → PascalCase name.
 * Used to resolve INSTANCE nodes to component references.
 */
export function buildComponentNameMap(
  components: Array<{ nodeId?: string; name: string }>
): ComponentNameMap {
  const map = new Map<string, string>();
  for (const comp of components) {
    if (comp.nodeId) {
      map.set(comp.nodeId, toPascalCase(comp.name));
    }
  }
  return map;
}

/**
 * Walk a ParsedNode tree and resolve componentRef entries.
 * Fills in componentName from the nameMap and extracts text overrides as props.
 *
 * @param tree - The parsed node tree (mutated in place)
 * @param nameMap - nodeId → PascalCase name
 * @param variantNode - Original Figma node tree (for extracting instance overrides)
 */
export function resolveComponentRefs(
  tree: ParsedNode,
  nameMap: ComponentNameMap,
  variantNode?: FigmaDetailedNode
): void {
  walkAndResolve(tree, nameMap);
}

function walkAndResolve(node: ParsedNode, nameMap: ComponentNameMap): void {
  if (node.componentRef) {
    const name = nameMap.get(node.componentRef.sourceNodeId);
    if (name) {
      node.componentRef.componentName = name;
    }
  }

  for (const child of node.children) {
    walkAndResolve(child, nameMap);
  }
}

/**
 * Extract all component dependencies from a ParsedNode tree.
 * Returns a set of PascalCase component names that this tree references.
 */
export function extractDependencies(tree: ParsedNode): string[] {
  const deps = new Set<string>();
  collectDeps(tree, deps);
  return Array.from(deps);
}

function collectDeps(node: ParsedNode, deps: Set<string>): void {
  if (node.componentRef?.componentName) {
    deps.add(node.componentRef.componentName);
  }
  for (const child of node.children) {
    collectDeps(child, deps);
  }
}

/**
 * Topological sort of components by their dependencies.
 * Components with no dependencies come first.
 * If circular dependencies are detected, breaks the cycle and emits a warning.
 *
 * @returns Sorted component names (generation order) + any warnings
 */
export function topologicalSort(
  components: Array<{ name: string; dependencies: string[] }>
): { sorted: string[]; warnings: string[] } {
  const warnings: string[] = [];
  const graph = new Map<string, Set<string>>();
  const allNames = new Set<string>();

  for (const comp of components) {
    allNames.add(comp.name);
    graph.set(comp.name, new Set(comp.dependencies.filter((d) => allNames.has(d) || components.some((c) => c.name === d))));
  }

  const sorted: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>(); // For cycle detection

  function visit(name: string): void {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      warnings.push(`Circular dependency detected involving "${name}" — breaking cycle`);
      return;
    }

    visiting.add(name);
    const deps = graph.get(name) ?? new Set();
    for (const dep of deps) {
      visit(dep);
    }
    visiting.delete(name);
    visited.add(name);
    sorted.push(name);
  }

  for (const comp of components) {
    visit(comp.name);
  }

  return { sorted, warnings };
}

/**
 * Extract text content props from a ParsedNode tree.
 * Any text node with isTextProp=true becomes a string prop.
 */
export function extractTextProps(
  tree: ParsedNode,
  componentName: string
): Array<{ name: string; defaultValue: string }> {
  const props: Array<{ name: string; defaultValue: string }> = [];
  const seenNames = new Set<string>();
  collectTextProps(tree, props, seenNames, componentName);
  return props;
}

function collectTextProps(
  node: ParsedNode,
  props: Array<{ name: string; defaultValue: string }>,
  seen: Set<string>,
  componentName: string
): void {
  if (node.isTextProp && node.textContent) {
    // Generate a prop name from the node's className
    let propName = node.className
      .split("-")
      .map((s, i) => (i === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1)))
      .join("");

    // Avoid duplicates
    if (seen.has(propName)) {
      propName = `${propName}${seen.size}`;
    }
    seen.add(propName);

    props.push({ name: propName, defaultValue: node.textContent });
  }

  // Don't recurse into component refs — their text is their own
  if (!node.componentRef) {
    for (const child of node.children) {
      collectTextProps(child, props, seen, componentName);
    }
  }
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Zero errors

- [ ] **Step 3: Commit**

```bash
git add src/utils/composition-resolver.ts
git commit -m "feat: add composition resolver for nested component detection and topological sort"
```

---

## Chunk 4: Emitters Part 1 — React + CSS Modules & HTML + CSS

### Task 7: Create React + CSS Modules emitter

**Files:**
- Create: `src/utils/emitter-react-css.ts`

Emits a `.tsx` component file and a `.module.css` file.

- [ ] **Step 1: Write the emitter**

Create `src/utils/emitter-react-css.ts`:

```typescript
/**
 * Code emitter: React + CSS Modules.
 * Produces two files per component: {Name}.tsx + {Name}.module.css
 */

import type {
  ComponentIR,
  ParsedNode,
  ParsedStyles,
  StateOverride,
  DimensionalVariant,
  EmittedComponent,
} from "../types/node-ir.js";

export function emitReactCSS(ir: ComponentIR, outputDir: string): EmittedComponent {
  const cssContent = generateCSS(ir);
  const tsxContent = generateTSX(ir);

  return {
    componentName: ir.name,
    figmaName: ir.figmaName,
    figmaUrl: ir.figmaUrl,
    files: [
      {
        path: `${outputDir}/${ir.name}/${ir.name}.tsx`,
        content: tsxContent,
        description: `React component with CSS Modules`,
      },
      {
        path: `${outputDir}/${ir.name}/${ir.name}.module.css`,
        content: cssContent,
        description: `CSS Modules styles`,
      },
    ],
    props: ir.props,
    dependencies: ir.dependencies,
    warnings: ir.warnings,
  };
}

// ─── CSS Generation ───

function generateCSS(ir: ComponentIR): string {
  const lines: string[] = [];
  lines.push(`/* Generated from Figma: ${ir.figmaName} */`);
  lines.push(`/* ${ir.figmaUrl} */\n`);

  // Base styles from default tree
  emitNodeCSS(ir.defaultTree, lines, "");

  // State overrides
  for (const state of ir.stateOverrides) {
    lines.push("");
    for (const [className, overrideStyles] of Object.entries(state.overrides)) {
      const selector = className === ir.defaultTree.className
        ? `.${className}${state.selector}`
        : `.${ir.defaultTree.className}${state.selector} .${className}`;
      lines.push(`${selector} {`);
      emitStyleBlock(overrideStyles, lines);
      lines.push("}");
    }
  }

  // Dimensional variants
  for (const variant of ir.dimensionalVariants) {
    lines.push("");
    lines.push(`/* ${variant.propName}=${variant.propValue} */`);
    for (const [className, overrideStyles] of Object.entries(variant.overrides)) {
      const selector = className === ir.defaultTree.className
        ? `.${variant.modifierClass}`
        : `.${variant.modifierClass} .${className}`;
      lines.push(`${selector} {`);
      emitStyleBlock(overrideStyles, lines);
      lines.push("}");
    }
  }

  lines.push("");
  return lines.join("\n");
}

function emitNodeCSS(node: ParsedNode, lines: string[], indent: string): void {
  if (node.componentRef) return; // Skip — rendered as component import

  const styleEntries = Object.entries(node.styles).filter(([, v]) => v !== undefined);
  if (styleEntries.length > 0) {
    lines.push(`${indent}.${node.className} {`);
    emitStyleBlock(node.styles, lines, indent);
    lines.push(`${indent}}`);
  }

  for (const child of node.children) {
    emitNodeCSS(child, lines, indent);
  }
}

function emitStyleBlock(
  styles: Partial<ParsedStyles>,
  lines: string[],
  indent: string = ""
): void {
  for (const [prop, value] of Object.entries(styles)) {
    if (value === undefined) continue;
    lines.push(`${indent}  ${camelToKebab(prop)}: ${value};`);
  }
}

// ─── TSX Generation ───

function generateTSX(ir: ComponentIR): string {
  const lines: string[] = [];

  // Imports
  lines.push(`import React from "react";`);
  lines.push(`import styles from "./${ir.name}.module.css";`);

  // Component dependency imports
  for (const dep of ir.dependencies) {
    lines.push(`import { ${dep} } from "../${dep}/${dep}";`);
  }

  lines.push("");

  // Props interface
  lines.push(`export interface ${ir.name}Props {`);
  for (const prop of ir.props) {
    if (prop.type === "boolean") {
      lines.push(`  ${prop.name}?: boolean;`);
    } else if (prop.type === "enum" && prop.values) {
      const union = prop.values.map((v) => `"${v.toLowerCase()}"`).join(" | ");
      lines.push(`  ${prop.name}?: ${union};`);
    } else {
      lines.push(`  ${prop.name}?: string;`);
    }
  }
  // Add text content props
  const textProps = ir.props.filter((p) => p.source === "text-content");
  lines.push(`  children?: React.ReactNode;`);
  lines.push(`}`);
  lines.push("");

  // Component
  const propsDestructure = ir.props
    .map((p) => {
      if (p.defaultValue) {
        const dv = p.type === "boolean" ? p.defaultValue : `"${p.defaultValue.toLowerCase()}"`;
        return `${p.name} = ${dv}`;
      }
      return p.name;
    })
    .concat(["children"])
    .join(", ");

  lines.push(`/** ${ir.description || ir.figmaName} */`);
  lines.push(`export const ${ir.name}: React.FC<${ir.name}Props> = ({ ${propsDestructure} }) => {`);

  // Build className expression
  const dimProps = ir.props.filter((p) => p.source === "variant" && p.type === "enum");
  if (dimProps.length > 0) {
    const parts = [`styles["${ir.defaultTree.className}"]`];
    for (const dim of dimProps) {
      parts.push(`styles[${dim.name}]`);
    }
    lines.push(`  const className = [${parts.join(", ")}].filter(Boolean).join(" ");`);
  }

  // Render tree
  lines.push(`  return (`);
  const classExpr = dimProps.length > 0 ? "className" : `styles["${ir.defaultTree.className}"]`;
  emitJSXNode(ir.defaultTree, lines, "    ", classExpr, true, ir);
  lines.push(`  );`);
  lines.push(`};`);
  lines.push("");

  return lines.join("\n");
}

function emitJSXNode(
  node: ParsedNode,
  lines: string[],
  indent: string,
  classExpr: string | null,
  isRoot: boolean,
  ir: ComponentIR
): void {
  // Component reference
  if (node.componentRef?.componentName) {
    const propsStr = Object.entries(node.componentRef.props)
      .map(([k, v]) => `${k}="${v}"`)
      .join(" ");
    lines.push(`${indent}<${node.componentRef.componentName}${propsStr ? " " + propsStr : ""} />`);
    return;
  }

  const Tag = node.tag;
  const classAttr = isRoot && classExpr
    ? ` className={${classExpr}}`
    : ` className={styles["${node.className}"]}`;

  // Text content node
  if (node.textContent !== undefined && node.children.length === 0) {
    if (node.isTextProp) {
      // Find the matching text prop
      const textProp = ir.props.find(
        (p) => p.source === "text-content" && p.defaultValue === node.textContent
      );
      const content = textProp ? `{${textProp.name}}` : node.textContent;
      lines.push(`${indent}<${Tag}${classAttr}>${content}</${Tag}>`);
    } else {
      lines.push(`${indent}<${Tag}${classAttr}>${node.textContent}</${Tag}>`);
    }
    return;
  }

  // Container node
  if (node.children.length === 0) {
    lines.push(`${indent}<${Tag}${classAttr} />`);
    return;
  }

  lines.push(`${indent}<${Tag}${classAttr}>`);
  for (const child of node.children) {
    emitJSXNode(child, lines, indent + "  ", null, false, ir);
  }
  lines.push(`${indent}</${Tag}>`);
}

// ─── Helpers ───

function camelToKebab(str: string): string {
  return str.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Zero errors

- [ ] **Step 3: Commit**

```bash
git add src/utils/emitter-react-css.ts
git commit -m "feat: add React + CSS Modules code emitter"
```

---

### Task 8: Create HTML + CSS emitter

**Files:**
- Create: `src/utils/emitter-html-css.ts`

Emits a `.css` file with BEM naming and a `.html` usage example.

- [ ] **Step 1: Write the emitter**

Create `src/utils/emitter-html-css.ts`:

```typescript
/**
 * Code emitter: HTML + CSS.
 * Produces a .css file with BEM naming and a .html usage example.
 */

import type {
  ComponentIR,
  ParsedNode,
  ParsedStyles,
  EmittedComponent,
} from "../types/node-ir.js";

export function emitHTMLCSS(ir: ComponentIR, outputDir: string): EmittedComponent {
  const rootClass = ir.defaultTree.className;
  const cssContent = generateCSS(ir, rootClass);
  const htmlContent = generateHTML(ir, rootClass);

  return {
    componentName: ir.name,
    figmaName: ir.figmaName,
    figmaUrl: ir.figmaUrl,
    files: [
      {
        path: `${outputDir}/${ir.name}/${ir.name.toLowerCase()}.css`,
        content: cssContent,
        description: `CSS styles with BEM naming`,
      },
      {
        path: `${outputDir}/${ir.name}/${ir.name.toLowerCase()}.html`,
        content: htmlContent,
        description: `HTML usage example`,
      },
    ],
    props: ir.props,
    dependencies: ir.dependencies,
    warnings: ir.warnings,
  };
}

// ─── CSS ───

function generateCSS(ir: ComponentIR, rootClass: string): string {
  const lines: string[] = [];
  lines.push(`/* Generated from Figma: ${ir.figmaName} */`);
  lines.push(`/* ${ir.figmaUrl} */\n`);

  // Base styles
  emitNodeCSS(ir.defaultTree, lines, rootClass);

  // State overrides
  for (const state of ir.stateOverrides) {
    lines.push("");
    for (const [className, styles] of Object.entries(state.overrides)) {
      const selector = className === rootClass
        ? `.${rootClass}${state.selector}`
        : `.${rootClass}${state.selector} .${rootClass}__${className}`;
      lines.push(`${selector} {`);
      emitStyles(styles, lines);
      lines.push("}");
    }
  }

  // Dimensional variants
  for (const variant of ir.dimensionalVariants) {
    lines.push("");
    lines.push(`/* ${variant.propName}=${variant.propValue} */`);
    for (const [className, styles] of Object.entries(variant.overrides)) {
      const selector = className === rootClass
        ? `.${variant.modifierClass}`
        : `.${variant.modifierClass} .${rootClass}__${className}`;
      lines.push(`${selector} {`);
      emitStyles(styles, lines);
      lines.push("}");
    }
  }

  lines.push("");
  return lines.join("\n");
}

function emitNodeCSS(node: ParsedNode, lines: string[], rootClass: string): void {
  if (node.componentRef) return;

  const entries = Object.entries(node.styles).filter(([, v]) => v !== undefined);
  if (entries.length > 0) {
    const selector = node.className === rootClass
      ? `.${rootClass}`
      : `.${rootClass}__${node.className}`;
    lines.push(`${selector} {`);
    emitStyles(node.styles, lines);
    lines.push("}");
  }

  for (const child of node.children) {
    emitNodeCSS(child, lines, rootClass);
  }
}

function emitStyles(styles: Partial<ParsedStyles>, lines: string[]): void {
  for (const [prop, value] of Object.entries(styles)) {
    if (value === undefined) continue;
    lines.push(`  ${camelToKebab(prop)}: ${value};`);
  }
}

// ─── HTML ───

function generateHTML(ir: ComponentIR, rootClass: string): string {
  const lines: string[] = [];
  lines.push(`<!-- Generated from Figma: ${ir.figmaName} -->`);
  lines.push(`<!-- ${ir.figmaUrl} -->`);
  lines.push(`<!-- Usage example -->\n`);
  lines.push(`<link rel="stylesheet" href="${ir.name.toLowerCase()}.css" />\n`);

  emitHTMLNode(ir.defaultTree, lines, "", rootClass);

  // Show variant examples
  const dimProps = ir.props.filter((p) => p.source === "variant" && p.type === "enum");
  if (dimProps.length > 0) {
    lines.push(`\n<!-- Variant examples -->`);
    for (const dim of dimProps) {
      for (const val of dim.values ?? []) {
        if (val === dim.defaultValue) continue;
        lines.push(`<!-- ${dim.name}="${val}" -->`);
        lines.push(`<div class="${rootClass} ${rootClass}--${val.toLowerCase()}">`);
        lines.push(`  ...`);
        lines.push(`</div>`);
      }
    }
  }

  lines.push("");
  return lines.join("\n");
}

function emitHTMLNode(
  node: ParsedNode,
  lines: string[],
  indent: string,
  rootClass: string
): void {
  if (node.componentRef?.componentName) {
    lines.push(`${indent}<!-- ${node.componentRef.componentName} component -->`);
    return;
  }

  const cls = node.className === rootClass
    ? rootClass
    : `${rootClass}__${node.className}`;

  if (node.textContent !== undefined && node.children.length === 0) {
    lines.push(`${indent}<${node.tag} class="${cls}">${node.textContent}</${node.tag}>`);
    return;
  }

  if (node.children.length === 0) {
    lines.push(`${indent}<${node.tag} class="${cls}"></${node.tag}>`);
    return;
  }

  lines.push(`${indent}<${node.tag} class="${cls}">`);
  for (const child of node.children) {
    emitHTMLNode(child, lines, indent + "  ", rootClass);
  }
  lines.push(`${indent}</${node.tag}>`);
}

function camelToKebab(str: string): string {
  return str.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Zero errors

- [ ] **Step 3: Commit**

```bash
git add src/utils/emitter-html-css.ts
git commit -m "feat: add HTML + CSS code emitter with BEM naming"
```

---

## Chunk 5: Emitters Part 2 — React + Tailwind & React Native

### Task 9: Create React + Tailwind emitter

**Files:**
- Create: `src/utils/emitter-react-tailwind.ts`

Emits a single `.tsx` file per component using Tailwind utility classes with arbitrary value syntax for token references.

- [ ] **Step 1: Write the emitter**

Create `src/utils/emitter-react-tailwind.ts`:

```typescript
/**
 * Code emitter: React + Tailwind CSS.
 * Produces a single .tsx file using Tailwind utility classes.
 * Token references use arbitrary value syntax: bg-[var(--token)]
 */

import type {
  ComponentIR,
  ParsedNode,
  ParsedStyles,
  EmittedComponent,
} from "../types/node-ir.js";

export function emitReactTailwind(ir: ComponentIR, outputDir: string): EmittedComponent {
  const content = generateTSX(ir);

  return {
    componentName: ir.name,
    figmaName: ir.figmaName,
    figmaUrl: ir.figmaUrl,
    files: [
      {
        path: `${outputDir}/${ir.name}/${ir.name}.tsx`,
        content,
        description: `React component with Tailwind CSS`,
      },
    ],
    props: ir.props,
    dependencies: ir.dependencies,
    warnings: ir.warnings,
  };
}

// ─── Tailwind Class Mapping ───

/** Convert a ParsedStyles object to Tailwind utility classes */
function stylesToTailwind(styles: ParsedStyles): string[] {
  const classes: string[] = [];

  for (const [prop, value] of Object.entries(styles)) {
    if (value === undefined) continue;
    const tw = cssToTailwind(prop, value);
    if (tw) classes.push(tw);
  }

  return classes;
}

/** Map a single CSS property+value to a Tailwind class */
function cssToTailwind(prop: string, value: string): string | null {
  // Layout
  if (prop === "display" && value === "flex") return "flex";
  if (prop === "display" && value === "none") return "hidden";
  if (prop === "flexDirection" && value === "row") return "flex-row";
  if (prop === "flexDirection" && value === "column") return "flex-col";
  if (prop === "flexWrap" && value === "wrap") return "flex-wrap";
  if (prop === "flex" && value === "1") return "flex-1";
  if (prop === "overflow" && value === "hidden") return "overflow-hidden";

  // Alignment
  if (prop === "justifyContent") {
    const map: Record<string, string> = {
      "flex-start": "justify-start", "center": "justify-center",
      "flex-end": "justify-end", "space-between": "justify-between",
    };
    return map[value] ?? `justify-[${value}]`;
  }
  if (prop === "alignItems") {
    const map: Record<string, string> = {
      "flex-start": "items-start", "center": "items-center",
      "flex-end": "items-end", "baseline": "items-baseline",
    };
    return map[value] ?? `items-[${value}]`;
  }

  // Spacing (gap, padding)
  if (prop === "gap") return `gap-[${value}]`;
  if (prop === "rowGap") return `gap-y-[${value}]`;
  if (prop === "columnGap") return `gap-x-[${value}]`;
  if (prop === "padding") return `p-[${value}]`;
  if (prop === "paddingTop") return `pt-[${value}]`;
  if (prop === "paddingRight") return `pr-[${value}]`;
  if (prop === "paddingBottom") return `pb-[${value}]`;
  if (prop === "paddingLeft") return `pl-[${value}]`;

  // Sizing
  if (prop === "width") return `w-[${value}]`;
  if (prop === "height") return `h-[${value}]`;
  if (prop === "minWidth") return `min-w-[${value}]`;
  if (prop === "maxWidth") return `max-w-[${value}]`;
  if (prop === "minHeight") return `min-h-[${value}]`;
  if (prop === "maxHeight") return `max-h-[${value}]`;

  // Colors / Background
  if (prop === "background") return `bg-[${value}]`;
  if (prop === "color") return `text-[${value}]`;

  // Border
  if (prop === "border") return `border-[${value}]`;
  if (prop === "borderTop") return `border-t-[${value}]`;
  if (prop === "borderRight") return `border-r-[${value}]`;
  if (prop === "borderBottom") return `border-b-[${value}]`;
  if (prop === "borderLeft") return `border-l-[${value}]`;
  if (prop === "borderRadius") return `rounded-[${value}]`;

  // Effects
  if (prop === "boxShadow") return `shadow-[${value.replace(/\s+/g, "_")}]`;
  if (prop === "opacity") return `opacity-[${value}]`;
  if (prop === "filter") return `[filter:${value}]`;
  if (prop === "backdropFilter") return `[backdrop-filter:${value}]`;

  // Typography
  if (prop === "fontFamily") return `font-[${value}]`;
  if (prop === "fontSize") return `text-[${value}]`;
  if (prop === "fontWeight") return `font-[${value}]`;
  if (prop === "lineHeight") return `leading-[${value}]`;
  if (prop === "letterSpacing") return `tracking-[${value}]`;
  if (prop === "textAlign") {
    const map: Record<string, string> = {
      left: "text-left", center: "text-center", right: "text-right", justify: "text-justify",
    };
    return map[value] ?? `text-${value}`;
  }
  if (prop === "textTransform") {
    const map: Record<string, string> = {
      uppercase: "uppercase", lowercase: "lowercase", capitalize: "capitalize", none: "normal-case",
    };
    return map[value] ?? null;
  }
  if (prop === "textDecoration") {
    const map: Record<string, string> = {
      underline: "underline", "line-through": "line-through", none: "no-underline",
    };
    return map[value] ?? null;
  }

  // Cursor
  if (prop === "cursor") return `cursor-${value}`;

  // Fallback: arbitrary property
  return `[${camelToKebab(prop)}:${value}]`;
}

/** Convert state override styles to Tailwind modifier classes */
function stateOverridesToTailwind(
  ir: ComponentIR,
  nodeClassName: string
): string[] {
  const classes: string[] = [];

  for (const state of ir.stateOverrides) {
    const overrideStyles = state.overrides[nodeClassName];
    if (!overrideStyles) continue;

    const modifier = selectorToModifier(state.selector);
    for (const [prop, value] of Object.entries(overrideStyles)) {
      if (value === undefined) continue;
      const tw = cssToTailwind(prop, value);
      if (tw) classes.push(`${modifier}:${tw}`);
    }
  }

  return classes;
}

function selectorToModifier(selector: string): string {
  if (selector.includes(":hover")) return "hover";
  if (selector.includes(":active")) return "active";
  if (selector.includes(":focus")) return "focus-visible";
  if (selector.includes(":disabled")) return "disabled";
  if (selector.includes("aria-selected")) return "aria-selected";
  if (selector.includes("aria-checked")) return "aria-checked";
  if (selector.includes("aria-invalid")) return "aria-invalid";
  return "hover"; // fallback
}

// ─── TSX Generation ───

function generateTSX(ir: ComponentIR): string {
  const lines: string[] = [];

  // Imports
  lines.push(`import React from "react";`);
  for (const dep of ir.dependencies) {
    lines.push(`import { ${dep} } from "../${dep}/${dep}";`);
  }
  lines.push("");

  // Props interface
  lines.push(`export interface ${ir.name}Props {`);
  for (const prop of ir.props) {
    if (prop.type === "boolean") {
      lines.push(`  ${prop.name}?: boolean;`);
    } else if (prop.type === "enum" && prop.values) {
      const union = prop.values.map((v) => `"${v.toLowerCase()}"`).join(" | ");
      lines.push(`  ${prop.name}?: ${union};`);
    } else {
      lines.push(`  ${prop.name}?: string;`);
    }
  }
  lines.push(`  children?: React.ReactNode;`);
  lines.push(`}`);
  lines.push("");

  // Component
  const propsDestructure = ir.props
    .map((p) => {
      if (p.defaultValue) {
        const dv = p.type === "boolean" ? p.defaultValue : `"${p.defaultValue.toLowerCase()}"`;
        return `${p.name} = ${dv}`;
      }
      return p.name;
    })
    .concat(["children"])
    .join(", ");

  lines.push(`/** ${ir.description || ir.figmaName} */`);
  lines.push(`export const ${ir.name}: React.FC<${ir.name}Props> = ({ ${propsDestructure} }) => {`);
  lines.push(`  return (`);

  emitTailwindJSX(ir.defaultTree, lines, "    ", ir, true);

  lines.push(`  );`);
  lines.push(`};`);
  lines.push("");

  return lines.join("\n");
}

function emitTailwindJSX(
  node: ParsedNode,
  lines: string[],
  indent: string,
  ir: ComponentIR,
  isRoot: boolean
): void {
  // Component reference
  if (node.componentRef?.componentName) {
    const propsStr = Object.entries(node.componentRef.props)
      .map(([k, v]) => `${k}="${v}"`)
      .join(" ");
    lines.push(`${indent}<${node.componentRef.componentName}${propsStr ? " " + propsStr : ""} />`);
    return;
  }

  const Tag = node.tag;

  // Build class list
  const baseClasses = stylesToTailwind(node.styles);
  const stateClasses = stateOverridesToTailwind(ir, node.className);
  const allClasses = [...baseClasses, ...stateClasses];

  // Dimensional variant classes for root node
  const dimProps = ir.props.filter((p) => p.source === "variant" && p.type === "enum");
  let classExpr: string;

  if (isRoot && dimProps.length > 0) {
    // Build dynamic className with variant conditionals
    const variantParts: string[] = [];
    for (const dim of dimProps) {
      for (const variant of ir.dimensionalVariants.filter((v) => v.propName.toLowerCase() === dim.name.toLowerCase())) {
        const overrideStyles = variant.overrides[node.className];
        if (overrideStyles) {
          const twClasses = stylesToTailwind(overrideStyles as ParsedStyles).join(" ");
          variantParts.push(`${dim.name} === "${variant.propValue.toLowerCase()}" && "${twClasses}"`);
        }
      }
    }

    if (variantParts.length > 0) {
      const staticPart = allClasses.join(" ");
      const dynamicParts = variantParts.map((p) => `      ${p}`).join(",\n");
      classExpr = `{\`${staticPart} \${[\n${dynamicParts}\n    ].filter(Boolean).join(" ")}\`}`;
    } else {
      classExpr = `"${allClasses.join(" ")}"`;
    }
  } else {
    classExpr = `"${allClasses.join(" ")}"`;
  }

  // Text content
  if (node.textContent !== undefined && node.children.length === 0) {
    const textProp = ir.props.find(
      (p) => p.source === "text-content" && p.defaultValue === node.textContent
    );
    const content = textProp ? `{${textProp.name}}` : node.textContent;
    lines.push(`${indent}<${Tag} className=${classExpr}>${content}</${Tag}>`);
    return;
  }

  if (node.children.length === 0) {
    lines.push(`${indent}<${Tag} className=${classExpr} />`);
    return;
  }

  lines.push(`${indent}<${Tag} className=${classExpr}>`);
  for (const child of node.children) {
    emitTailwindJSX(child, lines, indent + "  ", ir, false);
  }
  lines.push(`${indent}</${Tag}>`);
}

function camelToKebab(str: string): string {
  return str.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Zero errors

- [ ] **Step 3: Commit**

```bash
git add src/utils/emitter-react-tailwind.ts
git commit -m "feat: add React + Tailwind CSS code emitter"
```

---

### Task 10: Create React Native emitter

**Files:**
- Create: `src/utils/emitter-react-native.ts`

Emits a single `.tsx` file using React Native primitives and `StyleSheet.create()`. All values are literals (no CSS variables).

- [ ] **Step 1: Write the emitter**

Create `src/utils/emitter-react-native.ts`:

```typescript
/**
 * Code emitter: React Native.
 * Produces a single .tsx file using RN primitives + StyleSheet.create().
 * All values are resolved literals (React Native doesn't support CSS variables).
 */

import type {
  ComponentIR,
  ParsedNode,
  ParsedStyles,
  ResolvedValue,
  EmittedComponent,
} from "../types/node-ir.js";

export function emitReactNative(ir: ComponentIR, outputDir: string): EmittedComponent {
  const content = generateRN(ir);

  return {
    componentName: ir.name,
    figmaName: ir.figmaName,
    figmaUrl: ir.figmaUrl,
    files: [
      {
        path: `${outputDir}/${ir.name}/${ir.name}.tsx`,
        content,
        description: `React Native component with StyleSheet`,
      },
    ],
    props: ir.props,
    dependencies: ir.dependencies,
    warnings: [
      ...ir.warnings,
      "React Native: All values are resolved literals. Design token changes require re-generation.",
    ],
  };
}

// ─── RN Generation ───

function generateRN(ir: ComponentIR): string {
  const lines: string[] = [];

  // Determine which RN imports we need
  const needsPressable = ir.stateOverrides.some((s) =>
    s.selector.includes(":hover") || s.selector.includes(":active")
  );
  const rnImports = ["StyleSheet"];
  if (needsPressable) {
    rnImports.push("Pressable");
  } else {
    rnImports.push("View");
  }
  if (hasTextNode(ir.defaultTree)) rnImports.push("Text");

  lines.push(`import React from "react";`);
  lines.push(`import { ${rnImports.join(", ")} } from "react-native";`);

  for (const dep of ir.dependencies) {
    lines.push(`import { ${dep} } from "../${dep}/${dep}";`);
  }
  lines.push("");

  // Props interface
  lines.push(`export interface ${ir.name}Props {`);
  for (const prop of ir.props) {
    if (prop.type === "boolean") {
      lines.push(`  ${prop.name}?: boolean;`);
    } else if (prop.type === "enum" && prop.values) {
      const union = prop.values.map((v) => `"${v.toLowerCase()}"`).join(" | ");
      lines.push(`  ${prop.name}?: ${union};`);
    } else {
      lines.push(`  ${prop.name}?: string;`);
    }
  }
  lines.push(`  children?: React.ReactNode;`);
  lines.push(`}`);
  lines.push("");

  // Component
  const propsDestructure = ir.props
    .map((p) => {
      if (p.defaultValue) {
        const dv = p.type === "boolean" ? p.defaultValue : `"${p.defaultValue.toLowerCase()}"`;
        return `${p.name} = ${dv}`;
      }
      return p.name;
    })
    .concat(["children"])
    .join(", ");

  lines.push(`/** ${ir.description || ir.figmaName} */`);
  lines.push(`export const ${ir.name}: React.FC<${ir.name}Props> = ({ ${propsDestructure} }) => {`);

  if (needsPressable) {
    // Find pressed state styles
    const pressedOverrides = ir.stateOverrides.find((s) =>
      s.selector.includes(":active")
    );
    const disabledProp = ir.props.find((p) => p.name === "disabled");

    lines.push(`  return (`);
    lines.push(`    <Pressable`);
    if (disabledProp) lines.push(`      disabled={disabled}`);
    lines.push(`      style={({ pressed }) => [`);
    lines.push(`        rnStyles.${ir.defaultTree.className},`);

    // Dimensional variants
    for (const dim of ir.props.filter((p) => p.source === "variant" && p.type === "enum")) {
      for (const variant of ir.dimensionalVariants.filter((v) => v.propName.toLowerCase() === dim.name.toLowerCase())) {
        const styleName = sanitizeStyleName(`${variant.propValue}`);
        lines.push(`        ${dim.name} === "${variant.propValue.toLowerCase()}" && rnStyles.${styleName},`);
      }
    }

    if (pressedOverrides) {
      lines.push(`        pressed && rnStyles.pressed,`);
    }
    if (disabledProp) {
      const disabledOverride = ir.stateOverrides.find((s) => s.selector.includes(":disabled"));
      if (disabledOverride) {
        lines.push(`        disabled && rnStyles.disabled,`);
      }
    }
    lines.push(`      ]}`);
    lines.push(`    >`);

    // Render children
    for (const child of ir.defaultTree.children) {
      emitRNNode(child, lines, "      ", ir);
    }
    if (ir.defaultTree.children.length === 0) {
      lines.push(`      {children}`);
    }

    lines.push(`    </Pressable>`);
  } else {
    lines.push(`  return (`);
    lines.push(`    <View style={rnStyles.${ir.defaultTree.className}}>`);
    for (const child of ir.defaultTree.children) {
      emitRNNode(child, lines, "      ", ir);
    }
    lines.push(`    </View>`);
  }

  lines.push(`  );`);
  lines.push(`};`);
  lines.push("");

  // StyleSheet
  lines.push(`const rnStyles = StyleSheet.create({`);

  // Base styles
  emitRNStyleEntry(ir.defaultTree.className, cssToRNStyles(ir.defaultTree.styles, ir.defaultTree.resolvedValues), lines);

  // Child styles
  collectRNStyles(ir.defaultTree, lines);

  // State override styles
  for (const state of ir.stateOverrides) {
    const rootOverride = state.overrides[ir.defaultTree.className];
    if (rootOverride) {
      const styleName = state.selector.includes(":active") ? "pressed"
        : state.selector.includes(":disabled") ? "disabled"
        : sanitizeStyleName(state.stateName);
      const rv = state.resolvedOverrides?.[ir.defaultTree.className];
      emitRNStyleEntry(styleName, cssToRNStyles(rootOverride as ParsedStyles, rv), lines);
    }
  }

  // Dimensional variant styles
  for (const variant of ir.dimensionalVariants) {
    const rootOverride = variant.overrides[ir.defaultTree.className];
    if (rootOverride) {
      const rv = variant.resolvedOverrides?.[ir.defaultTree.className];
      emitRNStyleEntry(
        sanitizeStyleName(variant.propValue),
        cssToRNStyles(rootOverride as ParsedStyles, rv),
        lines
      );
    }
  }

  lines.push(`});`);
  lines.push("");

  return lines.join("\n");
}

function emitRNNode(
  node: ParsedNode,
  lines: string[],
  indent: string,
  ir: ComponentIR
): void {
  if (node.componentRef?.componentName) {
    const propsStr = Object.entries(node.componentRef.props)
      .map(([k, v]) => `${k}="${v}"`)
      .join(" ");
    lines.push(`${indent}<${node.componentRef.componentName}${propsStr ? " " + propsStr : ""} />`);
    return;
  }

  if (node.textContent !== undefined) {
    const textProp = ir.props.find(
      (p) => p.source === "text-content" && p.defaultValue === node.textContent
    );
    const content = textProp ? `{${textProp.name}}` : `"${node.textContent}"`;
    lines.push(`${indent}<Text style={rnStyles.${node.className}}>${content}</Text>`);
    return;
  }

  if (node.children.length === 0) {
    lines.push(`${indent}<View style={rnStyles.${node.className}} />`);
    return;
  }

  lines.push(`${indent}<View style={rnStyles.${node.className}}>`);
  for (const child of node.children) {
    emitRNNode(child, lines, indent + "  ", ir);
  }
  lines.push(`${indent}</View>`);
}

function collectRNStyles(node: ParsedNode, lines: string[]): void {
  for (const child of node.children) {
    if (child.componentRef) continue;
    const rnStyles = cssToRNStyles(child.styles, child.resolvedValues);
    if (Object.keys(rnStyles).length > 0) {
      emitRNStyleEntry(child.className, rnStyles, lines);
    }
    collectRNStyles(child, lines);
  }
}

function emitRNStyleEntry(
  name: string,
  styles: Record<string, string | number>,
  lines: string[]
): void {
  if (Object.keys(styles).length === 0) return;
  const entries = Object.entries(styles)
    .map(([k, v]) => `    ${k}: ${typeof v === "string" ? `"${v}"` : v},`)
    .join("\n");
  lines.push(`  ${name}: {\n${entries}\n  },`);
}

// ─── CSS to React Native Style Conversion ───

function cssToRNStyles(
  styles: ParsedStyles,
  resolvedValues?: Map<string, ResolvedValue>
): Record<string, string | number> {
  const rn: Record<string, string | number> = {};

  for (const [prop, value] of Object.entries(styles)) {
    if (value === undefined) continue;
    // Use the literal value from resolvedValues if available (for token-bound values)
    const rv = resolvedValues?.get(prop);
    const resolved = rv ? rv.literal : value;

    switch (prop) {
      case "display":
        if (value === "flex") rn.display = "flex";
        break;
      case "flexDirection":
        rn.flexDirection = value as string;
        break;
      case "justifyContent":
        rn.justifyContent = value as string;
        break;
      case "alignItems":
        rn.alignItems = value as string;
        break;
      case "flexWrap":
        rn.flexWrap = value as string;
        break;
      case "flex":
        rn.flex = parseFloat(value) || 1;
        break;
      case "gap":
        rn.gap = parseNumericPx(resolved);
        break;
      case "rowGap":
        rn.rowGap = parseNumericPx(resolved);
        break;
      case "columnGap":
        rn.columnGap = parseNumericPx(resolved);
        break;
      case "padding":
        rn.padding = parseNumericPx(resolved);
        break;
      case "paddingTop":
        rn.paddingTop = parseNumericPx(resolved);
        break;
      case "paddingRight":
        rn.paddingRight = parseNumericPx(resolved);
        break;
      case "paddingBottom":
        rn.paddingBottom = parseNumericPx(resolved);
        break;
      case "paddingLeft":
        rn.paddingLeft = parseNumericPx(resolved);
        break;
      case "width":
        rn.width = parseNumericPx(resolved);
        break;
      case "height":
        rn.height = parseNumericPx(resolved);
        break;
      case "minWidth":
        rn.minWidth = parseNumericPx(resolved);
        break;
      case "maxWidth":
        rn.maxWidth = parseNumericPx(resolved);
        break;
      case "minHeight":
        rn.minHeight = parseNumericPx(resolved);
        break;
      case "maxHeight":
        rn.maxHeight = parseNumericPx(resolved);
        break;
      case "background":
        rn.backgroundColor = resolved;
        break;
      case "color":
        rn.color = resolved;
        break;
      case "borderRadius":
        rn.borderRadius = parseNumericPx(resolved);
        break;
      case "opacity":
        rn.opacity = parseFloat(value);
        break;
      case "overflow":
        rn.overflow = value as string;
        break;
      case "fontFamily":
        rn.fontFamily = value.replace(/'/g, "").split(",")[0].trim();
        break;
      case "fontSize":
        rn.fontSize = parseNumericPx(resolved);
        break;
      case "fontWeight":
        rn.fontWeight = value as string;
        break;
      case "lineHeight":
        rn.lineHeight = parseNumericPx(resolved);
        break;
      case "letterSpacing":
        rn.letterSpacing = parseNumericPx(resolved);
        break;
      case "textAlign":
        rn.textAlign = value as string;
        break;
      case "textTransform":
        rn.textTransform = value as string;
        break;
      case "textDecoration":
        if (value === "underline") rn.textDecorationLine = "underline";
        if (value === "line-through") rn.textDecorationLine = "line-through";
        break;
      // Skip properties that don't map to RN
      default:
        break;
    }
  }

  return rn;
}

// ─── Helpers ───

function hasTextNode(node: ParsedNode): boolean {
  if (node.textContent !== undefined) return true;
  return node.children.some(hasTextNode);
}

function parseNumericPx(value: string): number {
  const match = value.match(/^([\d.]+)px?$/);
  return match ? parseFloat(match[1]) : 0;
}

function sanitizeStyleName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9]/g, "")
    .replace(/^([A-Z])/, (m) => m.toLowerCase());
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Zero errors

- [ ] **Step 3: Commit**

```bash
git add src/utils/emitter-react-native.ts
git commit -m "feat: add React Native code emitter with StyleSheet"
```

---

## Chunk 6: Tool Orchestration & Registration

### Task 11: Create the generate_coded_components tool

**Files:**
- Create: `src/tools/generate-coded-components.ts`

The MCP tool that orchestrates the entire pipeline: fetch components → fetch variables → fetch variant nodes → parse → diff → resolve composition → emit.

- [ ] **Step 1: Write the tool**

Create `src/tools/generate-coded-components.ts`:

```typescript
/**
 * Tool: generate_coded_components
 * Generates pixel-perfect, production-ready coded components from Figma.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FigmaClient } from "../clients/figma.js";
import type { FigmaDetailedNode } from "../types/figma.js";
import type {
  ComponentIR,
  VariantEntry,
  EmittedComponent,
  ComponentPropIR,
} from "../types/node-ir.js";
import { VariableResolver } from "../utils/variable-resolver.js";
import { parseNodeTree } from "../utils/node-parser.js";
import { diffVariants, extractPropsFromVariants } from "../utils/state-differ.js";
import {
  buildComponentNameMap,
  resolveComponentRefs,
  extractDependencies,
  topologicalSort,
  extractTextProps,
} from "../utils/composition-resolver.js";
import { emitReactCSS } from "../utils/emitter-react-css.js";
import { emitHTMLCSS } from "../utils/emitter-html-css.js";
import { emitReactTailwind } from "../utils/emitter-react-tailwind.js";
import { emitReactNative } from "../utils/emitter-react-native.js";
import { sanitizeClassName } from "../utils/node-parser.js";
import { toPascalCase, generateStorybook } from "../utils/scaffold-templates.js";
import type { ComponentProp } from "../types/scaffold.js";
import { toUserMessage } from "../utils/errors.js";

const BATCH_SIZE = 50;

const InputSchema = z.object({
  figma_file_key: z.string().min(1)
    .describe("The Figma file key (from the URL: figma.com/design/{THIS_PART}/...)"),
  component_names: z.array(z.string()).optional()
    .describe("Specific component names to generate (default: all)"),
  framework: z.enum(["react-tailwind", "react-css", "react-native", "html-css"])
    .describe("Target framework for code generation"),
  output_dir: z.string().default("src/components")
    .describe("Output directory for generated components (default: 'src/components')"),
  state_prop_names: z.array(z.string()).default(["State", "Status", "Interaction"])
    .describe("Variant prop names that map to CSS pseudo-classes (default: ['State', 'Status', 'Interaction'])"),
  include_storybook: z.boolean().default(false)
    .describe("Generate Storybook story files (default: false)"),
}).strict();

type Input = z.infer<typeof InputSchema>;

export function registerGenerateCodedComponents(
  server: McpServer,
  figmaClient: FigmaClient
): void {
  server.registerTool(
    "generate_coded_components",
    {
      title: "Generate Coded Components",
      description: `Generate production-ready, pixel-perfect coded components from Figma.

Extracts layout, colors, typography, spacing, effects from Figma node trees,
resolves variable bindings to design tokens, diffs variants for state/dimensional
overrides, detects nested components, and emits framework-specific code.

Args:
  - figma_file_key (string): The Figma file key
  - component_names (string[], optional): Specific components (default: all)
  - framework ('react-tailwind' | 'react-css' | 'react-native' | 'html-css'): Target framework
  - output_dir (string): Output directory (default: 'src/components')
  - state_prop_names (string[]): Variant props that become CSS pseudo-classes
  - include_storybook (boolean): Generate Storybook files (default: false)

Returns:
  JSON with generated component files, props, dependencies, and summary.`,
      inputSchema: InputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (params: Input) => {
      try {
        const warnings: string[] = [];

        // 1. Fetch components metadata
        const componentsResponse = await figmaClient.getComponents(params.figma_file_key);
        const { components: metaComponents, component_sets: metaComponentSets } = componentsResponse.meta;

        // Build component set info
        const componentSets = new Map<string, {
          name: string;
          nodeId: string;
          description: string;
          figmaUrl: string;
          variantNodeIds: VariantEntry[];
        }>();

        // Map setId → set name
        const setIdToName = new Map<string, string>();
        if (metaComponentSets) {
          for (const [nodeId, set] of Object.entries(metaComponentSets)) {
            setIdToName.set(nodeId, set.name);
            componentSets.set(nodeId, {
              name: set.name,
              nodeId,
              description: set.description,
              figmaUrl: `https://www.figma.com/design/${params.figma_file_key}?node-id=${encodeURIComponent(nodeId)}`,
              variantNodeIds: [],
            });
          }
        }

        // Map variants to their parent sets
        for (const [variantNodeId, comp] of Object.entries(metaComponents)) {
          if (comp.componentSetId && componentSets.has(comp.componentSetId)) {
            const propValues = parseVariantName(comp.name);
            componentSets.get(comp.componentSetId)!.variantNodeIds.push({
              nodeId: variantNodeId,
              name: comp.name,
              propValues,
            });
          }
        }

        // Handle standalone components (no variants)
        for (const [nodeId, comp] of Object.entries(metaComponents)) {
          if (!comp.componentSetId) {
            componentSets.set(nodeId, {
              name: comp.name,
              nodeId,
              description: comp.description,
              figmaUrl: `https://www.figma.com/design/${params.figma_file_key}?node-id=${encodeURIComponent(nodeId)}`,
              variantNodeIds: [{
                nodeId,
                name: comp.name,
                propValues: {},
              }],
            });
          }
        }

        // Filter by component_names if specified
        let targetSets = Array.from(componentSets.values());
        if (params.component_names && params.component_names.length > 0) {
          const namesLower = new Set(params.component_names.map((n) => n.toLowerCase()));
          targetSets = targetSets.filter((s) =>
            namesLower.has(s.name.toLowerCase())
          );
          if (targetSets.length === 0) {
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  components: [],
                  summary: { total: 0, framework: params.framework, totalFiles: 0, outputDir: params.output_dir, generationOrder: [], warnings: ["No matching components found"] },
                }, null, 2),
              }],
            };
          }
        }

        // 2. Fetch variables for token resolution
        const varsResponse = await figmaClient.getLocalVariables(params.figma_file_key);
        const resolver = new VariableResolver(varsResponse.meta.variables);

        // 3. Collect all variant node IDs
        const allNodeIds: string[] = [];
        for (const set of targetSets) {
          for (const variant of set.variantNodeIds) {
            allNodeIds.push(variant.nodeId);
          }
        }

        // 4. Fetch nodes in batches
        const allNodes: Record<string, FigmaDetailedNode> = {};
        for (let i = 0; i < allNodeIds.length; i += BATCH_SIZE) {
          const batch = allNodeIds.slice(i, i + BATCH_SIZE);
          const response = await figmaClient.getNodes(params.figma_file_key, batch);
          for (const [nodeId, nodeData] of Object.entries(response.nodes)) {
            if (nodeData) {
              allNodes[nodeId] = nodeData.document;
            }
          }
        }

        // 5. Build component name map for composition resolution
        const nameMap = buildComponentNameMap(
          targetSets.map((s) => ({ nodeId: s.nodeId, name: s.name }))
        );
        const knownComponentIds = new Set(targetSets.map((s) => s.nodeId));

        // 6. Process each component into IR
        const componentIRs: ComponentIR[] = [];

        for (const set of targetSets) {
          try {
            const componentName = toPascalCase(set.name);
            const rootClassName = sanitizeClassName(set.name);

            // Extract props from variants
            const variantProps = extractPropsFromVariants(
              set.variantNodeIds,
              params.state_prop_names
            );

            // Parse default variant tree
            const defaultVariant = set.variantNodeIds[0];
            const defaultNode = allNodes[defaultVariant.nodeId];
            if (!defaultNode) {
              warnings.push(`Component "${set.name}": node not found, skipping`);
              continue;
            }

            const defaultTree = parseNodeTree(defaultNode, resolver, knownComponentIds);

            // Resolve component refs
            resolveComponentRefs(defaultTree, nameMap);

            // Extract text props
            const textProps = extractTextProps(defaultTree, componentName);
            const textPropIRs: ComponentPropIR[] = textProps.map((tp) => ({
              name: tp.name,
              type: "string" as const,
              defaultValue: tp.defaultValue,
              source: "text-content" as const,
            }));

            // Diff variants
            const { stateOverrides, dimensionalVariants } = diffVariants(
              set.variantNodeIds,
              allNodes,
              resolver,
              params.state_prop_names,
              rootClassName
            );

            // Extract dependencies
            const dependencies = extractDependencies(defaultTree);

            const ir: ComponentIR = {
              name: componentName,
              figmaName: set.name,
              nodeId: set.nodeId,
              figmaUrl: set.figmaUrl,
              description: set.description,
              defaultTree,
              stateOverrides,
              dimensionalVariants,
              props: [...variantProps, ...textPropIRs],
              dependencies,
              warnings: defaultTree.warnings ?? [],
            };

            componentIRs.push(ir);
          } catch (error) {
            warnings.push(`Component "${set.name}": ${toUserMessage(error)}`);
          }
        }

        // 7. Topological sort
        const { sorted: generationOrder, warnings: sortWarnings } = topologicalSort(
          componentIRs.map((ir) => ({ name: ir.name, dependencies: ir.dependencies }))
        );
        warnings.push(...sortWarnings);

        // Sort IRs by generation order
        const sortedIRs = generationOrder
          .map((name) => componentIRs.find((ir) => ir.name === name))
          .filter((ir): ir is ComponentIR => ir !== undefined);

        // 8. Emit code per framework
        const emitter = getEmitter(params.framework);
        const emittedComponents: EmittedComponent[] = sortedIRs.map((ir) => {
          const emitted = emitter(ir, params.output_dir);

          // Generate Storybook story if requested
          if (params.include_storybook && params.framework !== "html-css") {
            const storyProps: ComponentProp[] = ir.props.map((p) => ({
              name: p.name,
              type: p.type,
              values: p.values,
              defaultValue: p.defaultValue,
            }));
            const storyContent = generateStorybook(ir.name, storyProps);
            emitted.files.push({
              path: `${params.output_dir}/${ir.name}/${ir.name}.stories.tsx`,
              content: storyContent,
              description: `Storybook story with controls for ${ir.name}`,
            });
          }

          return emitted;
        });

        // 9. Return output
        const output = {
          components: emittedComponents,
          summary: {
            total: emittedComponents.length,
            framework: params.framework,
            totalFiles: emittedComponents.reduce((sum, c) => sum + c.files.length, 0),
            outputDir: params.output_dir,
            generationOrder,
            warnings,
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

// ─── Helpers ───

function getEmitter(
  framework: string
): (ir: ComponentIR, outputDir: string) => EmittedComponent {
  switch (framework) {
    case "react-tailwind": return emitReactTailwind;
    case "react-css": return emitReactCSS;
    case "react-native": return emitReactNative;
    case "html-css": return emitHTMLCSS;
    default: return emitReactCSS;
  }
}

/**
 * Parse a Figma variant name string like "Size=Large, State=Hover"
 * into key-value pairs: { Size: "Large", State: "Hover" }
 */
function parseVariantName(name: string): Record<string, string> {
  const result: Record<string, string> = {};
  const parts = name.split(",").map((s) => s.trim());
  for (const part of parts) {
    const [key, value] = part.split("=").map((s) => s.trim());
    if (key && value) {
      result[key] = value;
    }
  }
  return result;
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Zero errors

- [ ] **Step 3: Commit**

```bash
git add src/tools/generate-coded-components.ts
git commit -m "feat: add generate_coded_components MCP tool orchestration"
```

---

### Task 12: Register in index.ts and final verification

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add import**

After the `import { registerGenerateDesignDoc }` line in `src/index.ts`, add:

```typescript
import { registerGenerateCodedComponents } from "./tools/generate-coded-components.js";
```

- [ ] **Step 2: Add registration**

After the `registerGenerateDesignDoc(server, figmaClient, dsCache);` call, add:

```typescript
  registerGenerateCodedComponents(server, figmaClient);
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: Zero errors

- [ ] **Step 4: Verify tool count**

Run: `grep -c 'registerTool' src/tools/*.ts`
Expected: 14 tools total (13 existing + generate_coded_components)

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: register generate_coded_components — 14 MCP tools total"
```

---

### Task 13: Manual verification

- [ ] **Step 1: Start MCP Inspector**

```bash
FIGMA_ACCESS_TOKEN=$FIGMA_ACCESS_TOKEN npx @modelcontextprotocol/inspector node dist/index.js
```

- [ ] **Step 2: Verify 14 tools appear**

Expected: All 14 tools listed including `generate_coded_components`.

- [ ] **Step 3: Test with react-css framework**

Call with:
```json
{
  "figma_file_key": "fSXBK7qFUUyCtZVbO6qAoI",
  "framework": "react-css"
}
```

Expected: Returns JSON with component files (.tsx + .module.css) for components found in the file. Each component should have resolved token references as `var(--token-name)` values.

- [ ] **Step 4: Test with react-tailwind framework**

Call with the same file key but `"framework": "react-tailwind"`.

Expected: Returns single .tsx files per component with Tailwind classes using arbitrary value syntax.

# Design Spec: generate_coded_components

## Overview

A new MCP tool for designxcode-mcp that generates **production-ready, pixel-perfect coded components** from Figma design system components. Unlike `generate_component_scaffold` (which produces empty shells with prop interfaces), this tool extracts actual visual properties — layout, colors, typography, spacing, effects — from Figma node trees, resolves variable bindings to design tokens, and emits framework-specific code.

**Source of truth:** Figma. Generated code is fully overwritten on re-generation. Developers compose around generated components — they never edit them directly.

**Framework targets:** React + Tailwind, React + CSS Modules, React Native, HTML + CSS (selectable per invocation).

---

## Input Schema

```typescript
{
  figma_file_key: string              // required — the Figma file key
  component_names: string[]           // optional — specific components (default: all)
  framework: "react-tailwind" | "react-css" | "react-native" | "html-css"  // required
  output_dir: string                  // default "src/components"
  state_prop_names: string[]          // default ["State", "Status", "Interaction"]
  include_storybook: boolean          // default false
}
```

- `component_names`: Filters to specific components. If omitted, generates all components in the file.
- `framework`: Determines which code emitter is used.
- `state_prop_names`: Variant prop names that should map to CSS pseudo-classes rather than component props. Any variant prop NOT in this list is treated as a dimensional prop (generates separate style classes driven by a component prop).
- `include_storybook`: When true, generates a Storybook story file per component using the existing `generateStorybook()` from `scaffold-templates.ts`.

---

## Architecture

### Pipeline

```
Figma Component (nodeIds)
  → getNodes() — full node tree (batched, max 50 IDs per request)
  → getLocalVariables() — variable definitions for bound variable resolution
  → Node Parser — walk tree, extract layout + styles, resolve variable bindings
  → State Differ — diff variant nodes against default, map to CSS pseudo-classes
  → Composition Resolver — detect INSTANCE nodes, build dependency graph
  → Code Emitter (per framework) — framework-specific component code
  → Output: { files: [{path, content, description}], summary }
```

### New Files

| File | Responsibility |
|---|---|
| `src/types/node-ir.ts` | Intermediate representation types |
| `src/utils/node-parser.ts` | Figma node tree → ParsedNode IR with resolved styles |
| `src/utils/variable-resolver.ts` | Resolve `boundVariables` → CSS variable names |
| `src/utils/state-differ.ts` | Diff variants, separate state from dimensional props |
| `src/utils/composition-resolver.ts` | Detect INSTANCE nodes, dependency graph, topological sort |
| `src/utils/emitter-react-tailwind.ts` | React + Tailwind emitter |
| `src/utils/emitter-react-css.ts` | React + CSS Modules emitter |
| `src/utils/emitter-react-native.ts` | React Native emitter |
| `src/utils/emitter-html-css.ts` | HTML + CSS emitter |
| `src/tools/generate-coded-components.ts` | MCP tool registration + orchestration |

### Modified Files

| File | Change |
|---|---|
| `src/types/figma.ts` | Extend `FigmaDetailedNode` with missing properties (see below) and add `gradientHandlePositions` to `FigmaPaint` |
| `src/utils/w3c-tokens.ts` | Export `sanitizeTokenName` (currently private) |
| `src/index.ts` | Register `generate_coded_components` |

**`FigmaDetailedNode` properties to add** (all are real Figma REST API properties, not currently typed):

```typescript
// Sizing & constraints
layoutSizingHorizontal?: "FIXED" | "HUG" | "FILL";
layoutSizingVertical?: "FIXED" | "HUG" | "FILL";
layoutWrap?: "NO_WRAP" | "WRAP";
minWidth?: number;
maxWidth?: number;
minHeight?: number;
maxHeight?: number;

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

// Variable bindings (the key feature for token resolution)
boundVariables?: Record<string, FigmaVariableAlias | FigmaVariableAlias[]>;
```

**`FigmaPaint` property to add:**
```typescript
gradientHandlePositions?: Array<{ x: number; y: number }>;
```

### Existing Code Reused

| Code | Used for |
|---|---|
| `figmaClient.getNodes(fileKey, nodeIds)` | Fetch full node properties |
| `figmaClient.getLocalVariables(fileKey)` | Variable definitions for resolution |
| `fetchComponentsWithProps()` from `component-context.ts` | Component list with variant props and nodeIds |
| `parseVariants()` from `variant-parser.ts` | Extract variant props from naming convention |
| `toPascalCase()` / `toCamelCase()` from `scaffold-templates.ts` | Naming helpers |
| `figmaColorToHex()` from `w3c-tokens.ts` | Color conversion for unbound values |
| `generateStorybook()` from `scaffold-templates.ts` | Storybook generation (when `include_storybook: true`) — note: accepts `ComponentProp[]`, so `ComponentPropIR` must be mapped back (drop `source` field) |

### Obtaining Variant Node IDs

`fetchComponentsWithProps()` returns the **component set** nodeId, but diffing requires the nodeId of **each individual variant** (e.g., `Size=Large, State=Hover`).

Variant node IDs come from the `figmaClient.getComponents(fileKey)` response. The `response.meta.components` object is keyed by node ID, and each entry has `componentSetId` linking it to its parent set. The tool must:

1. Call `getComponents(fileKey)` (already done inside `fetchComponentsWithProps`)
2. From `response.meta.components`, collect all entries grouped by `componentSetId`
3. Each entry's key IS the variant's node ID, and its `name` contains the variant string (e.g., `"Size=Large, State=Hover"`)
4. Pass these variant node IDs to `getNodes()` to fetch full property trees

This data is already partially available in `component-context.ts` (the `variantsBySetName` map), but it discards the node IDs. The tool should either extend `fetchComponentsWithProps()` to preserve variant node IDs, or fetch components separately.

### Node ID Batching

The Figma REST API has URL length limits. When fetching nodes for all variants of all components, the ID count can easily exceed 200+. The tool batches `getNodes()` calls at **50 IDs per request** and merges the responses.

---

## Intermediate Representation (IR)

The node parser produces a framework-agnostic IR. Code emitters consume this IR — they never touch Figma types directly.

### Types

```typescript
/** A parsed Figma node ready for code emission */
interface ParsedNode {
  /** HTML tag inferred from node type */
  tag: "div" | "span" | "p" | "img" | "input" | "button" | "svg";
  /** Stable class name derived from node name */
  className: string;
  /** CSS properties with resolved values (tokens or literals) */
  styles: ParsedStyles;
  /** Child nodes */
  children: ParsedNode[];
  /** Text content for text nodes */
  textContent?: string;
  /** If true, textContent should become a component prop */
  isTextProp?: boolean;
  /** Reference to a nested component (INSTANCE node) */
  componentRef?: ComponentReference;
}

/** CSS properties extracted from a Figma node */
interface ParsedStyles {
  // Layout
  display?: string;
  flexDirection?: string;
  justifyContent?: string;
  alignItems?: string;
  gap?: string;
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

  // Typography
  fontFamily?: string;
  fontSize?: string;
  fontWeight?: string;
  lineHeight?: string;
  letterSpacing?: string;
  textAlign?: string;
  textTransform?: string;
  textDecoration?: string;

  // Catch-all for less common properties
  [key: string]: string | undefined;
}

/** Reference to a nested component instance */
interface ComponentReference {
  /** PascalCase component name */
  componentName: string;
  /** Props to pass (from instance overrides) */
  props: Record<string, string>;
  /** nodeId of the referenced component (for import resolution) */
  sourceNodeId: string;
}

/** Full component IR including all variants */
interface ComponentIR {
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
}

/** Style changes for a CSS pseudo-class state */
interface StateOverride {
  /** State name from Figma (e.g., "Hover") */
  stateName: string;
  /** CSS selector (e.g., ":hover", ":focus-visible") */
  selector: string;
  /** className → changed styles */
  overrides: Record<string, Partial<ParsedStyles>>;
}

/** Style changes for a dimensional variant */
interface DimensionalVariant {
  /** Prop name (e.g., "Size") */
  propName: string;
  /** Prop value (e.g., "Large") */
  propValue: string;
  /** CSS modifier class name (e.g., "button--large") */
  modifierClass: string;
  /** className → changed styles */
  overrides: Record<string, Partial<ParsedStyles>>;
}

/** A component prop (from variants or text content) */
interface ComponentPropIR {
  name: string;
  type: "boolean" | "string" | "enum";
  values?: string[];
  defaultValue?: string;
  /** Where this prop came from */
  source: "variant" | "text-content";
}
// Note: parseVariants() returns ComponentProp[] (from types/scaffold.ts).
// Map to ComponentPropIR by spreading and adding source: "variant".
// Text content props are created during node parsing with source: "text-content".
```

---

## Node Parser

### Entry Point

```typescript
function parseNode(
  node: FigmaDetailedNode,
  variables: Record<string, FigmaVariable>,
  resolver: VariableResolver
): ParsedNode
```

Walks the Figma node tree recursively. For each node:

1. **Infer tag** from node type:
   - `TEXT` → `<span>` (single line) or `<p>` (multi-line / paragraph)
   - `INSTANCE` → defer to composition resolver
   - `FRAME` / `GROUP` / `COMPONENT` / `COMPONENT_SET` → `<div>`
   - `RECTANGLE` with no children → `<div>` (visual element)
   - `VECTOR` / `BOOLEAN_OPERATION` / `STAR` / `LINE` / `ELLIPSE` → skip with TODO comment (v1 deferred)

2. **Extract styles** from node properties (see mapping table below)

3. **Resolve variable bindings** for each style value — if `node.boundVariables` exists for a property, resolve through `VariableResolver`

4. **Generate className** from node name: sanitize (lowercase, hyphens, strip special chars)

5. **Recurse into children** (for auto-layout nodes, preserve child order)

### Figma Property → CSS Mapping

| Figma Property | CSS Property | Resolution Logic |
|---|---|---|
| `layoutMode: "HORIZONTAL"` | `display: flex; flex-direction: row` | Direct map |
| `layoutMode: "VERTICAL"` | `display: flex; flex-direction: column` | Direct map |
| `layoutWrap: "WRAP"` | `flex-wrap: wrap` | Direct map |
| `primaryAxisAlignItems: "MIN"` | `justify-content: flex-start` | MIN→flex-start, CENTER→center, MAX→flex-end, SPACE_BETWEEN→space-between |
| `counterAxisAlignItems: "MIN"` | `align-items: flex-start` | MIN→flex-start, CENTER→center, MAX→flex-end, BASELINE→baseline |
| `paddingTop/Right/Bottom/Left` | `padding` or individual | Shorthand if all four present; resolve via `boundVariables.paddingTop` etc. |
| `itemSpacing` | `gap` | Resolve via `boundVariables.itemSpacing` |
| `counterAxisSpacing` | `row-gap` (HORIZONTAL) or `column-gap` (VERTICAL) | Cross-axis gap for wrapped auto-layout. HORIZONTAL layout wraps rows → `row-gap`. VERTICAL layout wraps columns → `column-gap` |
| `layoutSizingHorizontal: "FILL"` | `width: 100%` or `flex: 1` | FILL→flex:1 if parent is auto-layout, else width:100%. HUG→auto. FIXED→literal px |
| `layoutSizingVertical: "FILL"` | `height: 100%` or `flex: 1` | Same logic as horizontal |
| `minWidth / maxWidth / minHeight / maxHeight` | Same CSS properties | Direct map with px units |
| `fills[0]` (SOLID) | `background` or `color` (text) | Resolve `fills[0].boundVariables.color` → `var(--token)`. Fallback: `figmaColorToHex()`. For text nodes, emit as `color` instead of `background` |
| `fills[0]` (GRADIENT_LINEAR) | `background: linear-gradient(...)` | Convert `gradientHandlePositions` to angle, map `gradientStops` to color stops. Each stop color is individually variable-resolvable |
| `strokes[]` + `strokeWeight` + `strokeAlign` | `border` | `border: {weight}px solid {color}`. `strokeAlign: "INSIDE"` → use `outline` or `box-shadow` instead. Individual side strokes supported via `individualStrokeWeights` |
| `effects[]` (DROP_SHADOW) | `box-shadow` | `{offset.x}px {offset.y}px {radius}px {spread}px {color}`. Multiple shadows comma-separated |
| `effects[]` (INNER_SHADOW) | `box-shadow: inset ...` | Same as DROP_SHADOW with `inset` prefix |
| `effects[]` (LAYER_BLUR) | `filter: blur({radius}px)` | Direct map |
| `effects[]` (BACKGROUND_BLUR) | `backdrop-filter: blur({radius}px)` | Direct map |
| `cornerRadius` | `border-radius` | Single value. Resolve via `boundVariables.topLeftRadius` etc. |
| `rectangleCornerRadii` | `border-radius: TL TR BR BL` | Per-corner values |
| `opacity` | `opacity` | Only emit when < 1 |
| `visible: false` | `display: none` | Skip node entirely from output |
| `clipsContent: true` | `overflow: hidden` | Direct map |

**Typography (TEXT nodes only):**

| Figma Property | CSS Property | Notes |
|---|---|---|
| `style.fontFamily` | `font-family` | Wrap in quotes, add generic fallback |
| `style.fontSize` | `font-size` | px units. Resolve via `boundVariables.fontSize` |
| `style.fontWeight` | `font-weight` | Numeric (100-900) |
| `style.lineHeightPx` / `lineHeightPercentFontSize` | `line-height` | px or unitless ratio |
| `style.letterSpacing` | `letter-spacing` | px or em. Resolve via `boundVariables.letterSpacing` |
| `style.textAlignHorizontal` | `text-align` | LEFT→left, CENTER→center, RIGHT→right, JUSTIFIED→justify |
| `style.textCase` | `text-transform` | UPPER→uppercase, LOWER→lowercase, TITLE→capitalize, ORIGINAL→none |
| `style.textDecoration` | `text-decoration` | UNDERLINE→underline, STRIKETHROUGH→line-through |

---

## Variable Resolver

### Purpose

Resolves Figma `boundVariables` to CSS custom property references.

### Interface

```typescript
class VariableResolver {
  constructor(
    variables: Record<string, FigmaVariable>,
    collections: Record<string, FigmaVariableCollection>
  );

  /** Resolve a variable binding to a CSS value */
  resolve(binding: FigmaVariableAlias): ResolvedValue;

  /** Resolve a raw value to a CSS value (no binding) */
  resolveLiteral(value: unknown, resolvedType: string): string;
}

interface ResolvedValue {
  /** CSS value — either var(--token-name) or a literal */
  css: string;
  /** Whether this value references a design token */
  isBound: boolean;
  /** The token name if bound (e.g., "colors-primary-500") */
  tokenName?: string;
  /** The resolved literal value (for React Native or fallback) */
  literal: string;
}
```

### Resolution Flow

1. Receive a `boundVariables` entry: `{ type: "VARIABLE_ALIAS", id: "VariableID:1234" }`
2. Look up `variables["VariableID:1234"]` → get variable name (e.g., `colors/primary/500`)
3. Sanitize name: `colors/primary/500` → `colors-primary-500` (same logic as `sanitizeTokenName()` in `w3c-tokens.ts`)
4. Return `{ css: "var(--colors-primary-500)", isBound: true, tokenName: "colors-primary-500", literal: "#6366F1" }`

For **alias chains** (variable A references variable B), follow the chain to the final value (reuse the `resolveValue()` pattern from `w3c-tokens.ts`).

For **unbound values**, return the literal with `isBound: false`. In CSS emitters, unbound values get a comment: `/* unbound */ #6366F1`.

For **React Native**, always use `literal` (React Native doesn't support CSS variables).

---

## State Differ

### Purpose

Takes multiple variant node trees and produces:
1. **State overrides** — style diffs that map to CSS pseudo-classes (`:hover`, `:active`, etc.)
2. **Dimensional variants** — style diffs that map to component props (`size="large"`)

### State Name → CSS Selector Mapping

| Variant Value | CSS Selector |
|---|---|
| `Default` | (base styles — no selector) |
| `Hover` / `Hovered` | `:hover:not(:disabled)` |
| `Pressed` / `Active` | `:active:not(:disabled)` |
| `Focus` / `Focused` | `:focus-visible` |
| `Disabled` | `:disabled, [aria-disabled="true"]` |
| `Selected` | `[aria-selected="true"]` |
| `Checked` | `[aria-checked="true"]`, `:checked` |
| `Error` / `Invalid` | `[aria-invalid="true"]` |
| Unknown state name | `[data-state="{name}"]` (generic data attribute) |

### Diffing Algorithm

1. Parse the **default variant** (all state props at their first value, all dimensional props at their first value) → full `ParsedNode` tree
2. For each **state variant** (only state props differ):
   - Parse its node tree → `ParsedNode` tree
   - Walk both trees in parallel, matched by node name. If a node exists in the default tree but not in the variant (or vice versa), skip that node and emit a warning — structural differences between variants are not supported in v1
   - For each matched node, compare `styles` — collect only changed properties
   - Produce a `StateOverride` with the diff
3. For each **dimensional variant** (only dimensional props differ):
   - Same diffing process
   - Produce a `DimensionalVariant` with modifier class name

### Identifying Default Variant

The default variant is the one where ALL variant props are at their first listed value. For multi-dimensional variants (e.g., `Size=Small, State=Default`), the default is the combination where every prop is at its first value.

If a variant explicitly named `Default` exists for a state prop, that takes precedence.

### Multi-Dimensional Variant Handling

For combinations like `Size=Large, State=Hover`:
1. First, diff `Size=Large, State=Default` against `Size=Small, State=Default` → dimensional variant for "large"
2. Then, diff `Size=Large, State=Hover` against `Size=Large, State=Default` → state override for hover *within* the large size
3. If the hover diff is the **same** as `Size=Small, State=Hover` vs `Size=Small, State=Default`, only emit the state override once (shared across sizes)
4. If different, emit size-scoped state overrides (e.g., `.button--large:hover`)

---

## Composition Resolver

### Purpose

Detects nested component instances, builds a dependency graph, and determines generation order.

### Detection

While walking the node tree, when `node.type === "INSTANCE"`:
1. Read `node.componentId` — this is the node ID of the source component
2. Look up in the known components map (built from `fetchComponentsWithProps()` results)
3. If found → create a `ComponentReference` with the component name and overridden props
4. If not found (external library component) → treat the instance's node tree as regular nodes (inline rendering)

### Instance Override Extraction

Figma instances can override:
- **Text content** — `node.characters` differs from source component
- **Fills/strokes** — visual property overrides
- **Variant props** — if the instance points to a different variant of the same component set

For v1, we extract:
- Text content overrides → passed as string props
- Variant property overrides → passed as enum props (e.g., `<Button size="large" />`)

Visual property overrides (fill overrides on instances) are deferred to v2.

### Dependency Graph

Build a DAG (directed acyclic graph) of component dependencies:
```
Card → Button (Card contains a Button instance)
Dialog → Card, Button (Dialog contains both)
```

**Topological sort** determines generation order: Button first, then Card, then Dialog.

**Circular dependency protection:** If component A contains an instance of B and B contains an instance of A, break the cycle at depth 3 (render the deeper instance as inline nodes with a TODO comment).

### Depth Limit

Component instance resolution is limited to **3 levels deep**. Beyond that, the instance is rendered as its visual node tree (flattened) rather than as a component reference. This prevents unbounded recursion and keeps generated code manageable.

---

## Code Emitters

Each emitter takes a `ComponentIR` and produces file content. All emitters share these behaviors:
- Props interface generated from `ComponentIR.props`
- Default values from the first variant value
- Dependencies emitted as import statements
- Component description as a JSDoc comment

### React + Tailwind (`react-tailwind`)

**Output:** Single `.tsx` file per component.

Converts `ParsedStyles` to Tailwind classes:
- Standard Tailwind utilities where exact matches exist (e.g., `flex`, `items-center`, `gap-2`)
- Arbitrary value syntax for token references: `bg-[var(--primary-500)]`, `rounded-[var(--radius-md)]`
- Arbitrary values for literals: `text-[14px]`, `tracking-[0.5px]`

State overrides use Tailwind modifiers: `hover:bg-[var(--primary-600)]`, `disabled:opacity-50`.

Dimensional variants use a `cn()` helper (assumed to exist, like `clsx` or `tailwind-merge`):
```tsx
className={cn("base-classes", size === "large" && "large-classes")}
```

### React + CSS Modules (`react-css`)

**Output:** Two files per component: `{Name}.tsx` + `{Name}.module.css`.

The `.tsx` file imports styles and applies class names. The `.module.css` file contains all styles with:
- Base class (`.button`)
- State selectors (`.button:hover`)
- Dimensional modifier classes (`.small`, `.large`)

CSS values reference design tokens as `var(--token-name)`.

### React Native (`react-native`)

**Output:** Single `.tsx` file per component.

Key differences from web emitters:
- Uses `StyleSheet.create()` for all styles
- All values are **literals** (resolved from variables, not CSS variables — React Native doesn't support them)
- Layout uses React Native's flexbox (default `flexDirection: "column"`, no `display: flex` needed)
- `Pressable` for interactive components (with `style` function for press states)
- `View` for containers, `Text` for text, `Image` for images
- Shadows use React Native's `shadowColor/Offset/Opacity/Radius` on iOS, `elevation` on Android
- No `:hover` — state handling via `Pressable`'s `pressed` and `focused` callbacks
- Border radius uses individual properties (`borderTopLeftRadius`, etc.)
- Units are unitless numbers (not `px`)

### HTML + CSS (`html-css`)

**Output:** Two files per component: `{name}.css` + `{name}.html` (usage example).

BEM naming convention:
- Block: `.button`
- Modifier: `.button--large`
- Element: `.button__icon`, `.button__label`

The HTML file is a usage example, not a template. The CSS file is the primary output.

---

## Return Format

```typescript
{
  components: Array<{
    componentName: string;       // PascalCase name
    figmaName: string;           // Original Figma name
    figmaUrl: string;            // Deep link to Figma
    files: Array<{
      path: string;              // e.g., "src/components/Button/Button.tsx"
      content: string;           // Full file content
      description: string;       // e.g., "React component with Tailwind classes"
    }>;
    props: ComponentPropIR[];    // For reference
    dependencies: string[];      // Components this one imports
    warnings: string[];          // e.g., "Vector node 'icon' skipped — use export_assets"
  }>;
  summary: {
    total: number;
    framework: string;
    totalFiles: number;
    outputDir: string;
    generationOrder: string[];   // Topological order
    warnings: string[];          // Global warnings
  }
}
```

---

## Error Handling

- **Component not found**: If `component_names` includes a name not in the file → skip with warning, generate the rest.
- **Node fetch fails**: If `getNodes()` fails for a component → skip that component, include error in warnings.
- **Variable not found**: If a `boundVariables` reference points to a variable not in the response → emit literal value with `/* unresolved variable */` comment.
- **Unsupported node type**: Vector, boolean, star, line, ellipse → skip with `/* TODO */` comment in generated code, warning in output.
- **Circular dependencies**: Break at depth 3, render inline, add warning.
- Each component fails independently — partial output is better than no output.

---

## v1 Scope

### Included

- Auto-layout → flexbox (horizontal, vertical, wrap)
- Solid fills with variable binding → `background` / `color`
- Linear gradients → `linear-gradient()`
- Full typography (font-family, size, weight, line-height, letter-spacing, align, transform, decoration)
- Effects: drop shadow, inner shadow, layer blur, background blur
- Borders/strokes (uniform and per-side)
- Corner radius (uniform and per-corner)
- Opacity
- Padding (uniform and per-side), gap, min/max constraints
- State variants → CSS pseudo-classes
- Dimensional variants → prop-driven modifier classes
- Nested component instances (depth 3)
- Text nodes → string props with defaults
- All 4 framework emitters
- Topological sort for generation order
- Storybook generation (optional, reuses existing templates)

### Deferred (v2+)

| Feature | Reason |
|---|---|
| Absolute positioning / constraints | Rare in design systems, complex to map |
| Vector/boolean shapes → inline SVG | Complex path data; use `export_assets` |
| Image fills | Needs asset hosting; reference `export_assets` |
| Blend modes (`mix-blend-mode`) | Niche, low ROI |
| Figma prototyping interactions | Not available via REST API |
| Responsive breakpoints | Figma doesn't model breakpoints |
| Animation / transitions | Not in Figma's static data |
| Instance visual property overrides | Complex diffing; text + variant overrides sufficient for v1 |

For deferred features, the parser emits a TODO comment in generated code:
```css
/* TODO: Vector node "icon" — use export_assets tool to export as SVG */
```

---

## Annotations

`readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true`

---

## Registration

```typescript
registerGenerateCodedComponents(server, figmaClient);
```

No `dsCache` or `githubClient` needed — purely Figma → code.

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
  const colorResolved = (strokeBinding && resolver.resolveBinding(strokeBinding))
    ?? resolver.resolveColor(stroke.color);

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
    const fontSizeResolved = fontSizeBinding && resolver.resolveBinding(fontSizeBinding);
    if (fontSizeResolved) {
      styles.fontSize = fontSizeResolved.css;
    } else if (ts.fontSize) {
      styles.fontSize = `${ts.fontSize}px`;
    }

    if (ts.fontWeight) {
      styles.fontWeight = String(ts.fontWeight);
    }

    if (ts.lineHeightPx) {
      const lhBinding = getBoundVar(bound, "lineHeight");
      const lhResolved = lhBinding && resolver.resolveBinding(lhBinding);
      if (lhResolved) {
        styles.lineHeight = lhResolved.css;
      } else {
        // Use unitless ratio when possible
        const ratio = ts.fontSize ? ts.lineHeightPx / ts.fontSize : undefined;
        styles.lineHeight = ratio ? String(Math.round(ratio * 100) / 100) : `${ts.lineHeightPx}px`;
      }
    }

    if (ts.letterSpacing) {
      const lsBinding = getBoundVar(bound, "letterSpacing");
      const lsResolved = lsBinding && resolver.resolveBinding(lsBinding);
      if (lsResolved) {
        styles.letterSpacing = lsResolved.css;
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
  const fontSizeBinding2 = getBoundVar(bound, "fontSize");
  if (fontSizeBinding2) {
    const resolved = resolver.resolveBinding(fontSizeBinding2);
    if (resolved) resolvedValues.set("fontSize", resolved);
  }
  const lhBinding2 = getBoundVar(bound, "lineHeight");
  if (lhBinding2) {
    const resolved = resolver.resolveBinding(lhBinding2);
    if (resolved) resolvedValues.set("lineHeight", resolved);
  }
  const lsBinding2 = getBoundVar(bound, "letterSpacing");
  if (lsBinding2) {
    const resolved = resolver.resolveBinding(lsBinding2);
    if (resolved) resolvedValues.set("letterSpacing", resolved);
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

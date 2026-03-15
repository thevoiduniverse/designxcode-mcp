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

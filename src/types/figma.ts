/**
 * Figma API response types for Variables, Components, and Styles.
 * Based on the Figma REST API v1.
 */

export interface FigmaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export type FigmaVariableResolvedType = "BOOLEAN" | "FLOAT" | "STRING" | "COLOR";

export interface FigmaVariableValue {
  type?: string;
  value?: unknown;
}

export interface FigmaVariableAlias {
  type: "VARIABLE_ALIAS";
  id: string;
}

export type FigmaResolvedValue = boolean | number | string | FigmaColor;
export type FigmaVariableValueOrAlias = FigmaResolvedValue | FigmaVariableAlias;

export interface FigmaVariable {
  id: string;
  name: string;
  key: string;
  variableCollectionId: string;
  resolvedType: FigmaVariableResolvedType;
  description: string;
  hiddenFromPublishing: boolean;
  scopes: string[];
  codeSyntax: Record<string, string>;
  valuesByMode: Record<string, FigmaVariableValueOrAlias>;
}

export interface FigmaVariableMode {
  modeId: string;
  name: string;
}

export interface FigmaVariableCollection {
  id: string;
  name: string;
  key: string;
  modes: FigmaVariableMode[];
  defaultModeId: string;
  remote: boolean;
  hiddenFromPublishing: boolean;
  variableIds: string[];
}

export interface FigmaLocalVariablesResponse {
  status: number;
  error: boolean;
  meta: {
    variables: Record<string, FigmaVariable>;
    variableCollections: Record<string, FigmaVariableCollection>;
  };
}

export interface FigmaPublishedVariablesResponse {
  status: number;
  error: boolean;
  meta: {
    variables: Record<string, FigmaVariable>;
    variableCollections: Record<string, FigmaVariableCollection>;
  };
}

/** Component as returned by GET /files/:key (keyed by nodeId) */
export interface FigmaComponent {
  key: string;
  name: string;
  description: string;
  componentSetId?: string;
  documentationLinks: Array<{ uri: string }>;
  remote: boolean;
  containing_frame?: {
    name: string;
    nodeId: string;
    pageName: string;
  };
}

/** Component set as returned by GET /files/:key (keyed by nodeId) */
export interface FigmaComponentSet {
  key: string;
  name: string;
  description: string;
  documentationLinks: Array<{ uri: string }>;
  remote: boolean;
  containing_frame?: {
    name: string;
    nodeId: string;
    pageName: string;
  };
}

/** Component as returned by GET /files/:key/components (array items) */
export interface FigmaComponentListItem {
  key: string;
  file_key: string;
  node_id: string;
  name: string;
  description: string;
  containing_frame: {
    name: string;
    nodeId: string;
    pageId: string;
    pageName: string;
    backgroundColor?: string;
    containingComponentSet?: {
      name: string;
      nodeId: string;
    };
  };
}

/** Response from GET /files/:key/components */
export interface FigmaFileComponentsResponse {
  status: number;
  error: boolean;
  meta: {
    components: FigmaComponentListItem[];
  };
}

/** Style as returned by GET /files/:key (keyed by nodeId) */
export interface FigmaStyle {
  key: string;
  name: string;
  description: string;
  remote: boolean;
  styleType: "FILL" | "TEXT" | "EFFECT" | "GRID";
}

/** Style as returned by GET /files/:key/styles (array items) */
export interface FigmaStyleListItem {
  key: string;
  file_key: string;
  node_id: string;
  style_type: "FILL" | "TEXT" | "EFFECT" | "GRID";
  name: string;
  description: string;
}

/** Response from GET /files/:key/styles */
export interface FigmaFileStylesResponse {
  status: number;
  error: boolean;
  meta: {
    styles: FigmaStyleListItem[];
  };
}

/** A node in the Figma document tree (simplified for component discovery) */
export interface FigmaNode {
  id: string;
  name: string;
  type: string;
  children?: FigmaNode[];
}

/** Response from GET /files/:key (subset of fields we need) */
export interface FigmaFileResponse {
  name: string;
  document: FigmaNode;
  components: Record<string, FigmaComponent>;
  componentSets: Record<string, FigmaComponentSet>;
}

// ─── Detailed node types (for style extraction + asset export) ───

export interface FigmaPaint {
  type: "SOLID" | "GRADIENT_LINEAR" | "GRADIENT_RADIAL" | "GRADIENT_ANGULAR" | "GRADIENT_DIAMOND" | "IMAGE" | "EMOJI";
  visible?: boolean;
  opacity?: number;
  color?: FigmaColor;
  gradientStops?: Array<{ position: number; color: FigmaColor }>;
  gradientHandlePositions?: Array<{ x: number; y: number }>;
  blendMode?: string;
  scaleMode?: string;
}

export interface FigmaTypeStyle {
  fontFamily: string;
  fontPostScriptName?: string;
  fontWeight: number;
  fontSize: number;
  textAlignHorizontal?: string;
  textAlignVertical?: string;
  letterSpacing: number;
  lineHeightPx?: number;
  lineHeightPercent?: number;
  lineHeightUnit?: "PIXELS" | "FONT_SIZE_%" | "INTRINSIC";
  textDecoration?: "NONE" | "UNDERLINE" | "STRIKETHROUGH";
  textCase?: "ORIGINAL" | "UPPER" | "LOWER" | "TITLE";
  italic?: boolean;
}

export interface FigmaEffect {
  type: "DROP_SHADOW" | "INNER_SHADOW" | "LAYER_BLUR" | "BACKGROUND_BLUR";
  visible?: boolean;
  radius: number;
  color?: FigmaColor;
  offset?: { x: number; y: number };
  spread?: number;
  blendMode?: string;
}

export interface FigmaLayoutGrid {
  pattern: "COLUMNS" | "ROWS" | "GRID";
  sectionSize: number;
  visible?: boolean;
  color?: FigmaColor;
  alignment?: "MIN" | "MAX" | "CENTER" | "STRETCH";
  gutterSize?: number;
  offset?: number;
  count?: number;
}

/** A node with full properties (from GET /files/:key/nodes) */
export interface FigmaDetailedNode {
  id: string;
  name: string;
  type: string;
  fills?: FigmaPaint[];
  strokes?: FigmaPaint[];
  effects?: FigmaEffect[];
  style?: FigmaTypeStyle;
  layoutGrids?: FigmaLayoutGrid[];
  children?: FigmaDetailedNode[];
  styles?: Record<string, string>;

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
}

/** Response from GET /files/:key/nodes?ids=... */
export interface FigmaFileNodesResponse {
  name: string;
  nodes: Record<string, { document: FigmaDetailedNode } | null>;
}

/** Response from GET /images/:key?ids=...&format=... */
export interface FigmaImagesResponse {
  err: string | null;
  images: Record<string, string | null>;
}

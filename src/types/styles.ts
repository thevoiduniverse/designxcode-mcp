/**
 * Types for extracted Figma styles (fill, text, effect, grid).
 */

export interface FillStyleProperties {
  fills: Array<{
    type: string;
    color?: string;
    opacity?: number;
    gradientStops?: Array<{ position: number; color: string }>;
  }>;
}

export interface TextStyleProperties {
  fontFamily: string;
  fontWeight: number;
  fontSize: number;
  lineHeight?: number;
  lineHeightUnit?: string;
  letterSpacing: number;
  textDecoration?: string;
  textCase?: string;
}

export interface EffectStyleProperties {
  effects: Array<{
    type: string;
    color?: string;
    offset?: { x: number; y: number };
    radius: number;
    spread?: number;
  }>;
}

export interface GridStyleProperties {
  grids: Array<{
    pattern: string;
    sectionSize: number;
    gutterSize?: number;
    offset?: number;
    count?: number;
    alignment?: string;
  }>;
}

export type StyleProperties =
  | FillStyleProperties
  | TextStyleProperties
  | EffectStyleProperties
  | GridStyleProperties;

export interface ExtractedStyle {
  name: string;
  key: string;
  styleType: "FILL" | "TEXT" | "EFFECT" | "GRID";
  description: string;
  nodeId: string;
  properties: StyleProperties;
}

/**
 * W3C Design Token Community Group format types
 * and Style Dictionary input format types.
 */

/** W3C DTCG token types */
export type W3CTokenType =
  | "color"
  | "dimension"
  | "fontFamily"
  | "fontWeight"
  | "duration"
  | "cubicBezier"
  | "number"
  | "string"
  | "boolean"
  | "strokeStyle"
  | "border"
  | "transition"
  | "shadow"
  | "gradient"
  | "typography";

/** A single W3C design token */
export interface W3CToken {
  $value: string | number | boolean | Record<string, unknown>;
  $type?: W3CTokenType;
  $description?: string;
  $extensions?: Record<string, unknown>;
}

/** A group of tokens or nested groups */
export interface W3CTokenGroup {
  $type?: W3CTokenType;
  $description?: string;
  [key: string]: W3CToken | W3CTokenGroup | W3CTokenType | string | undefined;
}

/** Top-level W3C token file */
export type W3CTokenFile = W3CTokenGroup;

/** Style Dictionary token format */
export interface SDToken {
  value: string | number | boolean | Record<string, unknown>;
  type?: string;
  description?: string;
  original?: {
    value: string | number | boolean | Record<string, unknown>;
  };
  name?: string;
  path?: string[];
  attributes?: Record<string, unknown>;
}

/** Style Dictionary token group */
export interface SDTokenGroup {
  [key: string]: SDToken | SDTokenGroup;
}

/** Supported output platforms for Style Dictionary */
export type SDPlatform = "css" | "scss" | "tailwind" | "swift" | "kotlin" | "json";

/** Result of a Style Dictionary transform */
export interface SDTransformResult {
  platform: SDPlatform;
  fileName: string;
  content: string;
}

/** Token extraction output format */
export type TokenOutputFormat = "w3c" | "style-dictionary" | "raw";

/** Token summary stats */
export interface TokenStats {
  total: number;
  byType: Record<string, number>;
  byCollection: Record<string, number>;
}

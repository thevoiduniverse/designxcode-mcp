/**
 * Token Matcher — walks a ParsedNode tree and matches visual properties
 * against design system tokens for O(1) lookup.
 */

import * as fs from "fs";
import * as path from "path";
import type { ParsedNode, ParsedStyles, ResolvedValue } from "../types/node-ir.js";
import type { VariableResolver } from "./variable-resolver.js";

// ─── Public Types ───

export interface TokenRef {
  name: string;
  path: string[];
  type: string;
}

export interface StyleRef {
  name: string;
  family: string;
  size: number;
  weight: number;
}

export interface TokenMatchRecord {
  property: string;
  figmaValue: string;
  tokenName: string | null;
  status: "matched" | "unmatched";
  matchType: "variable-binding" | "exact-value" | null;
  nearest: { name: string; value: string } | null;
}

// ─── Index Builders ───

/**
 * Build a Map<normalizedValue, TokenRef> from Figma variables for O(1) lookup.
 * Keys: lowercase hex (e.g., "#d51e8c"), px strings (e.g., "16px"), raw numbers.
 */
export function buildTokensByValue(
  variables: Record<string, { id: string; name: string; resolvedType: string; valuesByMode: Record<string, unknown> }>
): Map<string, TokenRef> {
  const map = new Map<string, TokenRef>();

  for (const variable of Object.values(variables)) {
    const value = Object.values(variable.valuesByMode)[0];
    if (value === undefined || value === null) continue;
    // Skip alias values
    if (typeof value === "object" && value !== null && "type" in value && (value as { type: string }).type === "VARIABLE_ALIAS") continue;

    const path = variable.name.split("/");
    const ref: TokenRef = { name: variable.name, path, type: variable.resolvedType };

    if (variable.resolvedType === "COLOR" && typeof value === "object" && value !== null && "r" in value) {
      const c = value as { r: number; g: number; b: number; a: number };
      const hex = rgbaToHex(c.r, c.g, c.b, c.a);
      map.set(hex, ref);
    } else if (typeof value === "number") {
      map.set(`${value}px`, ref);
      map.set(String(value), ref);
    } else if (typeof value === "string") {
      map.set(value.toLowerCase(), ref);
    }
  }

  return map;
}

/**
 * Build a Map<"family|size|weight", StyleRef> for typography matching.
 */
export function buildStylesBySignature(
  variables: Record<string, { id: string; name: string; resolvedType: string; valuesByMode: Record<string, unknown> }>
): Map<string, StyleRef> {
  // Typography styles aren't directly available as variables — this is a placeholder
  // that returns an empty map. Real typography matching happens via textStyleId or
  // by matching individual font properties against tokens.
  return new Map<string, StyleRef>();
}

// ─── Token Matching ───

/**
 * Walk a ParsedNode tree, match visual properties against design system tokens.
 * Returns a new tree with token references and a list of match records.
 */
export function matchTokens(
  tree: ParsedNode,
  resolver: VariableResolver,
  tokensByValue: Map<string, TokenRef>,
  stylesBySignature: Map<string, StyleRef>,
): { tree: ParsedNode; records: TokenMatchRecord[] } {
  const records: TokenMatchRecord[] = [];
  const newTree = walkAndMatch(tree, tokensByValue, records);
  return { tree: newTree, records };
}

// ─── Internal Tree Walker ───

function walkAndMatch(
  node: ParsedNode,
  tokensByValue: Map<string, TokenRef>,
  records: TokenMatchRecord[],
): ParsedNode {
  const newStyles = { ...node.styles };
  const newResolvedValues = new Map(node.resolvedValues);

  // Match each style property
  const propsToMatch: Array<{ prop: string; category: "color" | "spacing" | "typography" | "shadow" }> = [
    // Colors
    { prop: "background", category: "color" },
    { prop: "color", category: "color" },
    // Spacing
    { prop: "gap", category: "spacing" },
    { prop: "rowGap", category: "spacing" },
    { prop: "columnGap", category: "spacing" },
    { prop: "padding", category: "spacing" },
    { prop: "paddingTop", category: "spacing" },
    { prop: "paddingRight", category: "spacing" },
    { prop: "paddingBottom", category: "spacing" },
    { prop: "paddingLeft", category: "spacing" },
    { prop: "borderRadius", category: "spacing" },
    // Typography
    { prop: "fontSize", category: "typography" },
    { prop: "fontWeight", category: "typography" },
    { prop: "lineHeight", category: "typography" },
    { prop: "letterSpacing", category: "typography" },
    // Shadows
    { prop: "boxShadow", category: "shadow" },
  ];

  for (const { prop, category } of propsToMatch) {
    const value = node.styles[prop];
    if (!value) continue;

    // Already bound via VariableResolver — record as matched
    const existing = node.resolvedValues.get(prop);
    if (existing?.isBound && existing.tokenName) {
      records.push({
        property: prop,
        figmaValue: existing.literal || value,
        tokenName: existing.tokenName,
        status: "matched",
        matchType: "variable-binding",
        nearest: null,
      });
      continue;
    }

    // Try exact value match in tokensByValue
    const normalizedValue = normalizeValue(value, category);
    const tokenRef = tokensByValue.get(normalizedValue);

    if (tokenRef) {
      const tokenCssName = tokenRef.name.split("/").join("-").toLowerCase();
      const cssVar = `var(--${tokenCssName})`;
      newStyles[prop] = cssVar;
      newResolvedValues.set(prop, {
        css: cssVar,
        isBound: true,
        tokenName: tokenCssName,
        literal: value,
      });
      records.push({
        property: prop,
        figmaValue: value,
        tokenName: tokenRef.name,
        status: "matched",
        matchType: "exact-value",
        nearest: null,
      });
    } else {
      // No match — find nearest for the report
      const nearest = findNearest(value, category, tokensByValue);
      records.push({
        property: prop,
        figmaValue: value,
        tokenName: null,
        status: "unmatched",
        matchType: null,
        nearest,
      });
    }
  }

  // Recurse into children
  const newChildren = node.children.map((child) => walkAndMatch(child, tokensByValue, records));

  return {
    ...node,
    styles: newStyles,
    resolvedValues: newResolvedValues,
    children: newChildren,
  };
}

// ─── Helpers ───

function normalizeValue(value: string, category: string): string {
  if (category === "color") {
    // Normalize hex to lowercase 6-digit
    return value.toLowerCase().trim();
  }
  return value.toLowerCase().trim();
}

function findNearest(
  value: string,
  category: string,
  tokensByValue: Map<string, TokenRef>,
): { name: string; value: string } | null {
  if (category === "color") {
    return findNearestColor(value, tokensByValue);
  }
  if (category === "spacing" || category === "typography") {
    return findNearestNumeric(value, tokensByValue);
  }
  return null;
}

function findNearestColor(
  hex: string,
  tokensByValue: Map<string, TokenRef>,
): { name: string; value: string } | null {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;

  let bestDist = Infinity;
  let bestName = "";
  let bestValue = "";

  for (const [key, ref] of tokensByValue) {
    if (!key.startsWith("#")) continue;
    const candidate = hexToRgb(key);
    if (!candidate) continue;
    const dist = Math.sqrt(
      (rgb.r - candidate.r) ** 2 +
      (rgb.g - candidate.g) ** 2 +
      (rgb.b - candidate.b) ** 2
    );
    if (dist < bestDist) {
      bestDist = dist;
      bestName = ref.name;
      bestValue = key;
    }
  }

  return bestDist < Infinity ? { name: bestName, value: bestValue } : null;
}

function findNearestNumeric(
  value: string,
  tokensByValue: Map<string, TokenRef>,
): { name: string; value: string } | null {
  const num = parseFloat(value);
  if (isNaN(num)) return null;

  let bestDist = Infinity;
  let bestName = "";
  let bestValue = "";

  for (const [key, ref] of tokensByValue) {
    const candidate = parseFloat(key);
    if (isNaN(candidate)) continue;
    const dist = Math.abs(num - candidate);
    if (dist < bestDist) {
      bestDist = dist;
      bestName = ref.name;
      bestValue = key;
    }
  }

  return bestDist < Infinity ? { name: bestName, value: bestValue } : null;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const clean = hex.replace("#", "").toLowerCase();
  if (clean.length < 6) return null;
  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
  return { r, g, b };
}

function rgbaToHex(r: number, g: number, b: number, a: number): string {
  const ri = Math.round(r * 255);
  const gi = Math.round(g * 255);
  const bi = Math.round(b * 255);
  const hex = `#${ri.toString(16).padStart(2, "0")}${gi.toString(16).padStart(2, "0")}${bi.toString(16).padStart(2, "0")}`;
  if (a < 1) {
    const ai = Math.round(a * 255);
    return `${hex}${ai.toString(16).padStart(2, "0")}`;
  }
  return hex;
}

/**
 * Load color tokens from a local .designxcode/tokens.json file.
 * Fallback for Professional plan where Variables API is unavailable.
 * File format: { "colors": { "token-name": "#hex", ... } }
 */
export function loadLocalTokens(map: Map<string, TokenRef>): number {
  const candidates = [
    path.join(process.cwd(), ".designxcode", "tokens.json"),
    path.join(process.cwd(), "tokens.json"),
  ];

  for (const filePath of candidates) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const raw = fs.readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw);
      let count = 0;

      if (data.colors && typeof data.colors === "object") {
        for (const [name, value] of Object.entries(data.colors)) {
          if (typeof value === "string" && value.startsWith("#")) {
            const hex = value.toLowerCase();
            map.set(hex, { name, path: [name], type: "COLOR" });
            count++;
          }
        }
      }

      return count;
    } catch {
      // Ignore parse errors, try next candidate
    }
  }

  return 0;
}

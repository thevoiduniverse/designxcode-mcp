/**
 * Converts Figma Variables into W3C Design Token Community Group format.
 * Handles variable types, collections, modes, and aliases.
 */

import type {
  FigmaVariable,
  FigmaVariableCollection,
  FigmaColor,
  FigmaVariableAlias,
  FigmaResolvedValue,
} from "../types/figma.js";
import type { W3CToken, W3CTokenFile, W3CTokenType, TokenStats } from "../types/tokens.js";

/** Map Figma variable resolved types to W3C token types */
function mapFigmaTypeToW3C(resolvedType: string): W3CTokenType {
  switch (resolvedType) {
    case "COLOR":
      return "color";
    case "FLOAT":
      return "number";
    case "STRING":
      return "string";
    case "BOOLEAN":
      return "boolean";
    default:
      return "string";
  }
}

/** Convert a Figma RGBA color to hex string */
export function figmaColorToHex(color: FigmaColor): string {
  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  const a = color.a;

  if (a < 1) {
    const aHex = Math.round(a * 255)
      .toString(16)
      .padStart(2, "0");
    return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}${aHex}`;
  }
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

/** Resolve a Figma variable value to a primitive */
function resolveValue(
  value: FigmaResolvedValue | FigmaVariableAlias,
  resolvedType: string,
  allVariables: Record<string, FigmaVariable>,
  modeId: string,
  visited: Set<string> = new Set()
): string | number | boolean {
  // Handle alias references
  if (isAlias(value)) {
    const aliasedVar = allVariables[value.id];
    if (!aliasedVar || visited.has(value.id)) {
      return `{unresolved:${value.id}}`;
    }
    visited.add(value.id);
    const aliasValue = aliasedVar.valuesByMode[modeId] ?? Object.values(aliasedVar.valuesByMode)[0];
    if (aliasValue === undefined) {
      return `{unresolved:${value.id}}`;
    }
    return resolveValue(aliasValue, aliasedVar.resolvedType, allVariables, modeId, visited);
  }

  // Resolve based on type
  if (resolvedType === "COLOR" && isColorValue(value)) {
    return figmaColorToHex(value);
  }

  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return value;
  }

  return String(value);
}

function isAlias(value: unknown): value is FigmaVariableAlias {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value as FigmaVariableAlias).type === "VARIABLE_ALIAS"
  );
}

function isColorValue(value: unknown): value is FigmaColor {
  return (
    typeof value === "object" &&
    value !== null &&
    "r" in value &&
    "g" in value &&
    "b" in value &&
    "a" in value
  );
}

/** Sanitize a token name segment for use as a JSON key */
export function sanitizeTokenName(name: string): string {
  return name.replace(/[/]/g, ".").replace(/\s+/g, "-").toLowerCase();
}

/** Convert Figma variable name paths (e.g. "colors/primary/500") into nested token groups */
function setNestedToken(
  obj: W3CTokenFile,
  path: string[],
  token: W3CToken
): void {
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (!(key in current) || typeof current[key] !== "object" || current[key] === null) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[path[path.length - 1]] = token;
}

export interface ConvertOptions {
  /** Only include these collection names (undefined = all) */
  collectionNames?: string[];
}

export interface ConvertResult {
  /** Token file per mode. Key format: "collectionName/modeName" or just "collectionName" if single mode */
  tokenSets: Record<string, W3CTokenFile>;
  stats: TokenStats;
}

/**
 * Convert Figma local variables response into W3C Design Token format.
 */
/** Merge multiple W3C token sets into a single token file */
export function mergeTokenSets(tokenSets: Record<string, W3CTokenFile>): W3CTokenFile {
  const merged: W3CTokenFile = {};
  for (const tokens of Object.values(tokenSets)) {
    deepMergeTokens(merged, tokens);
  }
  return merged;
}

function deepMergeTokens(target: W3CTokenFile, source: W3CTokenFile): void {
  for (const [key, val] of Object.entries(source)) {
    if (
      typeof val === "object" &&
      val !== null &&
      !("$value" in val) &&
      typeof target[key] === "object" &&
      target[key] !== null
    ) {
      deepMergeTokens(target[key] as W3CTokenFile, val as W3CTokenFile);
    } else {
      target[key] = val;
    }
  }
}

export function figmaVariablesToW3C(
  variables: Record<string, FigmaVariable>,
  collections: Record<string, FigmaVariableCollection>,
  options?: ConvertOptions
): ConvertResult {
  const tokenSets: Record<string, W3CTokenFile> = {};
  const stats: TokenStats = { total: 0, byType: {}, byCollection: {} };

  // Filter collections if specified
  const filteredCollections = Object.values(collections).filter((col) => {
    if (options?.collectionNames && options.collectionNames.length > 0) {
      return options.collectionNames.some(
        (name) => col.name.toLowerCase() === name.toLowerCase()
      );
    }
    return true;
  });

  for (const collection of filteredCollections) {
    const collectionKey = sanitizeTokenName(collection.name);

    for (const mode of collection.modes) {
      const setKey =
        collection.modes.length === 1
          ? collectionKey
          : `${collectionKey}/${sanitizeTokenName(mode.name)}`;

      const tokenFile: W3CTokenFile = {};

      for (const varId of collection.variableIds) {
        const variable = variables[varId];
        if (!variable) continue;

        // Skip hidden variables
        if (variable.hiddenFromPublishing) continue;

        const modeValue = variable.valuesByMode[mode.modeId];
        if (modeValue === undefined) continue;

        const resolvedValue = resolveValue(
          modeValue,
          variable.resolvedType,
          variables,
          mode.modeId
        );

        const w3cType = mapFigmaTypeToW3C(variable.resolvedType);
        const token: W3CToken = {
          $value: resolvedValue,
          $type: w3cType,
        };

        if (variable.description) {
          token.$description = variable.description;
        }

        // Split variable name by "/" to create nested groups
        const pathParts = variable.name.split("/").map(sanitizeTokenName);
        setNestedToken(tokenFile, pathParts, token);

        // Update stats
        stats.total++;
        stats.byType[w3cType] = (stats.byType[w3cType] ?? 0) + 1;
        stats.byCollection[collection.name] = (stats.byCollection[collection.name] ?? 0) + 1;
      }

      tokenSets[setKey] = tokenFile;
    }
  }

  return { tokenSets, stats };
}

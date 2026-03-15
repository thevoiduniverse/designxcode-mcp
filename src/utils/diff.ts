/**
 * Token and component diffing utilities.
 * Compares Figma design tokens/components against code to detect drift.
 */

import type { TokenDiffResult, TokenDrift } from "../types/components.js";
import type { FigmaComponentEntry, CodeComponentEntry, ComponentDiffResult, ComponentMapping } from "../types/components.js";
import type { W3CToken, W3CTokenFile } from "../types/tokens.js";

/**
 * Flatten a nested W3C token file into a flat map of path → {value, type}.
 */
function flattenTokens(
  obj: W3CTokenFile,
  parentPath: string[] = []
): Array<{ path: string[]; name: string; value: string | number | boolean; type: string }> {
  const result: Array<{ path: string[]; name: string; value: string | number | boolean; type: string }> = [];

  for (const [key, val] of Object.entries(obj)) {
    if (key.startsWith("$")) continue; // skip group-level $type, $description

    const currentPath = [...parentPath, key];

    if (isW3CToken(val)) {
      const value = typeof val.$value === "object" ? JSON.stringify(val.$value) : val.$value;
      result.push({
        path: currentPath,
        name: currentPath.join("."),
        value: value as string | number | boolean,
        type: val.$type ?? "unknown",
      });
    } else if (typeof val === "object" && val !== null) {
      result.push(...flattenTokens(val as W3CTokenFile, currentPath));
    }
  }

  return result;
}

function isW3CToken(val: unknown): val is W3CToken {
  return typeof val === "object" && val !== null && "$value" in val;
}

/** Normalize a value for comparison (lowercase hex colors, trim strings) */
function normalizeValue(value: string | number | boolean): string {
  if (typeof value === "string") {
    return value.toLowerCase().trim();
  }
  return String(value);
}

/**
 * Compare Figma tokens (W3C format) against code tokens (also W3C format).
 * Compares by resolved value, not alias structure.
 */
export function diffTokens(
  figmaTokens: W3CTokenFile,
  codeTokens: W3CTokenFile
): TokenDiffResult {
  const figmaFlat = flattenTokens(figmaTokens);
  const codeFlat = flattenTokens(codeTokens);

  const figmaMap = new Map(figmaFlat.map((t) => [t.name, t]));
  const codeMap = new Map(codeFlat.map((t) => [t.name, t]));

  const added: TokenDiffResult["added"] = [];
  const removed: TokenDiffResult["removed"] = [];
  const changed: TokenDrift[] = [];
  let unchanged = 0;

  // Find added (in Figma, not in code) and changed tokens
  for (const [name, figmaToken] of figmaMap) {
    const codeToken = codeMap.get(name);
    if (!codeToken) {
      added.push({
        name,
        path: figmaToken.path,
        value: figmaToken.value,
        type: figmaToken.type,
      });
    } else if (normalizeValue(figmaToken.value) !== normalizeValue(codeToken.value)) {
      changed.push({
        tokenName: name,
        tokenPath: figmaToken.path,
        figmaValue: figmaToken.value,
        codeValue: codeToken.value,
        type: figmaToken.type,
      });
    } else {
      unchanged++;
    }
  }

  // Find removed (in code, not in Figma)
  for (const [name, codeToken] of codeMap) {
    if (!figmaMap.has(name)) {
      removed.push({
        name,
        path: codeToken.path,
        value: codeToken.value,
        type: codeToken.type,
      });
    }
  }

  return {
    added,
    removed,
    changed,
    summary: {
      totalFigma: figmaFlat.length,
      totalCode: codeFlat.length,
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      unchanged,
    },
  };
}

/**
 * Normalize a component name for fuzzy matching.
 * Strips spaces, hyphens, underscores, and lowercases.
 */
function normalizeComponentName(name: string): string {
  return name
    .replace(/[-_\s/]+/g, "")
    .toLowerCase();
}

/**
 * Compare Figma components against code components.
 * Uses fuzzy name matching (normalized casing, stripped separators).
 */
export function diffComponents(
  figmaComponents: FigmaComponentEntry[],
  codeComponents: CodeComponentEntry[],
  mappings?: ComponentMapping[]
): ComponentDiffResult {
  // Build lookup from normalized name → component
  const figmaNormMap = new Map<string, FigmaComponentEntry>();
  for (const comp of figmaComponents) {
    figmaNormMap.set(normalizeComponentName(comp.name), comp);
  }

  const codeNormMap = new Map<string, CodeComponentEntry>();
  for (const comp of codeComponents) {
    codeNormMap.set(normalizeComponentName(comp.name), comp);
  }

  // Apply explicit mappings if provided
  const explicitMatches = new Map<string, string>(); // figmaNorm → codeNorm
  if (mappings) {
    for (const mapping of mappings) {
      const fNorm = normalizeComponentName(mapping.figmaName);
      const cNorm = normalizeComponentName(mapping.codeName);
      if (figmaNormMap.has(fNorm) && codeNormMap.has(cNorm)) {
        explicitMatches.set(fNorm, cNorm);
      }
    }
  }

  const matched: ComponentDiffResult["matched"] = [];
  const matchedFigmaKeys = new Set<string>();
  const matchedCodeKeys = new Set<string>();

  // First, apply explicit mappings
  for (const [fNorm, cNorm] of explicitMatches) {
    const figma = figmaNormMap.get(fNorm)!;
    const code = codeNormMap.get(cNorm)!;
    matched.push({ figma, code });
    matchedFigmaKeys.add(fNorm);
    matchedCodeKeys.add(cNorm);
  }

  // Then, fuzzy match remaining — exact normalized match
  for (const [fNorm, figma] of figmaNormMap) {
    if (matchedFigmaKeys.has(fNorm)) continue;

    const code = codeNormMap.get(fNorm);
    if (code && !matchedCodeKeys.has(fNorm)) {
      matched.push({ figma, code });
      matchedFigmaKeys.add(fNorm);
      matchedCodeKeys.add(fNorm);
    }
  }

  // Finally, suffix match: "Primary Button" → "primarybutton" ends with "button" → matches "Button"
  // This handles Figma's common pattern of "Variant ComponentName" naming.
  // Track suffix-matched code keys separately so multiple Figma variants can match one code component
  // while still excluding that code component from missingInFigma.
  const suffixMatchedCodeKeys = new Set<string>();
  for (const [fNorm, figma] of figmaNormMap) {
    if (matchedFigmaKeys.has(fNorm)) continue;

    for (const [cNorm, code] of codeNormMap) {
      if (matchedCodeKeys.has(cNorm)) continue;

      if (fNorm.endsWith(cNorm) || cNorm.endsWith(fNorm)) {
        matched.push({ figma, code });
        matchedFigmaKeys.add(fNorm);
        suffixMatchedCodeKeys.add(cNorm);
        break;
      }
    }
  }

  const missingInCode = figmaComponents.filter(
    (c) => !matchedFigmaKeys.has(normalizeComponentName(c.name))
  );
  const missingInFigma = codeComponents.filter(
    (c) => {
      const norm = normalizeComponentName(c.name);
      return !matchedCodeKeys.has(norm) && !suffixMatchedCodeKeys.has(norm);
    }
  );

  const totalFigma = figmaComponents.length;
  const totalCode = codeComponents.length;
  const matchedCount = matched.length;
  const coveragePercent =
    totalFigma === 0 ? 100 : Math.round((matchedCount / totalFigma) * 100);

  return {
    missingInCode,
    missingInFigma,
    matched,
    summary: {
      totalFigma,
      totalCode,
      matched: matchedCount,
      missingInCode: missingInCode.length,
      missingInFigma: missingInFigma.length,
      coveragePercent,
    },
  };
}

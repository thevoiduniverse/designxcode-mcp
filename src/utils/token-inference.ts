/**
 * Token inference: extract design tokens from published styles + file tree
 * when the Variables API is unavailable (Professional plan fallback).
 *
 * Strategy:
 * 1. Fetch published styles → get semantic token names + types
 * 2. Fetch style nodes → get boundVariables (variable ID links) + resolved values
 * 3. Walk file tree → collect additional variable bindings + resolved values
 * 4. Use mode inference → detect multi-mode (light/dark) values
 * 5. Build W3C DTCG token structure matching the Enterprise API output shape
 */

import type { FigmaClient } from "../clients/figma.js";
import type { FigmaDetailedNode, FigmaColor, FigmaVariableAlias } from "../types/figma.js";
import type { W3CTokenFile, W3CToken, TokenStats } from "../types/tokens.js";
import type { ExtractedStyle, FillStyleProperties, TextStyleProperties, EffectStyleProperties } from "../types/styles.js";
import {
  parseNodeFills,
  parseNodeTextStyle,
  parseNodeEffects,
} from "../utils/style-parsers.js";
import { inferModesFromFileTree } from "./mode-inference.js";

// ─── Types ───

interface InferredToken {
  name: string;
  path: string[];
  type: "color" | "dimension" | "fontFamily" | "fontWeight" | "number" | "shadow" | "typography";
  value: string | number;
  /** If multi-mode, values per mode */
  modeValues?: Record<string, string | number>;
  description?: string;
  /** Source: published style or file tree scan */
  source: "style" | "file-tree";
}

interface InferenceResult {
  tokenSets: Record<string, W3CTokenFile>;
  stats: TokenStats;
  source: "style-inference";
}

// ─── Public API ───

/**
 * Infer tokens from published styles and file tree data.
 * Produces the same shape as `figmaVariablesToW3C` so downstream
 * tools (extract_tokens, sync_tokens_to_code, detect_unused_tokens) work unchanged.
 */
export async function inferTokensFromStyles(
  figmaClient: FigmaClient,
  fileKey: string,
  collectionNames?: string[]
): Promise<InferenceResult> {
  const tokens: InferredToken[] = [];

  // 1. Fetch published styles
  const stylesResponse = await figmaClient.getFileStyles(fileKey);
  // Figma API returns snake_case fields in array format
  const rawStyles: Array<any> =
    Array.isArray(stylesResponse) ? stylesResponse : (stylesResponse as any)?.meta?.styles ?? [];

  // Normalize to consistent shape, filter out entries without node_id
  const styles = rawStyles
    .map((s: any) => ({
      key: s.key ?? "",
      name: s.name ?? "",
      styleType: s.style_type ?? s.styleType ?? "",
      nodeId: s.node_id ?? s.nodeId ?? "",
      description: s.description ?? "",
    }))
    .filter((s) => s.nodeId && s.name);

  // 2. Fetch style nodes to get resolved values
  if (styles.length > 0) {
    const nodeIds = styles.map((s) => s.nodeId);
    // Fetch in batches of 50 to avoid URL length limits
    const batchSize = 50;
    for (let i = 0; i < nodeIds.length; i += batchSize) {
      const batch = nodeIds.slice(i, i + batchSize);
      const nodesResponse = await figmaClient.getNodes(fileKey, batch);

      for (const style of styles.slice(i, i + batchSize)) {
        if (!batch.includes(style.nodeId)) continue;
        const nodeData = nodesResponse.nodes[style.nodeId];
        if (!nodeData) continue;
        const node = nodeData.document as unknown as FigmaDetailedNode;

        // Parse the style name for token path
        const nameParts = style.name.split("/").map((p: string) => p.trim());
        const tokenName = nameParts.join("-").toLowerCase().replace(/\s+/g, "-");
        const tokenPath = nameParts.map((p: string) => p.toLowerCase().replace(/\s+/g, "-"));

        // Filter by collection if specified (use first path segment as collection)
        if (collectionNames && collectionNames.length > 0) {
          const collection = tokenPath[0];
          if (!collectionNames.some((c) => c.toLowerCase() === collection)) continue;
        }

        switch (style.styleType) {
          case "FILL": {
            if (node.fills && node.fills.length > 0) {
              const fill = node.fills[0];
              if (fill.color) {
                tokens.push({
                  name: tokenName,
                  path: tokenPath,
                  type: "color",
                  value: figmaColorToHex(fill.color),
                  description: style.description || undefined,
                  source: "style",
                });
              }
            }
            break;
          }

          case "TEXT": {
            if (node.style) {
              // Font family token
              tokens.push({
                name: `${tokenName}-font-family`,
                path: [...tokenPath, "font-family"],
                type: "fontFamily",
                value: node.style.fontFamily,
                source: "style",
              });
              // Font size token
              tokens.push({
                name: `${tokenName}-font-size`,
                path: [...tokenPath, "font-size"],
                type: "dimension",
                value: `${node.style.fontSize}px`,
                source: "style",
              });
              // Font weight token
              tokens.push({
                name: `${tokenName}-font-weight`,
                path: [...tokenPath, "font-weight"],
                type: "fontWeight",
                value: node.style.fontWeight,
                source: "style",
              });
              // Line height token
              if (node.style.lineHeightPx) {
                tokens.push({
                  name: `${tokenName}-line-height`,
                  path: [...tokenPath, "line-height"],
                  type: "dimension",
                  value: `${Math.round(node.style.lineHeightPx * 100) / 100}px`,
                  source: "style",
                });
              }
              // Letter spacing token
              if (node.style.letterSpacing && node.style.letterSpacing !== 0) {
                tokens.push({
                  name: `${tokenName}-letter-spacing`,
                  path: [...tokenPath, "letter-spacing"],
                  type: "dimension",
                  value: `${node.style.letterSpacing}px`,
                  source: "style",
                });
              }
            }
            break;
          }

          case "EFFECT": {
            if (node.effects && node.effects.length > 0) {
              const effect = node.effects[0];
              if (effect.type === "DROP_SHADOW" || effect.type === "INNER_SHADOW") {
                const x = effect.offset?.x ?? 0;
                const y = effect.offset?.y ?? 0;
                const blur = effect.radius;
                const spread = effect.spread ?? 0;
                const color = effect.color ? figmaColorToHex(effect.color) : "#000000";
                tokens.push({
                  name: tokenName,
                  path: tokenPath,
                  type: "shadow",
                  value: `${x}px ${y}px ${blur}px ${spread}px ${color}`,
                  description: style.description || undefined,
                  source: "style",
                });
              }
            }
            break;
          }
        }
      }
    }
  }

  // 3. Try mode inference to add multi-mode values for color tokens
  try {
    const fileResponse = await figmaClient.getFile(fileKey);
    const modeResult = inferModesFromFileTree(fileResponse.document);

    if (modeResult && modeResult.modes.length >= 2) {
      // Add mode values to existing color tokens where we can match by value
      const defaultMode = modeResult.defaultMode;
      const altModes = modeResult.modes.filter((m) => m !== defaultMode);

      // Build a map of hex value (default mode) → alt mode values
      const defaultTokens = modeResult.themed.get(defaultMode) ?? [];
      const valueMap = new Map<string, Record<string, string>>();

      for (const dt of defaultTokens) {
        const defaultHex = String(dt.value).toLowerCase();
        const modeValues: Record<string, string> = { [defaultMode]: defaultHex };

        for (const altMode of altModes) {
          const altTokens = modeResult.themed.get(altMode) ?? [];
          // Match by token name (same variable)
          const match = altTokens.find((at) => at.name === dt.name);
          if (match) {
            modeValues[altMode] = String(match.value).toLowerCase();
          }
        }

        if (Object.keys(modeValues).length > 1) {
          valueMap.set(defaultHex, modeValues);
        }
      }

      // Attach mode values to our style-derived tokens
      for (const token of tokens) {
        if (token.type === "color") {
          const hex = String(token.value).toLowerCase();
          const modes = valueMap.get(hex);
          if (modes) {
            token.modeValues = modes;
          }
        }
      }
    }
  } catch {
    // Mode inference failed (e.g., no mode frames) — continue without modes
  }

  // 4. Build W3C token sets
  const tokenSets: Record<string, W3CTokenFile> = {};

  // Separate single-mode and multi-mode tokens
  const singleMode = tokens.filter((t) => !t.modeValues);
  const multiMode = tokens.filter((t) => t.modeValues);

  // Single-mode tokens go into a "base" set
  if (singleMode.length > 0) {
    tokenSets["base"] = buildW3CTokenFile(singleMode);
  }

  // Multi-mode tokens go into per-mode sets
  if (multiMode.length > 0) {
    const modes = new Set<string>();
    for (const t of multiMode) {
      for (const mode of Object.keys(t.modeValues!)) {
        modes.add(mode);
      }
    }

    for (const mode of modes) {
      const modeTokens: InferredToken[] = multiMode.map((t) => ({
        ...t,
        value: t.modeValues![mode] ?? t.value,
      }));
      tokenSets[`themed/${mode}`] = buildW3CTokenFile(modeTokens);
    }
  }

  // If no multi-mode, put everything in a single set
  if (Object.keys(tokenSets).length === 0) {
    tokenSets["default"] = buildW3CTokenFile(tokens);
  }

  // 5. Build stats
  const byType: Record<string, number> = {};
  const byCollection: Record<string, number> = {};
  for (const t of tokens) {
    byType[t.type] = (byType[t.type] ?? 0) + 1;
    const collection = t.path[0] ?? "default";
    byCollection[collection] = (byCollection[collection] ?? 0) + 1;
  }

  return {
    tokenSets,
    stats: {
      total: tokens.length,
      byType,
      byCollection,
    },
    source: "style-inference",
  };
}

// ─── Helpers ───

/** Build a W3C token file from flat InferredToken array */
function buildW3CTokenFile(tokens: InferredToken[]): W3CTokenFile {
  const result: W3CTokenFile = {};

  for (const token of tokens) {
    // Navigate/create the nested path
    let current: any = result;
    for (let i = 0; i < token.path.length - 1; i++) {
      const segment = token.path[i];
      if (!current[segment] || typeof current[segment] !== "object" || "$value" in current[segment]) {
        current[segment] = {};
      }
      current = current[segment];
    }

    const leafKey = token.path[token.path.length - 1] ?? token.name;
    const w3cToken: W3CToken = {
      $value: token.value,
      $type: token.type,
    };
    if (token.description) {
      w3cToken.$description = token.description;
    }
    current[leafKey] = w3cToken;
  }

  return result;
}

function figmaColorToHex(color: FigmaColor): string {
  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

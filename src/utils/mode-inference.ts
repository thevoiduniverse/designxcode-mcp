/**
 * Mode inference: detect variable modes (Light/Dark) from resolved values
 * across the file tree — no Variables API required (works on Professional plan).
 *
 * Algorithm:
 * 1. Walk the file tree, collect every (variableId → resolvedColor) pair
 * 2. Group by variableId — if a variable resolves to 2+ distinct colors,
 *    it's a multi-mode variable
 * 3. The most frequent value = default mode, the other = alternate mode
 * 4. Infer mode names from average color luminance (lighter = "light")
 * 5. Build FlatToken arrays compatible with the existing theme formatters
 */

import type { FigmaDetailedNode, FigmaNode, FigmaColor, FigmaVariableAlias } from "../types/figma.js";
import type { FlatToken } from "./context-formatter.js";
import type { ClassifiedTokens } from "./theme-formatters.js";

// ─── Types ───

interface VariableObservation {
  variableId: string;
  color: FigmaColor;
  /** CSS property context where this binding was found */
  cssContext: string;
  /** Name of the Figma node where this binding was found */
  nodeName: string;
}

interface ModeCluster {
  name: string;
  /** variableId → resolved hex color */
  values: Map<string, string>;
  /** Average luminance of all colors in this cluster (0-1) */
  avgLuminance: number;
}

// ─── Public API ───

/**
 * Infer variable modes from a Figma file tree by finding variables
 * that resolve to different colors in different parts of the tree.
 *
 * @param fileTree - The root document node from GET /files/:key
 *                   (typed as FigmaNode but cast to FigmaDetailedNode since
 *                    the actual API response includes fills, boundVariables, etc.)
 * @param publishedStyleNames - Map of style node IDs → style names (for token naming)
 * @returns ClassifiedTokens ready for the theme formatters
 */
export function inferModesFromFileTree(
  fileTree: FigmaNode | FigmaDetailedNode,
  publishedStyleNames?: Map<string, string>
): ClassifiedTokens | null {
  // 1. Walk tree, collect all variable → color observations
  // Cast to FigmaDetailedNode since the actual file API response includes
  // fills, strokes, effects, boundVariables — the FigmaNode type is just underspecified
  const observations: VariableObservation[] = [];
  walkTree(fileTree as FigmaDetailedNode, observations);

  if (observations.length === 0) return null;

  // 2. Group by variableId, find variables with 2+ distinct resolved colors
  const byVariable = new Map<string, Map<string, { color: FigmaColor; count: number; cssContext: string }>>();
  for (const obs of observations) {
    const hex = colorToHex(obs.color);
    if (!byVariable.has(obs.variableId)) byVariable.set(obs.variableId, new Map());
    const valMap = byVariable.get(obs.variableId)!;
    if (!valMap.has(hex)) {
      valMap.set(hex, { color: obs.color, count: 0, cssContext: obs.cssContext });
    }
    valMap.get(hex)!.count++;
  }

  // Filter to multi-mode variables only (2+ distinct values)
  const multiMode = new Map<string, Map<string, { color: FigmaColor; count: number; cssContext: string }>>();
  for (const [varId, valMap] of byVariable) {
    if (valMap.size >= 2) {
      multiMode.set(varId, valMap);
    }
  }

  if (multiMode.size === 0) return null;

  // 3. Cluster into modes
  // For each multi-mode variable, the most frequent value = default, others = alternates
  // Detect how many modes exist by looking at the most common distinct-value count
  const modeCounts = new Map<number, number>();
  for (const valMap of multiMode.values()) {
    const count = valMap.size;
    modeCounts.set(count, (modeCounts.get(count) ?? 0) + 1);
  }
  const numModes = [...modeCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];

  // Build mode clusters
  const clusters: ModeCluster[] = [];
  for (let i = 0; i < numModes; i++) {
    clusters.push({ name: "", values: new Map(), avgLuminance: 0 });
  }

  for (const [varId, valMap] of multiMode) {
    // Sort values by luminance (lightest first) — NOT frequency
    // This ensures the light cluster always gets lighter colors regardless of
    // which mode is more prevalent in the file tree
    const sorted = [...valMap.entries()].sort((a, b) =>
      hexToLuminance(b[0]) - hexToLuminance(a[0])
    );

    // Assign: lightest value → cluster 0 (light), darkest → cluster 1 (dark)
    for (let i = 0; i < Math.min(sorted.length, numModes); i++) {
      const [hex] = sorted[i];
      clusters[i].values.set(varId, hex);
    }
  }

  // 4. Name clusters — cluster 0 has lightest values, cluster 1 has darkest
  if (clusters.length === 2) {
    clusters[0].name = "light";
    clusters[1].name = "dark";
  } else {
    clusters.forEach((c, i) => { c.name = `mode-${i + 1}`; });
  }

  // 5. Build FlatToken arrays
  // Name tokens by variable ID (unique), then deduplicate
  const tokenNamer = buildTokenNamer(observations, publishedStyleNames);

  const themed = new Map<string, FlatToken[]>();
  for (const cluster of clusters) {
    const tokens: FlatToken[] = [];
    const usedNames = new Set<string>();
    for (const [varId, hex] of cluster.values) {
      let name = tokenNamer(varId);
      // Deduplicate: append a suffix if name already used
      if (usedNames.has(name)) {
        let suffix = 2;
        while (usedNames.has(`${name}-${suffix}`)) suffix++;
        name = `${name}-${suffix}`;
      }
      usedNames.add(name);
      // No -- prefix here — the theme formatters add it
      tokens.push({
        name,
        path: name.split("-"),
        value: hex,
        type: "color",
      });
    }
    themed.set(cluster.name, tokens);
  }

  return {
    base: [],  // No single-mode tokens detectable via inference
    themed,
    defaultMode: clusters[0].name,  // Lightest = default (most common convention)
    modes: clusters.map((c) => c.name),
  };
}

// ─── Tree Walker ───

function walkTree(node: FigmaDetailedNode, observations: VariableObservation[]): void {
  const bound = node.boundVariables ?? {};

  // Extract color bindings from fills
  if (node.fills && bound.fills) {
    const fillBindings = Array.isArray(bound.fills) ? bound.fills : [bound.fills];
    for (let i = 0; i < node.fills.length && i < fillBindings.length; i++) {
      const fill = node.fills[i];
      const binding = fillBindings[i] as FigmaVariableAlias | undefined;
      if (fill.color && binding?.id) {
        observations.push({
          variableId: binding.id,
          color: fill.color,
          cssContext: "fill",
          nodeName: node.name,
        });
      }
    }
  }

  // Extract color bindings from strokes
  if (node.strokes && bound.strokes) {
    const strokeBindings = Array.isArray(bound.strokes) ? bound.strokes : [bound.strokes];
    for (let i = 0; i < node.strokes.length && i < strokeBindings.length; i++) {
      const stroke = node.strokes[i];
      const binding = strokeBindings[i] as FigmaVariableAlias | undefined;
      if (stroke.color && binding?.id) {
        observations.push({
          variableId: binding.id,
          color: stroke.color,
          cssContext: "stroke",
          nodeName: node.name,
        });
      }
    }
  }

  // Extract color bindings from effects
  if (node.effects && bound.effects) {
    const effectBindings = Array.isArray(bound.effects) ? bound.effects : [bound.effects];
    for (let i = 0; i < node.effects.length && i < effectBindings.length; i++) {
      const effect = node.effects[i];
      const binding = effectBindings[i] as FigmaVariableAlias | undefined;
      if (effect.color && binding?.id) {
        observations.push({
          variableId: binding.id,
          color: effect.color,
          cssContext: "effect",
          nodeName: node.name,
        });
      }
    }
  }

  // Direct boundVariables on the node (non-array bindings like cornerRadius, padding)
  // These are numeric, not color — skip for theme inference (themes primarily vary by color)

  // Recurse into children
  if (node.children) {
    for (const child of node.children) {
      walkTree(child, observations);
    }
  }
}

// ─── Token Naming ───

function buildTokenNamer(
  observations: VariableObservation[],
  _publishedStyleNames?: Map<string, string>
): (variableId: string) => string {
  // For each variable ID, collect ALL node names where it's used,
  // then pick the best one: shortest, most generic, no variant-style names.
  const candidates = new Map<string, Array<{ name: string; context: string }>>();

  for (const obs of observations) {
    if (!candidates.has(obs.variableId)) candidates.set(obs.variableId, []);
    candidates.get(obs.variableId)!.push({ name: obs.nodeName, context: obs.cssContext });
  }

  const nameMap = new Map<string, string>();

  for (const [varId, entries] of candidates) {
    // Score each candidate name: lower = better
    const scored = entries.map((e) => {
      const sanitized = e.name
        .replace(/[^a-zA-Z0-9\s-_]/g, "")
        .replace(/\s+/g, "-")
        .toLowerCase()
        .replace(/^-+|-+$/g, "");

      let score = sanitized.length; // shorter is better
      // Penalize variant-style names (State=, Size=, Type= patterns)
      if (/state|size=|type=|variant/i.test(e.name)) score += 50;
      // Penalize names with lots of segments (statedefault-sizemd-typeprimary)
      score += (sanitized.match(/-/g) || []).length * 5;
      // Bonus for semantic names
      if (/background|surface|text|primary|secondary|border|accent|foreground|muted/i.test(e.name)) score -= 20;

      return { sanitized, context: e.context, score };
    });

    scored.sort((a, b) => a.score - b.score);
    const best = scored[0];

    if (best.sanitized) {
      const suffix = best.context !== "fill" ? `-${best.context}` : "";
      nameMap.set(varId, `${best.sanitized}${suffix}`);
    } else {
      const parts = varId.split(":");
      nameMap.set(varId, `color-${parts[parts.length - 1]}`);
    }
  }

  return (variableId: string): string => {
    return nameMap.get(variableId) ?? `color-${variableId.split(":").pop()}`;
  };
}

// ─── Color Utilities ───

function colorToHex(color: FigmaColor): string {
  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

/** Relative luminance (0 = black, 1 = white) per WCAG formula */
function hexToLuminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;

  const linearize = (c: number) => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);

  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

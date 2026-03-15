/**
 * Pattern inference engine — analyzes Figma layouts to detect
 * recurring design patterns (spacing, color usage, typography, effects).
 */

import type { FigmaClient } from "../clients/figma.js";
import type { FigmaDetailedNode } from "../types/figma.js";
import type { PatternGroup } from "./context-formatter.js";
import { figmaColorToHex } from "./w3c-tokens.js";

/** An observation from a single node in a single frame */
interface Observation {
  category: "spacing" | "color" | "typography" | "effect" | "composition";
  context: string;       // What was observed on (e.g., "FRAME", "COMPONENT", "TEXT")
  property: string;      // What property (e.g., "paddingLeft", "fill", "fontSize")
  value: string;         // The raw value (e.g., "24", "#6366F1", "Inter/16/500")
  frameId: string;       // Which frame this was observed in
}

/** An aggregated pattern with frequency data */
interface AggregatedPattern {
  category: string;
  description: string;
  count: number;
  frameCount: number;
}

const MAX_FRAMES = 15;

/**
 * Run the full pattern inference pipeline on a Figma file.
 * Returns pattern groups formatted for the context formatter.
 */
export async function inferPatterns(
  figmaClient: FigmaClient,
  fileKey: string,
  tokenMap?: Map<string, string>  // raw value → token name mapping
): Promise<PatternGroup[]> {
  // 1. Fetch published styles as authoritative source
  const styleObservations = await collectStyleObservations(figmaClient, fileKey);

  // 2. Sample component nodes for usage patterns
  const frameIds = await sampleFrames(figmaClient, fileKey);
  const allObservations: Observation[] = [...styleObservations];

  if (frameIds.length > 0) {
    // 3. Fetch detailed nodes
    const BATCH_SIZE = 50;

    for (let i = 0; i < frameIds.length; i += BATCH_SIZE) {
      const batch = frameIds.slice(i, i + BATCH_SIZE);
      try {
        const nodesResponse = await figmaClient.getNodes(fileKey, batch);
        for (const [frameId, nodeData] of Object.entries(nodesResponse.nodes)) {
          if (!nodeData) continue;
          collectObservations(nodeData.document, frameId, allObservations);
        }
      } catch {
        // If getNodes fails for a batch, skip it — partial results are fine
        continue;
      }
    }
  }

  if (allObservations.length === 0) {
    return [];
  }

  // 4. Aggregate observations
  const patterns = aggregateObservations(allObservations, Math.max(frameIds.length, 1));

  // 5. Map values to tokens
  const mappedPatterns = patterns.map((p) => ({
    ...p,
    description: mapToTokens(p.description, tokenMap),
  }));

  // 6. Group by category
  return groupPatterns(mappedPatterns);
}

/**
 * Collect observations from published Figma styles.
 * These are authoritative — they represent intentional design decisions,
 * not incidental usage in documentation frames.
 */
async function collectStyleObservations(
  figmaClient: FigmaClient,
  fileKey: string
): Promise<Observation[]> {
  const observations: Observation[] = [];

  try {
    const stylesResponse = await figmaClient.getFileStyles(fileKey);
    const styles = stylesResponse.meta.styles;

    if (!Array.isArray(styles) || styles.length === 0) return observations;

    // Fetch the actual node data for each style to get resolved values
    const nodeIds = styles.map((s: { node_id: string }) => s.node_id);
    const BATCH_SIZE = 50;

    for (let i = 0; i < nodeIds.length; i += BATCH_SIZE) {
      const batch = nodeIds.slice(i, i + BATCH_SIZE);
      try {
        const nodesResponse = await figmaClient.getNodes(fileKey, batch);

        for (const style of styles) {
          const nodeData = nodesResponse.nodes[style.node_id];
          if (!nodeData) continue;
          const node = nodeData.document;
          const styleType = style.style_type;

          // Give published styles high weight by adding multiple observations
          const STYLE_WEIGHT = 10;

          if (styleType === "TEXT" && node.style) {
            const s = node.style;
            for (let w = 0; w < STYLE_WEIGHT; w++) {
              observations.push({
                category: "typography",
                context: "TEXT",
                property: "font",
                value: `${s.fontFamily}/${s.fontSize}/${s.fontWeight}`,
                frameId: `style:${style.node_id}`,
              });
            }
          }

          if (styleType === "FILL" && node.fills) {
            for (const fill of node.fills) {
              if (fill.visible === false || fill.type !== "SOLID" || !fill.color) continue;
              const hex = figmaColorToHex(fill.color);
              for (let w = 0; w < STYLE_WEIGHT; w++) {
                observations.push({
                  category: "color",
                  context: "background",
                  property: "fill",
                  value: hex,
                  frameId: `style:${style.node_id}`,
                });
              }
            }
          }

          if (styleType === "EFFECT" && node.effects) {
            for (const effect of node.effects) {
              if (effect.visible === false) continue;
              if (effect.type === "DROP_SHADOW" || effect.type === "INNER_SHADOW") {
                const x = effect.offset?.x ?? 0;
                const y = effect.offset?.y ?? 0;
                for (let w = 0; w < STYLE_WEIGHT; w++) {
                  observations.push({
                    category: "effect",
                    context: "FRAME",
                    property: "shadow",
                    value: `${x}/${y}/${effect.radius}/${effect.spread ?? 0}`,
                    frameId: `style:${style.node_id}`,
                  });
                }
              }
            }
          }
        }
      } catch {
        continue;
      }
    }
  } catch {
    // Styles fetch failed — not critical, component patterns still work
  }

  return observations;
}

/**
 * Sample component nodes from the file.
 * Uses the /files/:key/components API to find component node IDs directly,
 * avoiding the need to walk the deeply nested file tree.
 * Falls back to top-level frames only if no components are found.
 */
async function sampleFrames(
  figmaClient: FigmaClient,
  fileKey: string
): Promise<string[]> {
  // Try components API first — reliable regardless of nesting depth
  try {
    const response = await figmaClient.getComponents(fileKey);
    const componentIds = new Set<string>();

    for (const comp of response.meta.components) {
      // Prefer component set IDs (parent) over individual variant IDs
      const setInfo = comp.containing_frame?.containingComponentSet;
      if (setInfo) {
        componentIds.add(setInfo.nodeId);
      } else {
        componentIds.add(comp.node_id);
      }
      if (componentIds.size >= MAX_FRAMES) break;
    }

    if (componentIds.size > 0) {
      return Array.from(componentIds).slice(0, MAX_FRAMES);
    }
  } catch {
    // Components API failed — fall through to file tree
  }

  // Fallback: sample top-level frames from the file
  const file = await figmaClient.getFile(fileKey, 2);
  const frameIds: string[] = [];

  for (const page of file.document.children ?? []) {
    if (page.type !== "CANVAS") continue;
    for (const child of page.children ?? []) {
      if (child.type === "FRAME" || child.type === "COMPONENT" || child.type === "COMPONENT_SET") {
        frameIds.push(child.id);
      }
      if (frameIds.length >= MAX_FRAMES) break;
    }
    if (frameIds.length >= MAX_FRAMES) break;
  }

  return frameIds;
}

/** Recursively walk a node tree collecting observations */
function collectObservations(
  node: FigmaDetailedNode,
  frameId: string,
  observations: Observation[]
): void {
  // Spacing observations (auto-layout frames)
  if (node.layoutMode && node.layoutMode !== "NONE") {
    if (node.paddingTop !== undefined) {
      const padding = [node.paddingTop, node.paddingRight ?? node.paddingTop, node.paddingBottom ?? node.paddingTop, node.paddingLeft ?? node.paddingTop];
      const uniform = padding.every((p) => p === padding[0]);
      if (uniform) {
        observations.push({
          category: "spacing",
          context: node.type,
          property: "padding",
          value: `${padding[0]}px`,
          frameId,
        });
      }
    }
    if (node.itemSpacing !== undefined && node.itemSpacing > 0) {
      observations.push({
        category: "spacing",
        context: node.type,
        property: "gap",
        value: `${node.itemSpacing}px`,
        frameId,
      });
    }
  }

  // Color observations (fills)
  if (node.fills) {
    for (const fill of node.fills) {
      if (fill.visible === false || fill.type !== "SOLID" || !fill.color) continue;
      const hex = figmaColorToHex(fill.color);
      const colorContext = node.type === "TEXT" ? "text" : "background";
      observations.push({
        category: "color",
        context: colorContext,
        property: "fill",
        value: hex,
        frameId,
      });
    }
  }

  // Typography observations
  if (node.type === "TEXT" && node.style) {
    const s = node.style;
    observations.push({
      category: "typography",
      context: "TEXT",
      property: "font",
      value: `${s.fontFamily}/${s.fontSize}/${s.fontWeight}`,
      frameId,
    });
  }

  // Effect observations
  if (node.effects) {
    for (const effect of node.effects) {
      if (effect.visible === false) continue;
      if (effect.type === "DROP_SHADOW" || effect.type === "INNER_SHADOW") {
        const x = effect.offset?.x ?? 0;
        const y = effect.offset?.y ?? 0;
        observations.push({
          category: "effect",
          context: node.type,
          property: "shadow",
          value: `${x}/${y}/${effect.radius}/${effect.spread ?? 0}`,
          frameId,
        });
      }
    }
  }

  // Recurse into children
  for (const child of node.children ?? []) {
    collectObservations(child, frameId, observations);
  }
}

/** Aggregate observations into patterns using frequency thresholds */
function aggregateObservations(
  observations: Observation[],
  totalFrames: number
): AggregatedPattern[] {
  // Group by category + property + value
  const groups = new Map<string, { obs: Observation[]; frames: Set<string> }>();

  for (const obs of observations) {
    const key = `${obs.category}:${obs.property}:${obs.value}`;
    if (!groups.has(key)) {
      groups.set(key, { obs: [], frames: new Set() });
    }
    const group = groups.get(key)!;
    group.obs.push(obs);
    group.frames.add(obs.frameId);
  }

  // Apply frequency threshold
  // Primary: 3+ occurrences across 2+ frames
  // Fallback (small files): 2+ occurrences in 1+ frame
  const minCount = totalFrames < 2 ? 2 : 3;
  const minFrames = totalFrames < 2 ? 1 : 2;

  const patterns: AggregatedPattern[] = [];

  for (const [_key, group] of groups) {
    if (group.obs.length < minCount || group.frames.size < minFrames) continue;

    const sample = group.obs[0];
    const description = generateDescription(sample, group.obs.length);

    patterns.push({
      category: sample.category,
      description,
      count: group.obs.length,
      frameCount: group.frames.size,
    });
  }

  // Sort by frequency (most common first)
  patterns.sort((a, b) => b.count - a.count);

  return patterns;
}

/** Generate a human-readable description for a pattern */
function generateDescription(sample: Observation, count: number): string {
  switch (sample.category) {
    case "spacing":
      if (sample.property === "padding") {
        return `${sample.context} nodes use ${sample.value} padding (${count}× observed)`;
      }
      return `${sample.context} nodes use ${sample.value} gap between children (${count}× observed)`;

    case "color":
      return `${sample.context} color ${sample.value} (${count}× observed)`;

    case "typography": {
      const [family, size, weight] = sample.value.split("/");
      return `Text uses ${family} at ${size}px weight ${weight} (${count}× observed)`;
    }

    case "effect":
      return `${sample.context} nodes use shadow ${sample.value.replace(/\//g, " ")} (${count}× observed)`;

    default:
      return `${sample.property}: ${sample.value} on ${sample.context} (${count}× observed)`;
  }
}

/** Replace raw values in descriptions with token names where possible */
function mapToTokens(
  description: string,
  tokenMap?: Map<string, string>
): string {
  if (!tokenMap) return description;

  let result = description;
  for (const [rawValue, tokenName] of tokenMap) {
    result = result.replace(rawValue, `${tokenName} (${rawValue})`);
  }
  return result;
}

/** Group patterns by category for output */
function groupPatterns(patterns: AggregatedPattern[]): PatternGroup[] {
  const categoryMap: Record<string, string> = {
    spacing: "Spacing",
    color: "Color Usage",
    typography: "Typography",
    effect: "Effects",
    composition: "Composition",
  };

  const groups = new Map<string, string[]>();

  for (const pattern of patterns) {
    const label = categoryMap[pattern.category] ?? pattern.category;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(pattern.description);
  }

  return Array.from(groups.entries()).map(([category, patterns]) => ({
    category,
    patterns,
  }));
}

/**
 * Component Matcher — walks a ParsedNode tree and matches INSTANCE nodes
 * against known Figma components from the component registry.
 */

import type { ParsedNode } from "../types/node-ir.js";
import type { FigmaComponentListItem } from "../types/figma.js";

// ─── Public Types ───

export interface ComponentRef {
  name: string;
  nodeId: string;
  key: string;
  setName?: string;
}

export interface ComponentMatchRecord {
  figmaComponentName: string;
  figmaComponentId: string;
  codeComponentName: string | null;
  status: "matched" | "not_found";
  props: Record<string, string>;
}

// ─── Index Builder ───

/**
 * Build a Map<normalizedName, ComponentRef> from Figma component metadata.
 * Normalizes by lowercasing and stripping whitespace.
 */
export function buildComponentsByName(
  components: FigmaComponentListItem[],
): Map<string, ComponentRef> {
  const map = new Map<string, ComponentRef>();

  for (const comp of components) {
    const setInfo = comp.containing_frame?.containingComponentSet;
    const displayName = setInfo?.name ?? comp.name;
    const normalized = displayName.toLowerCase().replace(/\s+/g, "");
    if (!map.has(normalized)) {
      map.set(normalized, {
        name: displayName,
        nodeId: setInfo?.nodeId ?? comp.node_id,
        key: comp.key,
        setName: setInfo?.name,
      });
    }
  }

  return map;
}

/**
 * Build a Map<componentId, FigmaComponentListItem> for ID-based lookups.
 */
function buildComponentsById(
  components: FigmaComponentListItem[],
): Map<string, FigmaComponentListItem> {
  const map = new Map<string, FigmaComponentListItem>();
  for (const comp of components) {
    map.set(comp.node_id, comp);
  }
  return map;
}

// ─── Component Matching ───

/**
 * Walk a ParsedNode tree, match INSTANCE nodes against known components.
 * Returns a new tree with matched instances annotated and a list of match records.
 */
export function matchComponents(
  tree: ParsedNode,
  componentsByName: Map<string, ComponentRef>,
  figmaComponents: FigmaComponentListItem[],
): { tree: ParsedNode; records: ComponentMatchRecord[] } {
  const records: ComponentMatchRecord[] = [];
  const componentsById = buildComponentsById(figmaComponents);
  const newTree = walkAndMatchComponents(tree, componentsByName, componentsById, records);
  return { tree: newTree, records };
}

// ─── Internal Tree Walker ───

function walkAndMatchComponents(
  node: ParsedNode,
  componentsByName: Map<string, ComponentRef>,
  componentsById: Map<string, FigmaComponentListItem>,
  records: ComponentMatchRecord[],
): ParsedNode {
  // If this node has a componentRef, try to match it
  if (node.componentRef?.sourceNodeId) {
    const sourceId = node.componentRef.sourceNodeId;
    const figmaComp = componentsById.get(sourceId);

    if (figmaComp) {
      const setInfo = figmaComp.containing_frame?.containingComponentSet;
      const displayName = setInfo?.name ?? figmaComp.name;
      const normalized = displayName.toLowerCase().replace(/\s+/g, "");
      const matched = componentsByName.get(normalized);

      // Extract variant props from the component name (e.g., "State=Default, Size=md")
      const props = parseVariantProps(figmaComp.name);

      if (matched) {
        records.push({
          figmaComponentName: displayName,
          figmaComponentId: sourceId,
          codeComponentName: matched.name,
          status: "matched",
          props,
        });

        // Update the componentRef with the matched name
        return {
          ...node,
          componentRef: {
            ...node.componentRef,
            componentName: toPascalCase(matched.name),
            props,
          },
        };
      } else {
        records.push({
          figmaComponentName: displayName,
          figmaComponentId: sourceId,
          codeComponentName: null,
          status: "not_found",
          props,
        });
      }
    }
  }

  // Recurse into children
  const newChildren = node.children.map((child) =>
    walkAndMatchComponents(child, componentsByName, componentsById, records)
  );

  return {
    ...node,
    children: newChildren,
  };
}

// ─── Helpers ───

function parseVariantProps(name: string): Record<string, string> {
  const result: Record<string, string> = {};
  const parts = name.split(",").map((s) => s.trim());
  for (const part of parts) {
    const eqIdx = part.indexOf("=");
    if (eqIdx > 0) {
      const key = part.slice(0, eqIdx).trim();
      const value = part.slice(eqIdx + 1).trim();
      result[key] = value;
    }
  }
  return result;
}

function toPascalCase(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, c: string) => c.toUpperCase())
    .replace(/^[a-z]/, (c) => c.toUpperCase())
    .replace(/[^a-zA-Z0-9]/g, "");
}

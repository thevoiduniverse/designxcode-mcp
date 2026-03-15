/**
 * Shared parsers for extracting component info from Figma API responses
 * and Storybook manifests. Used by audit-component-parity and audit-system-health.
 */

import type { FigmaFileComponentsResponse, FigmaFileResponse, FigmaNode } from "../types/figma.js";
import type { FigmaComponentEntry, CodeComponentEntry } from "../types/components.js";

/**
 * Extract component entries from a Figma file components API response.
 * The /files/:key/components endpoint returns an array of components.
 * Components inside a component set have containing_frame.containingComponentSet.
 * We deduplicate by component set (only one entry per set).
 */
export function extractFigmaComponents(
  response: FigmaFileComponentsResponse,
  fileKey: string,
  pageName?: string
): FigmaComponentEntry[] {
  const components: FigmaComponentEntry[] = [];
  const seenSets = new Set<string>();

  for (const comp of response.meta.components) {
    if (pageName && comp.containing_frame?.pageName !== pageName) continue;

    const setInfo = comp.containing_frame?.containingComponentSet;

    if (setInfo) {
      // Component is a variant — add one entry per component set
      if (!seenSets.has(setInfo.nodeId)) {
        seenSets.add(setInfo.nodeId);
        components.push({
          name: setInfo.name,
          key: comp.key,
          description: "",
          nodeId: setInfo.nodeId,
          pageName: comp.containing_frame?.pageName,
          figmaUrl: `https://www.figma.com/design/${fileKey}?node-id=${encodeURIComponent(setInfo.nodeId)}`,
        });
      }
    } else {
      // Standalone component (no variants)
      components.push({
        name: comp.name,
        key: comp.key,
        description: comp.description,
        nodeId: comp.node_id,
        pageName: comp.containing_frame?.pageName,
        figmaUrl: `https://www.figma.com/design/${fileKey}?node-id=${encodeURIComponent(comp.node_id)}`,
      });
    }
  }

  return components;
}

/**
 * Parse a Storybook stories.json (or index.json) manifest into code component entries.
 * Deduplicates by top-level title (e.g. "Components/Button" → "Button").
 */
export function parseStorybookManifest(content: string): CodeComponentEntry[] {
  const manifest = JSON.parse(content);
  const components = new Map<string, CodeComponentEntry>();

  const stories = manifest.stories ?? manifest.entries ?? {};
  for (const story of Object.values(stories) as Array<{ title?: string; name?: string; importPath?: string; id?: string }>) {
    const title = story.title ?? "";
    const parts = title.split("/");
    const componentName = parts[parts.length - 1];
    if (!componentName) continue;

    if (!components.has(componentName)) {
      components.set(componentName, {
        name: componentName,
        filePath: story.importPath,
        storyId: story.id,
        hasStory: true,
      });
    }
  }

  return Array.from(components.values());
}

/**
 * Extract components from a full Figma file response (GET /files/:key).
 * This finds ALL components, including unpublished ones, by:
 * 1. Using the top-level `components`/`componentSets` metadata maps (published)
 * 2. Walking the document tree to find COMPONENT/COMPONENT_SET nodes (unpublished)
 */
export function extractFigmaComponentsFromFile(
  response: FigmaFileResponse,
  fileKey: string,
  pageName?: string
): FigmaComponentEntry[] {
  const components: FigmaComponentEntry[] = [];
  const seenNodeIds = new Set<string>();

  // Build a map of nodeId → pageName by walking the document tree
  const nodePageMap = new Map<string, string>();
  for (const page of response.document.children ?? []) {
    if (page.type === "CANVAS") {
      collectNodeIds(page, page.name, nodePageMap);
    }
  }

  // 1. Process published component sets from metadata
  if (response.componentSets) {
    for (const [nodeId, set] of Object.entries(response.componentSets)) {
      const nodePageName = nodePageMap.get(nodeId);
      if (pageName && nodePageName !== pageName) continue;

      seenNodeIds.add(nodeId);
      components.push({
        name: set.name,
        key: set.key,
        description: set.description,
        nodeId,
        pageName: nodePageName,
        figmaUrl: `https://www.figma.com/design/${fileKey}?node-id=${encodeURIComponent(nodeId)}`,
      });
    }
  }

  // 2. Process published individual components from metadata (skip variants)
  for (const [nodeId, comp] of Object.entries(response.components)) {
    if (comp.componentSetId) continue;
    const nodePageName = nodePageMap.get(nodeId);
    if (pageName && nodePageName !== pageName) continue;

    seenNodeIds.add(nodeId);
    components.push({
      name: comp.name,
      key: comp.key,
      description: comp.description,
      nodeId,
      pageName: nodePageName,
      figmaUrl: `https://www.figma.com/design/${fileKey}?node-id=${encodeURIComponent(nodeId)}`,
    });
  }

  // 3. Walk the document tree to find COMPONENT/COMPONENT_SET nodes
  //    that weren't in the metadata (i.e. unpublished components)
  for (const page of response.document.children ?? []) {
    if (page.type !== "CANVAS") continue;
    if (pageName && page.name !== pageName) continue;
    collectComponentNodes(page, page.name, fileKey, seenNodeIds, components);
  }

  return components;
}

/**
 * Recursively walk the document tree to find COMPONENT and COMPONENT_SET nodes.
 * Skips nodes already discovered via the metadata dictionaries.
 * When a COMPONENT_SET is found, it is added but its children (variants) are not.
 * When a standalone COMPONENT is found (not inside a COMPONENT_SET), it is added.
 */
function collectComponentNodes(
  node: FigmaNode,
  pageName: string,
  fileKey: string,
  seenNodeIds: Set<string>,
  components: FigmaComponentEntry[],
  insideComponentSet = false,
): void {
  if (node.type === "COMPONENT_SET" && !seenNodeIds.has(node.id)) {
    seenNodeIds.add(node.id);
    components.push({
      name: node.name,
      key: "",
      description: "",
      nodeId: node.id,
      pageName,
      figmaUrl: `https://www.figma.com/design/${fileKey}?node-id=${encodeURIComponent(node.id)}`,
    });
    // Don't recurse into component set children — they are variants, not standalone components
    return;
  }

  if (node.type === "COMPONENT" && !insideComponentSet && !seenNodeIds.has(node.id)) {
    seenNodeIds.add(node.id);
    components.push({
      name: node.name,
      key: "",
      description: "",
      nodeId: node.id,
      pageName,
      figmaUrl: `https://www.figma.com/design/${fileKey}?node-id=${encodeURIComponent(node.id)}`,
    });
    return;
  }

  for (const child of node.children ?? []) {
    collectComponentNodes(
      child,
      pageName,
      fileKey,
      seenNodeIds,
      components,
      insideComponentSet || node.type === "COMPONENT_SET",
    );
  }
}

/** Recursively collect all node IDs and map them to their page name */
function collectNodeIds(node: FigmaNode, pageName: string, map: Map<string, string>): void {
  map.set(node.id, pageName);
  for (const child of node.children ?? []) {
    collectNodeIds(child, pageName, map);
  }
}

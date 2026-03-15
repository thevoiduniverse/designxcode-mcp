/**
 * Shared utility for fetching components with variant prop data.
 * Used by both the components MCP resource and the get_design_context tool.
 */

import type { FigmaClient } from "../clients/figma.js";
import type { FigmaComponentEntry } from "../types/components.js";
import type { ComponentWithProps } from "./context-formatter.js";
import {
  extractFigmaComponents,
  extractFigmaComponentsFromFile,
} from "./component-parsers.js";
import { parseVariants } from "./variant-parser.js";

/**
 * Fetch components with variant props from a Figma file.
 *
 * Key detail: The variantMap is keyed by componentSetId (a node ID like "1234:5678"),
 * which is NOT the same as the published component key. We build a name-based lookup
 * since extractFigmaComponents returns component sets by name, and variant children
 * reference their parent set by componentSetId.
 */
export async function fetchComponentsWithProps(
  figmaClient: FigmaClient,
  fileKey: string
): Promise<ComponentWithProps[]> {
  let topLevelComponents: FigmaComponentEntry[];
  // Map component set name -> variant children
  let variantsBySetName: Map<string, Array<{ name: string; key: string; description: string }>>;

  try {
    const response = await figmaClient.getComponents(fileKey);
    topLevelComponents = extractFigmaComponents(response, fileKey);

    // Build: set name -> variant children from the array response
    variantsBySetName = new Map();
    for (const comp of response.meta.components) {
      const setInfo = comp.containing_frame?.containingComponentSet;
      if (setInfo) {
        if (!variantsBySetName.has(setInfo.name)) variantsBySetName.set(setInfo.name, []);
        variantsBySetName.get(setInfo.name)!.push({
          name: comp.name,
          key: comp.key,
          description: comp.description,
        });
      }
    }
  } catch {
    // Fallback to file tree for unpublished components
    const fileResponse = await figmaClient.getFile(fileKey);
    topLevelComponents = extractFigmaComponentsFromFile(fileResponse, fileKey);
    variantsBySetName = new Map();
  }

  const result: ComponentWithProps[] = [];

  for (const comp of topLevelComponents) {
    // Look up variants by component name (which matches the set name)
    const variants = variantsBySetName.get(comp.name) ?? [];
    const variantEntries = variants.length > 0
      ? variants
      : [{ name: comp.name, key: comp.key, description: comp.description }];

    const props = parseVariants(variantEntries);

    result.push({
      component: comp,
      props,
      variantCount: variants.length || 1,
    });
  }

  return result;
}

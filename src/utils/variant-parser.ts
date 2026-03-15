/**
 * Parses Figma component variant names into structured props.
 * Figma variants use names like "Size=Large, State=Hover, Disabled=true".
 */

import type { FigmaComponentEntry } from "../types/components.js";
import type { ComponentProp } from "../types/scaffold.js";

/**
 * Parse variant components into structured props.
 * Groups components by their set name and extracts property/value pairs
 * from variant names like "Size=Large, State=Hover".
 */
export function parseVariants(
  components: FigmaComponentEntry[]
): ComponentProp[] {
  const propValues = new Map<string, Set<string>>();

  for (const comp of components) {
    // Variant names contain comma-separated key=value pairs
    const pairs = comp.name.split(",").map((p) => p.trim());
    for (const pair of pairs) {
      const eqIndex = pair.indexOf("=");
      if (eqIndex === -1) continue;
      const key = pair.substring(0, eqIndex).trim();
      const value = pair.substring(eqIndex + 1).trim();
      if (!key) continue;

      if (!propValues.has(key)) {
        propValues.set(key, new Set());
      }
      propValues.get(key)!.add(value);
    }
  }

  const props: ComponentProp[] = [];
  for (const [name, values] of propValues) {
    const valArray = Array.from(values);

    // Detect booleans
    const isBool =
      valArray.length === 2 &&
      valArray.sort().join(",") === "false,true";

    if (isBool) {
      props.push({
        name,
        type: "boolean",
        defaultValue: "false",
      });
    } else {
      props.push({
        name,
        type: "enum",
        values: valArray,
        defaultValue: valArray[0],
      });
    }
  }

  return props;
}

/**
 * Group components by componentSetId to identify variant families.
 * Returns a map of setName → variant components.
 */
export function groupByComponentSet(
  components: FigmaComponentEntry[]
): Map<string, FigmaComponentEntry[]> {
  const groups = new Map<string, FigmaComponentEntry[]>();

  for (const comp of components) {
    const setName = comp.setName ?? comp.name;
    if (!groups.has(setName)) {
      groups.set(setName, []);
    }
    groups.get(setName)!.push(comp);
  }

  return groups;
}

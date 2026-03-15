/**
 * Diffs Figma component variant node trees against the default variant.
 * Produces state overrides (CSS pseudo-classes) and dimensional variants (prop-driven classes).
 */

import type { FigmaDetailedNode } from "../types/figma.js";
import type {
  ParsedNode,
  ParsedStyles,
  StateOverride,
  DimensionalVariant,
  VariantEntry,
  ComponentPropIR,
  ResolvedValue,
} from "../types/node-ir.js";
import { parseNodeTree } from "./node-parser.js";
import { sanitizeClassName } from "./node-parser.js";
import { VariableResolver } from "./variable-resolver.js";

// ─── State name → CSS selector mapping ───

const STATE_SELECTOR_MAP: Record<string, string> = {
  hover: ":hover:not(:disabled)",
  hovered: ":hover:not(:disabled)",
  pressed: ":active:not(:disabled)",
  active: ":active:not(:disabled)",
  focus: ":focus-visible",
  focused: ":focus-visible",
  disabled: ":disabled, [aria-disabled=\"true\"]",
  selected: "[aria-selected=\"true\"]",
  checked: ":checked, [aria-checked=\"true\"]",
  error: "[aria-invalid=\"true\"]",
  invalid: "[aria-invalid=\"true\"]",
};

function getStateSelector(stateName: string): string {
  const key = stateName.toLowerCase();
  return STATE_SELECTOR_MAP[key] ?? `[data-state="${key}"]`;
}

// ─── Public API ───

export interface DiffResult {
  stateOverrides: StateOverride[];
  dimensionalVariants: DimensionalVariant[];
}

/**
 * Diff all variants of a component against the default variant.
 *
 * @param variants - All variant entries with parsed prop values
 * @param variantNodes - Map of variantNodeId → FigmaDetailedNode
 * @param resolver - Variable resolver for token lookups
 * @param statePropNames - Prop names that should map to CSS pseudo-classes
 * @param componentClassName - The root class name for BEM modifiers
 */
export function diffVariants(
  variants: VariantEntry[],
  variantNodes: Record<string, FigmaDetailedNode>,
  resolver: VariableResolver,
  statePropNames: string[],
  componentClassName: string
): DiffResult {
  const stateOverrides: StateOverride[] = [];
  const dimensionalVariants: DimensionalVariant[] = [];

  // Identify the default variant (all props at first value)
  const defaultVariant = findDefaultVariant(variants, statePropNames);
  if (!defaultVariant) return { stateOverrides, dimensionalVariants };

  const defaultNode = variantNodes[defaultVariant.nodeId];
  if (!defaultNode) return { stateOverrides, dimensionalVariants };

  const defaultTree = parseNodeTree(defaultNode, resolver);

  // Collect unique state values and dimensional values
  const stateNamesLower = new Set(statePropNames.map((n) => n.toLowerCase()));

  for (const variant of variants) {
    if (variant.nodeId === defaultVariant.nodeId) continue;

    const variantNode = variantNodes[variant.nodeId];
    if (!variantNode) continue;

    const variantTree = parseNodeTree(variantNode, resolver);

    // Determine what changed between this variant and the default
    const changedProps: Record<string, string> = {};
    for (const [key, val] of Object.entries(variant.propValues)) {
      if (defaultVariant.propValues[key] !== val) {
        changedProps[key] = val;
      }
    }

    // Categorize: state change or dimensional change?
    const stateChanges: Record<string, string> = {};
    const dimChanges: Record<string, string> = {};
    for (const [key, val] of Object.entries(changedProps)) {
      if (stateNamesLower.has(key.toLowerCase())) {
        stateChanges[key] = val;
      } else {
        dimChanges[key] = val;
      }
    }

    // Compute style diff
    const { overrides, resolvedOverrides } = diffTrees(defaultTree, variantTree);
    if (Object.keys(overrides).length === 0) continue;

    // If only state props changed → state override
    if (Object.keys(stateChanges).length > 0 && Object.keys(dimChanges).length === 0) {
      const stateName = Object.values(stateChanges)[0];
      stateOverrides.push({
        stateName,
        selector: getStateSelector(stateName),
        overrides,
        resolvedOverrides,
      });
    }

    // If only dimensional props changed → dimensional variant
    if (Object.keys(dimChanges).length > 0 && Object.keys(stateChanges).length === 0) {
      const propName = Object.keys(dimChanges)[0];
      const propValue = dimChanges[propName];
      dimensionalVariants.push({
        propName,
        propValue,
        modifierClass: `${componentClassName}--${sanitizeClassName(propValue)}`,
        overrides,
        resolvedOverrides,
      });
    }

    // Mixed changes (both state + dimensional) → scoped dimensional state override
    if (Object.keys(stateChanges).length > 0 && Object.keys(dimChanges).length > 0) {
      // For v1, treat as a dimensional variant with the state selector appended
      const stateName = Object.values(stateChanges)[0];
      const dimPropName = Object.keys(dimChanges)[0];
      const dimPropValue = dimChanges[dimPropName];
      stateOverrides.push({
        stateName: `${dimPropValue}-${stateName}`,
        selector: `.${componentClassName}--${sanitizeClassName(dimPropValue)}${getStateSelector(stateName)}`,
        overrides,
        resolvedOverrides,
      });
    }
  }

  return { stateOverrides, dimensionalVariants };
}

/**
 * Build ComponentPropIR array from variant entries.
 */
export function extractPropsFromVariants(
  variants: VariantEntry[],
  statePropNames: string[]
): ComponentPropIR[] {
  const propMap = new Map<string, Set<string>>();
  const stateNamesLower = new Set(statePropNames.map((n) => n.toLowerCase()));

  for (const variant of variants) {
    for (const [key, value] of Object.entries(variant.propValues)) {
      if (!propMap.has(key)) propMap.set(key, new Set());
      propMap.get(key)!.add(value);
    }
  }

  const props: ComponentPropIR[] = [];
  for (const [name, values] of propMap) {
    // Skip state props — they become CSS pseudo-classes, not component props
    if (stateNamesLower.has(name.toLowerCase())) continue;

    const sortedValues = Array.from(values);
    const isBool = sortedValues.length === 2 &&
      sortedValues.some((v) => v.toLowerCase() === "true") &&
      sortedValues.some((v) => v.toLowerCase() === "false");

    props.push({
      name: name.charAt(0).toLowerCase() + name.slice(1), // camelCase prop name
      type: isBool ? "boolean" : "enum",
      values: isBool ? undefined : sortedValues,
      defaultValue: sortedValues[0],
      source: "variant",
    });
  }

  return props;
}

// ─── Diffing ───

/**
 * Diff two ParsedNode trees and return only changed styles per className.
 * Walks both trees in parallel, matched by className.
 */
interface DiffTreeResult {
  overrides: Record<string, Partial<ParsedStyles>>;
  resolvedOverrides: Record<string, Map<string, ResolvedValue>>;
}

function diffTrees(
  defaultTree: ParsedNode,
  variantTree: ParsedNode
): DiffTreeResult {
  const overrides: Record<string, Partial<ParsedStyles>> = {};
  const resolvedOverrides: Record<string, Map<string, ResolvedValue>> = {};
  diffNodesRecursive(defaultTree, variantTree, overrides, resolvedOverrides);
  return { overrides, resolvedOverrides };
}

function diffNodesRecursive(
  defaultNode: ParsedNode,
  variantNode: ParsedNode,
  result: Record<string, Partial<ParsedStyles>>,
  resolvedResult: Record<string, Map<string, ResolvedValue>>
): void {
  // Diff styles of this node
  const changedStyles = diffStyles(defaultNode.styles, variantNode.styles);
  if (Object.keys(changedStyles).length > 0) {
    result[defaultNode.className] = changedStyles;
    // Collect resolved values for the changed properties from the variant node
    const changedResolved = new Map<string, ResolvedValue>();
    for (const prop of Object.keys(changedStyles)) {
      const rv = variantNode.resolvedValues.get(prop);
      if (rv) changedResolved.set(prop, rv);
    }
    if (changedResolved.size > 0) {
      resolvedResult[defaultNode.className] = changedResolved;
    }
  }

  // Match children by className for parallel traversal
  const defaultChildMap = new Map<string, ParsedNode>();
  for (const child of defaultNode.children) {
    defaultChildMap.set(child.className, child);
  }

  for (const variantChild of variantNode.children) {
    const defaultChild = defaultChildMap.get(variantChild.className);
    if (defaultChild) {
      diffNodesRecursive(defaultChild, variantChild, result, resolvedResult);
    }
    // If no matching child, skip (structural difference — v1 doesn't support)
  }
}

function diffStyles(
  defaultStyles: ParsedStyles,
  variantStyles: ParsedStyles
): Partial<ParsedStyles> {
  const changed: Partial<ParsedStyles> = {};

  // Check all keys in both styles
  const allKeys = new Set([
    ...Object.keys(defaultStyles),
    ...Object.keys(variantStyles),
  ]);

  for (const key of allKeys) {
    const dv = defaultStyles[key];
    const vv = variantStyles[key];
    if (dv !== vv && vv !== undefined) {
      changed[key] = vv;
    }
  }

  return changed;
}

// ─── Helpers ───

/**
 * Find the default variant — where all props are at their first listed value.
 */
export function findDefaultVariant(
  variants: VariantEntry[],
  statePropNames: string[]
): VariantEntry | undefined {
  if (variants.length === 0) return undefined;
  if (variants.length === 1) return variants[0];

  // Collect first value for each prop
  const firstValues = new Map<string, string>();
  for (const variant of variants) {
    for (const [key, value] of Object.entries(variant.propValues)) {
      if (!firstValues.has(key)) {
        firstValues.set(key, value);
      }
    }
  }

  // Try to find a variant with "Default" for state props first
  const stateNamesLower = new Set(statePropNames.map((n) => n.toLowerCase()));
  const preferDefault = new Map(firstValues);
  for (const [key] of preferDefault) {
    if (stateNamesLower.has(key.toLowerCase())) {
      preferDefault.set(key, "Default");
    }
  }

  const preferred = variants.find((v) =>
    [...preferDefault].every(([key, val]) => v.propValues[key] === val)
  );
  if (preferred) return preferred;

  // Fallback: first values for everything
  return variants.find((v) =>
    [...firstValues].every(([key, val]) => v.propValues[key] === val)
  ) ?? variants[0];
}

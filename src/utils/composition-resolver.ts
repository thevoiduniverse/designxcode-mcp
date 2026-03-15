/**
 * Detects nested component instances in Figma node trees,
 * builds a dependency graph, and determines generation order.
 */

import type { FigmaDetailedNode } from "../types/figma.js";
import type { ParsedNode, ComponentReference } from "../types/node-ir.js";
import { toPascalCase } from "./scaffold-templates.js";

// ─── Types ───

/** Map of component set nodeId → PascalCase component name */
export type ComponentNameMap = Map<string, string>;

// ─── Public API ───

/**
 * Build a map of component set nodeId → PascalCase name.
 * Used to resolve INSTANCE nodes to component references.
 */
export function buildComponentNameMap(
  components: Array<{ nodeId?: string; name: string }>
): ComponentNameMap {
  const map = new Map<string, string>();
  for (const comp of components) {
    if (comp.nodeId) {
      map.set(comp.nodeId, toPascalCase(comp.name));
    }
  }
  return map;
}

/**
 * Walk a ParsedNode tree and resolve componentRef entries.
 * Fills in componentName from the nameMap and extracts text overrides as props.
 *
 * @param tree - The parsed node tree (mutated in place)
 * @param nameMap - nodeId → PascalCase name
 * @param variantNode - Original Figma node tree (for extracting instance overrides)
 */
export function resolveComponentRefs(
  tree: ParsedNode,
  nameMap: ComponentNameMap,
  variantNode?: FigmaDetailedNode
): void {
  walkAndResolve(tree, nameMap);
}

function walkAndResolve(node: ParsedNode, nameMap: ComponentNameMap): void {
  if (node.componentRef) {
    const name = nameMap.get(node.componentRef.sourceNodeId);
    if (name) {
      node.componentRef.componentName = name;
    }
  }

  for (const child of node.children) {
    walkAndResolve(child, nameMap);
  }
}

/**
 * Extract all component dependencies from a ParsedNode tree.
 * Returns a set of PascalCase component names that this tree references.
 */
export function extractDependencies(tree: ParsedNode): string[] {
  const deps = new Set<string>();
  collectDeps(tree, deps);
  return Array.from(deps);
}

function collectDeps(node: ParsedNode, deps: Set<string>): void {
  if (node.componentRef?.componentName) {
    deps.add(node.componentRef.componentName);
  }
  for (const child of node.children) {
    collectDeps(child, deps);
  }
}

/**
 * Topological sort of components by their dependencies.
 * Components with no dependencies come first.
 * If circular dependencies are detected, breaks the cycle and emits a warning.
 *
 * @returns Sorted component names (generation order) + any warnings
 */
export function topologicalSort(
  components: Array<{ name: string; dependencies: string[] }>
): { sorted: string[]; warnings: string[] } {
  const warnings: string[] = [];
  const graph = new Map<string, Set<string>>();
  const allNames = new Set<string>();

  for (const comp of components) {
    allNames.add(comp.name);
    graph.set(comp.name, new Set(comp.dependencies.filter((d) => allNames.has(d) || components.some((c) => c.name === d))));
  }

  const sorted: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>(); // For cycle detection

  function visit(name: string): void {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      warnings.push(`Circular dependency detected involving "${name}" — breaking cycle`);
      return;
    }

    visiting.add(name);
    const deps = graph.get(name) ?? new Set();
    for (const dep of deps) {
      visit(dep);
    }
    visiting.delete(name);
    visited.add(name);
    sorted.push(name);
  }

  for (const comp of components) {
    visit(comp.name);
  }

  return { sorted, warnings };
}

/**
 * Extract text content props from a ParsedNode tree.
 * Any text node with isTextProp=true becomes a string prop.
 */
export function extractTextProps(
  tree: ParsedNode,
  componentName: string
): Array<{ name: string; defaultValue: string }> {
  const props: Array<{ name: string; defaultValue: string }> = [];
  const seenNames = new Set<string>();
  collectTextProps(tree, props, seenNames, componentName);
  return props;
}

function collectTextProps(
  node: ParsedNode,
  props: Array<{ name: string; defaultValue: string }>,
  seen: Set<string>,
  componentName: string
): void {
  if (node.isTextProp && node.textContent) {
    // Generate a prop name from the node's className
    let propName = node.className
      .split("-")
      .map((s, i) => (i === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1)))
      .join("");

    // Avoid duplicates
    if (seen.has(propName)) {
      propName = `${propName}${seen.size}`;
    }
    seen.add(propName);

    props.push({ name: propName, defaultValue: node.textContent });
  }

  // Don't recurse into component refs — their text is their own
  if (!node.componentRef) {
    for (const child of node.children) {
      collectTextProps(child, props, seen, componentName);
    }
  }
}

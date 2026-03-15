/**
 * Code emitter: React + Tailwind CSS.
 * Produces a single .tsx file using Tailwind utility classes.
 * Token references use arbitrary value syntax: bg-[var(--token)]
 *
 * Variant handling: instead of inlining conditional classNames,
 * emits lookup-table style maps (e.g. typeStyles, sizeStyles) that
 * separate shared base classes from variant-specific ones.
 */

import type {
  ComponentIR,
  ParsedNode,
  ParsedStyles,
  EmittedComponent,
  DimensionalVariant,
  StateOverride,
} from "../types/node-ir.js";

export function emitReactTailwind(ir: ComponentIR, outputDir: string): EmittedComponent {
  const content = generateTSX(ir);

  return {
    componentName: ir.name,
    figmaName: ir.figmaName,
    figmaUrl: ir.figmaUrl,
    files: [
      {
        path: `${outputDir}/${ir.name}/${ir.name}.tsx`,
        content,
        description: `React component with Tailwind CSS`,
      },
    ],
    props: ir.props,
    dependencies: ir.dependencies,
    warnings: ir.warnings,
  };
}

// ─── Style Map Types ───

interface StyleMapEntry {
  base: string;
  [stateKey: string]: string;
}

interface StyleMap {
  /** camelCase prop name, e.g. "type" */
  propName: string;
  /** const name in generated code, e.g. "typeStyles" */
  constName: string;
  /** Whether any entry has state keys (hover, active, etc.) */
  hasStateInteractions: boolean;
  /** propValue → classes (string if no states, StyleMapEntry if states) */
  entries: Record<string, string | StyleMapEntry>;
}

interface StyleMapResult {
  maps: StyleMap[];
  /** CSS property names that vary across dimensional variants — excluded from base element classes */
  variantSpecificProps: Set<string>;
}

// ─── Style Map Builder ───

/**
 * Build lookup-table style maps from the IR's dimensional variants and state overrides.
 *
 * For each dimensional axis (e.g., "Type", "Size"), produces a StyleMap where:
 * - Keys are the prop values (lowercased)
 * - Values contain COMPLETE Tailwind classes for variant-specific properties
 *   (not diffs — each entry is self-contained to avoid Tailwind class conflicts)
 * - State interactions (hover/active/disabled) are folded into object entries
 */
function buildStyleMaps(ir: ComponentIR): StyleMapResult {
  const rootClassName = ir.defaultTree.className;
  const maps: StyleMap[] = [];
  const variantSpecificProps = new Set<string>();

  // Group dimensional variants by propName
  const dimGroups = new Map<string, DimensionalVariant[]>();
  for (const dv of ir.dimensionalVariants) {
    const key = dv.propName.toLowerCase();
    const group = dimGroups.get(key) || [];
    group.push(dv);
    dimGroups.set(key, group);
  }

  if (dimGroups.size === 0) return { maps, variantSpecificProps };

  // Parse scoped state overrides: "Ghost-Hover" → { dimValue, stateName }
  const scopedStates: Array<{ dimValue: string; stateName: string; override: StateOverride }> = [];
  for (const so of ir.stateOverrides) {
    const dashIdx = so.stateName.indexOf("-");
    if (dashIdx > 0) {
      scopedStates.push({
        dimValue: so.stateName.substring(0, dashIdx),
        stateName: so.stateName.substring(dashIdx + 1),
        override: so,
      });
    }
  }

  // Global state overrides (no dash — apply to default variant)
  const globalStates = ir.stateOverrides.filter((so) => !so.stateName.includes("-"));

  // ─── Pure variant selection ───
  // The differ lumps cross-axis changes into a single DimensionalVariant.
  // E.g., a variant where Size=sm AND Type=Ghost both changed from default
  // produces a "Size" DimensionalVariant with Ghost's visual overrides mixed in.
  // To get clean per-axis properties, for each (axis, propValue) pick the variant
  // with the FEWEST root overrides — it's the closest to a pure single-axis change.
  const pureVariants = new Map<string, Map<string, DimensionalVariant>>();
  for (const [axisKey, variants] of dimGroups) {
    const byValue = new Map<string, DimensionalVariant[]>();
    for (const v of variants) {
      const key = v.propValue.toLowerCase();
      const group = byValue.get(key) || [];
      group.push(v);
      byValue.set(key, group);
    }
    const pureMap = new Map<string, DimensionalVariant>();
    for (const [value, group] of byValue) {
      // Pick variant with fewest root overrides (single-axis change)
      group.sort((a, b) => {
        const aCount = Object.keys(a.overrides[rootClassName] || {}).length;
        const bCount = Object.keys(b.overrides[rootClassName] || {}).length;
        return aCount - bCount;
      });
      pureMap.set(value, group[0]);
    }
    pureVariants.set(axisKey, pureMap);
  }

  // Collect properties from pure variants only, then assign ownership
  const propAxisUniqueValues = new Map<string, Map<string, Set<string>>>();
  for (const [axisKey, pureMap] of pureVariants) {
    for (const [, v] of pureMap) {
      const rootOverrides = v.overrides[rootClassName];
      if (!rootOverrides) continue;
      for (const [prop, val] of Object.entries(rootOverrides)) {
        if (val === undefined) continue;
        if (!propAxisUniqueValues.has(prop)) propAxisUniqueValues.set(prop, new Map());
        const axisMap = propAxisUniqueValues.get(prop)!;
        if (!axisMap.has(axisKey)) axisMap.set(axisKey, new Set());
        axisMap.get(axisKey)!.add(val);
      }
    }
  }

  // Assign each property to the axis with the most unique values (ties: more variants wins)
  const propOwnership = new Map<string, string>();
  for (const [prop, axisMap] of propAxisUniqueValues) {
    let bestAxis = "";
    let bestCount = 0;
    let bestAxisSize = 0;
    for (const [axisKey, values] of axisMap) {
      const axisSize = pureVariants.get(axisKey)?.size ?? 0;
      if (values.size > bestCount || (values.size === bestCount && axisSize > bestAxisSize)) {
        bestCount = values.size;
        bestAxis = axisKey;
        bestAxisSize = axisSize;
      }
    }
    propOwnership.set(prop, bestAxis);
    variantSpecificProps.add(prop);
  }

  for (const [propNameLower, variants] of dimGroups) {
    const propIR = ir.props.find((p) => p.name.toLowerCase() === propNameLower);
    if (!propIR || !propIR.values) continue;

    // Collect CSS properties assigned to THIS axis
    const axisProps = new Set<string>();
    for (const [prop, ownerAxis] of propOwnership) {
      if (ownerAxis === propNameLower) axisProps.add(prop);
    }

    // Skip axes with no owned properties
    if (axisProps.size === 0) continue;

    // Determine if this axis has state interactions
    const axisValues = new Set(variants.map((v) => v.propValue.toLowerCase()));
    const axisScopedStates = scopedStates.filter((s) =>
      axisValues.has(s.dimValue.toLowerCase())
    );
    const hasStateInteractions = axisScopedStates.length > 0 || globalStates.length > 0;

    // Build an entry for each prop value
    const entries: Record<string, string | StyleMapEntry> = {};
    const defaultValue = propIR.defaultValue?.toLowerCase() || propIR.values[0].toLowerCase();

    for (const value of propIR.values) {
      const valueLower = value.toLowerCase();
      const isDefault = valueLower === defaultValue;

      // Build complete styles for variant-specific properties
      // Start from default values, then apply overrides for non-default variants
      const completeStyles: Partial<ParsedStyles> = {};
      for (const prop of axisProps) {
        if (ir.defaultTree.styles[prop] !== undefined) {
          completeStyles[prop] = ir.defaultTree.styles[prop];
        }
      }
      if (!isDefault) {
        // Use the pure variant (fewest overrides) to avoid cross-axis contamination
        const axisPureMap = pureVariants.get(propNameLower);
        const variant = axisPureMap?.get(valueLower);
        if (variant) {
          const rootOverrides = variant.overrides[rootClassName];
          if (rootOverrides) {
            for (const [prop, val] of Object.entries(rootOverrides)) {
              if (val !== undefined && axisProps.has(prop)) completeStyles[prop] = val;
            }
          }
        }
      }

      const baseClasses = stylesToTailwind(completeStyles as ParsedStyles).join(" ");

      if (hasStateInteractions) {
        const entry: StyleMapEntry = { base: baseClasses };

        if (isDefault) {
          // Default variant: state diffs come from global state overrides
          for (const gs of globalStates) {
            addStateEntry(entry, gs, rootClassName, undefined, axisProps);
          }
        } else {
          // Non-default: scoped state overrides for this value
          const valueScoped = axisScopedStates.filter(
            (s) => s.dimValue.toLowerCase() === valueLower
          );
          for (const scoped of valueScoped) {
            addStateEntry(entry, scoped.override, rootClassName, scoped.stateName, axisProps);
          }
          // Fallback: global states not covered by scoped versions
          const coveredStates = new Set(valueScoped.map((s) => s.stateName.toLowerCase()));
          for (const gs of globalStates) {
            if (!coveredStates.has(gs.stateName.toLowerCase())) {
              addStateEntry(entry, gs, rootClassName, undefined, axisProps);
            }
          }
        }

        entries[valueLower] = entry;
      } else {
        entries[valueLower] = baseClasses;
      }
    }

    // Normalize: ensure all entries have the same state keys (avoids TS errors with `as const`)
    if (hasStateInteractions) {
      const allStateKeys = new Set<string>();
      for (const entry of Object.values(entries)) {
        if (typeof entry === "object") {
          for (const k of Object.keys(entry)) {
            if (k !== "base") allStateKeys.add(k);
          }
        }
      }
      for (const entry of Object.values(entries)) {
        if (typeof entry === "object") {
          for (const key of allStateKeys) {
            if (!(key in entry)) {
              (entry as StyleMapEntry)[key] = "";
            }
          }
        }
      }
    }

    const camelPropName = propIR.name; // already camelCase from extractPropsFromVariants
    maps.push({
      propName: camelPropName,
      constName: `${camelPropName}Styles`,
      hasStateInteractions,
      entries,
    });
  }

  return { maps, variantSpecificProps };
}

/** Add a state override's Tailwind classes to a StyleMapEntry */
function addStateEntry(
  entry: StyleMapEntry,
  override: StateOverride,
  rootClassName: string,
  stateNameOverride?: string,
  allowedProps?: Set<string>
): void {
  const rootOverrides = override.overrides[rootClassName];
  if (!rootOverrides) return;

  const modifier = selectorToModifier(override.selector);
  const stateClasses = Object.entries(rootOverrides)
    .filter(([p, v]) => v !== undefined && (!allowedProps || allowedProps.has(p)))
    .map(([p, v]) => {
      const tw = cssToTailwind(p, v!);
      return tw ? `${modifier}:${tw}` : null;
    })
    .filter(Boolean) as string[];

  if (stateClasses.length > 0) {
    const key = (stateNameOverride ?? override.stateName).toLowerCase();
    entry[key] = stateClasses.join(" ");
  }
}

// ─── Style Map Code Emitter ───

/** Emit style map const declarations as TypeScript source lines */
function emitStyleMapConsts(maps: StyleMap[]): string[] {
  const lines: string[] = [];

  for (const map of maps) {
    if (map.hasStateInteractions) {
      lines.push(`const ${map.constName} = {`);
      for (const [key, entry] of Object.entries(map.entries)) {
        const e = entry as StyleMapEntry;
        lines.push(`  ${key}: {`);
        for (const [stateKey, classes] of Object.entries(e)) {
          lines.push(`    ${stateKey}: "${classes}",`);
        }
        lines.push(`  },`);
      }
      lines.push(`} as const;`);
    } else {
      lines.push(`const ${map.constName} = {`);
      for (const [key, classes] of Object.entries(map.entries)) {
        lines.push(`  ${key}: "${classes}",`);
      }
      lines.push(`} as const;`);
    }
    lines.push("");
  }

  return lines;
}

/** Collect all unique state keys across all entries of a style map */
function collectStateKeys(map: StyleMap): string[] {
  const keys = new Set<string>();
  for (const entry of Object.values(map.entries)) {
    if (typeof entry === "object") {
      for (const k of Object.keys(entry)) {
        if (k !== "base") keys.add(k);
      }
    }
  }
  return Array.from(keys);
}

// ─── Tailwind Class Mapping ───

/** Convert a ParsedStyles object to Tailwind utility classes */
function stylesToTailwind(styles: ParsedStyles): string[] {
  const classes: string[] = [];

  for (const [prop, value] of Object.entries(styles)) {
    if (value === undefined) continue;
    const tw = cssToTailwind(prop, value);
    if (tw) classes.push(tw);
  }

  return classes;
}

/** Map a single CSS property+value to a Tailwind class */
function cssToTailwind(prop: string, value: string): string | null {
  // Layout
  if (prop === "display" && value === "flex") return "flex";
  if (prop === "display" && value === "none") return "hidden";
  if (prop === "flexDirection" && value === "row") return "flex-row";
  if (prop === "flexDirection" && value === "column") return "flex-col";
  if (prop === "flexWrap" && value === "wrap") return "flex-wrap";
  if (prop === "flex" && value === "1") return "flex-1";
  if (prop === "overflow" && value === "hidden") return "overflow-hidden";

  // Alignment
  if (prop === "justifyContent") {
    const map: Record<string, string> = {
      "flex-start": "justify-start", "center": "justify-center",
      "flex-end": "justify-end", "space-between": "justify-between",
    };
    return map[value] ?? `justify-[${value}]`;
  }
  if (prop === "alignItems") {
    const map: Record<string, string> = {
      "flex-start": "items-start", "center": "items-center",
      "flex-end": "items-end", "baseline": "items-baseline",
    };
    return map[value] ?? `items-[${value}]`;
  }

  // Spacing (gap, padding)
  if (prop === "gap") return `gap-[${value}]`;
  if (prop === "rowGap") return `gap-y-[${value}]`;
  if (prop === "columnGap") return `gap-x-[${value}]`;
  if (prop === "padding") return `p-[${value}]`;
  if (prop === "paddingTop") return `pt-[${value}]`;
  if (prop === "paddingRight") return `pr-[${value}]`;
  if (prop === "paddingBottom") return `pb-[${value}]`;
  if (prop === "paddingLeft") return `pl-[${value}]`;

  // Sizing
  if (prop === "width") return `w-[${value}]`;
  if (prop === "height") return `h-[${value}]`;
  if (prop === "minWidth") return `min-w-[${value}]`;
  if (prop === "maxWidth") return `max-w-[${value}]`;
  if (prop === "minHeight") return `min-h-[${value}]`;
  if (prop === "maxHeight") return `max-h-[${value}]`;

  // Colors / Background
  if (prop === "background") return `bg-[${value}]`;
  if (prop === "color") return `text-[${value}]`;

  // Border
  if (prop === "border") return `border-[${value}]`;
  if (prop === "borderTop") return `border-t-[${value}]`;
  if (prop === "borderRight") return `border-r-[${value}]`;
  if (prop === "borderBottom") return `border-b-[${value}]`;
  if (prop === "borderLeft") return `border-l-[${value}]`;
  if (prop === "borderRadius") {
    // Figma uses absurdly large radii (e.g. 16777200px, 9999px) to mean "fully rounded"
    const numVal = parseFloat(value);
    if (!isNaN(numVal) && numVal >= 9999) return "rounded-full";
    return `rounded-[${value}]`;
  }

  // Effects
  if (prop === "boxShadow") return `shadow-[${value.replace(/\s+/g, "_")}]`;
  if (prop === "opacity") return `opacity-[${value}]`;
  if (prop === "filter") return `[filter:${value}]`;
  if (prop === "backdropFilter") return `[backdrop-filter:${value}]`;

  // Typography
  if (prop === "fontFamily") return `[font-family:${value}]`;
  if (prop === "fontSize") return `text-[${value}]`;
  if (prop === "fontWeight") return `font-[${value}]`;
  if (prop === "lineHeight") return `leading-[${value}]`;
  if (prop === "letterSpacing") return `tracking-[${value}]`;
  if (prop === "textAlign") {
    const map: Record<string, string> = {
      left: "text-left", center: "text-center", right: "text-right", justify: "text-justify",
    };
    return map[value] ?? `text-${value}`;
  }
  if (prop === "textTransform") {
    const map: Record<string, string> = {
      uppercase: "uppercase", lowercase: "lowercase", capitalize: "capitalize", none: "normal-case",
    };
    return map[value] ?? null;
  }
  if (prop === "textDecoration") {
    const map: Record<string, string> = {
      underline: "underline", "line-through": "line-through", none: "no-underline",
    };
    return map[value] ?? null;
  }

  // Cursor
  if (prop === "cursor") return `cursor-${value}`;

  // Fallback: arbitrary property
  return `[${camelToKebab(prop)}:${value}]`;
}

/** Convert state override styles to Tailwind modifier classes (used for child nodes) */
function stateOverridesToTailwind(
  ir: ComponentIR,
  nodeClassName: string
): string[] {
  const classes: string[] = [];

  for (const state of ir.stateOverrides) {
    const overrideStyles = state.overrides[nodeClassName];
    if (!overrideStyles) continue;

    const modifier = selectorToModifier(state.selector);
    for (const [prop, value] of Object.entries(overrideStyles)) {
      if (value === undefined) continue;
      const tw = cssToTailwind(prop, value);
      if (tw) classes.push(`${modifier}:${tw}`);
    }
  }

  return classes;
}

function selectorToModifier(selector: string): string {
  if (selector.includes(":hover")) return "hover";
  if (selector.includes(":active")) return "active";
  if (selector.includes(":focus")) return "focus-visible";
  if (selector.includes(":disabled")) return "disabled";
  if (selector.includes("aria-selected")) return "aria-selected";
  if (selector.includes("aria-checked")) return "aria-checked";
  if (selector.includes("aria-invalid")) return "aria-invalid";
  return "hover"; // fallback
}

// ─── TSX Generation ───

function generateTSX(ir: ComponentIR): string {
  const lines: string[] = [];
  const { maps, variantSpecificProps } = buildStyleMaps(ir);

  // Imports
  lines.push(`import React from "react";`);
  for (const dep of ir.dependencies) {
    lines.push(`import { ${dep} } from "../${dep}/${dep}";`);
  }
  lines.push("");

  // Style map consts (before the component)
  if (maps.length > 0) {
    lines.push(...emitStyleMapConsts(maps));
  }

  // Type aliases for style-mapped props
  for (const map of maps) {
    const typeName = `${ir.name}${map.propName.charAt(0).toUpperCase() + map.propName.slice(1)}`;
    lines.push(`export type ${typeName} = keyof typeof ${map.constName};`);
  }
  if (maps.length > 0) lines.push("");

  // Props interface
  const mappedPropNames = new Set(maps.map((m) => m.propName));
  lines.push(`export interface ${ir.name}Props {`);
  for (const prop of ir.props) {
    if (mappedPropNames.has(prop.name)) {
      const typeName = `${ir.name}${prop.name.charAt(0).toUpperCase() + prop.name.slice(1)}`;
      lines.push(`  ${prop.name}?: ${typeName};`);
    } else if (prop.type === "boolean") {
      lines.push(`  ${prop.name}?: boolean;`);
    } else if (prop.type === "enum" && prop.values) {
      const union = prop.values.map((v) => `"${v.toLowerCase()}"`).join(" | ");
      lines.push(`  ${prop.name}?: ${union};`);
    } else {
      lines.push(`  ${prop.name}?: string;`);
    }
  }
  lines.push(`  children?: React.ReactNode;`);
  lines.push(`}`);
  lines.push("");

  // Component
  const propsDestructure = ir.props
    .map((p) => {
      if (p.defaultValue) {
        const dv = p.type === "boolean" ? p.defaultValue : `"${p.defaultValue.toLowerCase()}"`;
        return `${p.name} = ${dv}`;
      }
      return p.name;
    })
    .concat(["children"])
    .join(", ");

  lines.push(`/** ${ir.description || ir.figmaName} */`);
  lines.push(`export const ${ir.name}: React.FC<${ir.name}Props> = ({ ${propsDestructure} }) => {`);
  lines.push(`  return (`);

  emitTailwindJSX(ir.defaultTree, lines, "    ", ir, true, maps, variantSpecificProps);

  lines.push(`  );`);
  lines.push(`};`);
  lines.push("");

  return lines.join("\n");
}

function emitTailwindJSX(
  node: ParsedNode,
  lines: string[],
  indent: string,
  ir: ComponentIR,
  isRoot: boolean,
  maps: StyleMap[],
  variantSpecificProps: Set<string>
): void {
  // Component reference
  if (node.componentRef?.componentName) {
    const propsStr = Object.entries(node.componentRef.props)
      .map(([k, v]) => `${k}="${v}"`)
      .join(" ");
    lines.push(`${indent}<${node.componentRef.componentName}${propsStr ? " " + propsStr : ""} />`);
    return;
  }

  const Tag = node.tag;

  // Build className
  let classExpr: string;

  if (isRoot && maps.length > 0) {
    // Root node with style maps:
    // 1. Shared base classes (exclude variant-specific props)
    const sharedStyles: ParsedStyles = {};
    for (const [prop, value] of Object.entries(node.styles)) {
      if (!variantSpecificProps.has(prop) && value !== undefined) {
        sharedStyles[prop] = value;
      }
    }
    const sharedClasses = stylesToTailwind(sharedStyles);

    // 2. Build className array with style map references
    const classItems: string[] = [];

    // Static shared classes as a single string
    if (sharedClasses.length > 0) {
      classItems.push(`"${sharedClasses.join(" ")}"`);
    }

    // Style map lookups
    for (const map of maps) {
      if (map.hasStateInteractions) {
        // Object entries: reference .base and each state key
        classItems.push(`${map.constName}[${map.propName}].base`);
        for (const stateKey of collectStateKeys(map)) {
          classItems.push(`${map.constName}[${map.propName}].${stateKey}`);
        }
      } else {
        // Plain string entries
        classItems.push(`${map.constName}[${map.propName}]`);
      }
    }

    // 3. Shared state overrides for properties NOT in any style map
    // (e.g., hover:bg changes that apply equally across all variants)
    const sharedStateClasses: string[] = [];
    for (const state of ir.stateOverrides) {
      if (state.stateName.includes("-")) continue; // skip scoped overrides
      const overrideStyles = state.overrides[node.className];
      if (!overrideStyles) continue;
      const modifier = selectorToModifier(state.selector);
      for (const [prop, value] of Object.entries(overrideStyles)) {
        if (value === undefined || variantSpecificProps.has(prop)) continue;
        const tw = cssToTailwind(prop, value);
        if (tw) sharedStateClasses.push(`${modifier}:${tw}`);
      }
    }
    if (sharedStateClasses.length > 0) {
      classItems.push(`"${sharedStateClasses.join(" ")}"`);
    }

    // Format as array .join()
    const itemsStr = classItems.map((item) => `${indent}  ${item},`).join("\n");
    classExpr = `{[\n${itemsStr}\n${indent}].filter(Boolean).join(" ")}`;
  } else {
    // Child nodes or no style maps: same as before
    const baseClasses = stylesToTailwind(node.styles);
    const stateClasses = stateOverridesToTailwind(ir, node.className);
    const allClasses = [...baseClasses, ...stateClasses];
    classExpr = `"${allClasses.join(" ")}"`;
  }

  // Text content
  if (node.textContent !== undefined && node.children.length === 0) {
    const textProp = ir.props.find(
      (p) => p.source === "text-content" && p.defaultValue === node.textContent
    );
    const content = textProp ? `{${textProp.name}}` : node.textContent;
    lines.push(`${indent}<${Tag} className=${classExpr}>${content}</${Tag}>`);
    return;
  }

  if (node.children.length === 0) {
    lines.push(`${indent}<${Tag} className=${classExpr} />`);
    return;
  }

  lines.push(`${indent}<${Tag} className=${classExpr}>`);
  for (const child of node.children) {
    emitTailwindJSX(child, lines, indent + "  ", ir, false, maps, variantSpecificProps);
  }
  lines.push(`${indent}</${Tag}>`);
}

function camelToKebab(str: string): string {
  return str.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

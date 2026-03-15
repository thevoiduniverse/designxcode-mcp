/**
 * Code emitter: React Native.
 * Produces a single .tsx file using RN primitives + StyleSheet.create().
 * All values are resolved literals (React Native doesn't support CSS variables).
 */

import type {
  ComponentIR,
  ParsedNode,
  ParsedStyles,
  ResolvedValue,
  EmittedComponent,
} from "../types/node-ir.js";

export function emitReactNative(ir: ComponentIR, outputDir: string): EmittedComponent {
  const content = generateRN(ir);

  return {
    componentName: ir.name,
    figmaName: ir.figmaName,
    figmaUrl: ir.figmaUrl,
    files: [
      {
        path: `${outputDir}/${ir.name}/${ir.name}.tsx`,
        content,
        description: `React Native component with StyleSheet`,
      },
    ],
    props: ir.props,
    dependencies: ir.dependencies,
    warnings: [
      ...ir.warnings,
      "React Native: All values are resolved literals. Design token changes require re-generation.",
    ],
  };
}

// ─── RN Generation ───

function generateRN(ir: ComponentIR): string {
  const lines: string[] = [];

  // Determine which RN imports we need
  const needsPressable = ir.stateOverrides.some((s) =>
    s.selector.includes(":hover") || s.selector.includes(":active")
  );
  const rnImports = ["StyleSheet"];
  if (needsPressable) {
    rnImports.push("Pressable");
  } else {
    rnImports.push("View");
  }
  if (hasTextNode(ir.defaultTree)) rnImports.push("Text");

  lines.push(`import React from "react";`);
  lines.push(`import { ${rnImports.join(", ")} } from "react-native";`);

  for (const dep of ir.dependencies) {
    lines.push(`import { ${dep} } from "../${dep}/${dep}";`);
  }
  lines.push("");

  // Props interface
  lines.push(`export interface ${ir.name}Props {`);
  for (const prop of ir.props) {
    if (prop.type === "boolean") {
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

  if (needsPressable) {
    // Find pressed state styles
    const pressedOverrides = ir.stateOverrides.find((s) =>
      s.selector.includes(":active")
    );
    const disabledProp = ir.props.find((p) => p.name === "disabled");

    lines.push(`  return (`);
    lines.push(`    <Pressable`);
    if (disabledProp) lines.push(`      disabled={disabled}`);
    lines.push(`      style={({ pressed }) => [`);
    lines.push(`        rnStyles["${ir.defaultTree.className}"],`);

    // Dimensional variants
    for (const dim of ir.props.filter((p) => p.source === "variant" && p.type === "enum")) {
      for (const variant of ir.dimensionalVariants.filter((v) => v.propName.toLowerCase() === dim.name.toLowerCase())) {
        const styleName = sanitizeStyleName(`${variant.propValue}`);
        lines.push(`        ${dim.name} === "${variant.propValue.toLowerCase()}" && rnStyles["${styleName}"],`);
      }
    }

    if (pressedOverrides) {
      lines.push(`        pressed && rnStyles.pressed,`);
    }
    if (disabledProp) {
      const disabledOverride = ir.stateOverrides.find((s) => s.selector.includes(":disabled"));
      if (disabledOverride) {
        lines.push(`        disabled && rnStyles.disabled,`);
      }
    }
    lines.push(`      ]}`);
    lines.push(`    >`);

    // Render children
    for (const child of ir.defaultTree.children) {
      emitRNNode(child, lines, "      ", ir);
    }
    if (ir.defaultTree.children.length === 0) {
      lines.push(`      {children}`);
    }

    lines.push(`    </Pressable>`);
  } else {
    lines.push(`  return (`);
    lines.push(`    <View style={rnStyles["${ir.defaultTree.className}"]}>`);
    for (const child of ir.defaultTree.children) {
      emitRNNode(child, lines, "      ", ir);
    }
    lines.push(`    </View>`);
  }

  lines.push(`  );`);
  lines.push(`};`);
  lines.push("");

  // StyleSheet
  lines.push(`const rnStyles = StyleSheet.create({`);

  // Base styles
  emitRNStyleEntry(ir.defaultTree.className, cssToRNStyles(ir.defaultTree.styles, ir.defaultTree.resolvedValues), lines);

  // Child styles
  collectRNStyles(ir.defaultTree, lines);

  // State override styles
  for (const state of ir.stateOverrides) {
    const rootOverride = state.overrides[ir.defaultTree.className];
    if (rootOverride) {
      const styleName = state.selector.includes(":active") ? "pressed"
        : state.selector.includes(":disabled") ? "disabled"
        : sanitizeStyleName(state.stateName);
      const rv = state.resolvedOverrides?.[ir.defaultTree.className];
      emitRNStyleEntry(styleName, cssToRNStyles(rootOverride as ParsedStyles, rv), lines);
    }
  }

  // Dimensional variant styles
  for (const variant of ir.dimensionalVariants) {
    const rootOverride = variant.overrides[ir.defaultTree.className];
    if (rootOverride) {
      const rv = variant.resolvedOverrides?.[ir.defaultTree.className];
      emitRNStyleEntry(
        sanitizeStyleName(variant.propValue),
        cssToRNStyles(rootOverride as ParsedStyles, rv),
        lines
      );
    }
  }

  lines.push(`});`);
  lines.push("");

  return lines.join("\n");
}

function emitRNNode(
  node: ParsedNode,
  lines: string[],
  indent: string,
  ir: ComponentIR
): void {
  if (node.componentRef?.componentName) {
    const propsStr = Object.entries(node.componentRef.props)
      .map(([k, v]) => `${k}="${v}"`)
      .join(" ");
    lines.push(`${indent}<${node.componentRef.componentName}${propsStr ? " " + propsStr : ""} />`);
    return;
  }

  if (node.textContent !== undefined) {
    const textProp = ir.props.find(
      (p) => p.source === "text-content" && p.defaultValue === node.textContent
    );
    const content = textProp ? `{${textProp.name}}` : `"${node.textContent}"`;
    lines.push(`${indent}<Text style={rnStyles["${node.className}"]}>${content}</Text>`);
    return;
  }

  if (node.children.length === 0) {
    lines.push(`${indent}<View style={rnStyles["${node.className}"]} />`);
    return;
  }

  lines.push(`${indent}<View style={rnStyles["${node.className}"]}>`);
  for (const child of node.children) {
    emitRNNode(child, lines, indent + "  ", ir);
  }
  lines.push(`${indent}</View>`);
}

function collectRNStyles(node: ParsedNode, lines: string[]): void {
  for (const child of node.children) {
    if (child.componentRef) continue;
    const rnStyles = cssToRNStyles(child.styles, child.resolvedValues);
    if (Object.keys(rnStyles).length > 0) {
      emitRNStyleEntry(child.className, rnStyles, lines);
    }
    collectRNStyles(child, lines);
  }
}

function emitRNStyleEntry(
  name: string,
  styles: Record<string, string | number>,
  lines: string[]
): void {
  if (Object.keys(styles).length === 0) return;
  const entries = Object.entries(styles)
    .map(([k, v]) => `    ${k}: ${typeof v === "string" ? `"${v}"` : v},`)
    .join("\n");
  lines.push(`  "${name}": {\n${entries}\n  },`);
}

// ─── CSS to React Native Style Conversion ───

function cssToRNStyles(
  styles: ParsedStyles,
  resolvedValues?: Map<string, ResolvedValue>
): Record<string, string | number> {
  const rn: Record<string, string | number> = {};

  for (const [prop, value] of Object.entries(styles)) {
    if (value === undefined) continue;
    // Use the literal value from resolvedValues if available (for token-bound values)
    const rv = resolvedValues?.get(prop);
    const resolved = rv ? rv.literal : value;

    switch (prop) {
      case "display":
        if (value === "flex") rn.display = "flex";
        break;
      case "flexDirection":
        rn.flexDirection = value as string;
        break;
      case "justifyContent":
        rn.justifyContent = value as string;
        break;
      case "alignItems":
        rn.alignItems = value as string;
        break;
      case "flexWrap":
        rn.flexWrap = value as string;
        break;
      case "flex":
        rn.flex = parseFloat(value) || 1;
        break;
      case "gap":
        rn.gap = parseNumericPx(resolved);
        break;
      case "rowGap":
        rn.rowGap = parseNumericPx(resolved);
        break;
      case "columnGap":
        rn.columnGap = parseNumericPx(resolved);
        break;
      case "padding":
        rn.padding = parseNumericPx(resolved);
        break;
      case "paddingTop":
        rn.paddingTop = parseNumericPx(resolved);
        break;
      case "paddingRight":
        rn.paddingRight = parseNumericPx(resolved);
        break;
      case "paddingBottom":
        rn.paddingBottom = parseNumericPx(resolved);
        break;
      case "paddingLeft":
        rn.paddingLeft = parseNumericPx(resolved);
        break;
      case "width":
        rn.width = parseNumericPx(resolved);
        break;
      case "height":
        rn.height = parseNumericPx(resolved);
        break;
      case "minWidth":
        rn.minWidth = parseNumericPx(resolved);
        break;
      case "maxWidth":
        rn.maxWidth = parseNumericPx(resolved);
        break;
      case "minHeight":
        rn.minHeight = parseNumericPx(resolved);
        break;
      case "maxHeight":
        rn.maxHeight = parseNumericPx(resolved);
        break;
      case "background":
        rn.backgroundColor = resolved;
        break;
      case "color":
        rn.color = resolved;
        break;
      case "borderRadius":
        rn.borderRadius = parseNumericPx(resolved);
        break;
      case "opacity":
        rn.opacity = parseFloat(value);
        break;
      case "overflow":
        rn.overflow = value as string;
        break;
      case "fontFamily":
        rn.fontFamily = value.replace(/'/g, "").split(",")[0].trim();
        break;
      case "fontSize":
        rn.fontSize = parseNumericPx(resolved);
        break;
      case "fontWeight":
        rn.fontWeight = value as string;
        break;
      case "lineHeight":
        rn.lineHeight = parseNumericPx(resolved);
        break;
      case "letterSpacing":
        rn.letterSpacing = parseNumericPx(resolved);
        break;
      case "textAlign":
        rn.textAlign = value as string;
        break;
      case "textTransform":
        rn.textTransform = value as string;
        break;
      case "textDecoration":
        if (value === "underline") rn.textDecorationLine = "underline";
        if (value === "line-through") rn.textDecorationLine = "line-through";
        break;
      // Skip properties that don't map to RN
      default:
        break;
    }
  }

  return rn;
}

// ─── Helpers ───

function hasTextNode(node: ParsedNode): boolean {
  if (node.textContent !== undefined) return true;
  return node.children.some(hasTextNode);
}

function parseNumericPx(value: string): number | string {
  // Handle percentage values (e.g., "100%")
  if (value.endsWith("%")) return value;
  const match = value.match(/^([\d.]+)(?:px)?$/);
  return match ? parseFloat(match[1]) : 0;
}

function sanitizeStyleName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9]/g, "")
    .replace(/^([A-Z])/, (m) => m.toLowerCase());
}

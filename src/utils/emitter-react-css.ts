/**
 * Code emitter: React + CSS Modules.
 * Produces two files per component: {Name}.tsx + {Name}.module.css
 */

import type {
  ComponentIR,
  ParsedNode,
  ParsedStyles,
  StateOverride,
  DimensionalVariant,
  EmittedComponent,
} from "../types/node-ir.js";

export function emitReactCSS(ir: ComponentIR, outputDir: string): EmittedComponent {
  const cssContent = generateCSS(ir);
  const tsxContent = generateTSX(ir);

  return {
    componentName: ir.name,
    figmaName: ir.figmaName,
    figmaUrl: ir.figmaUrl,
    files: [
      {
        path: `${outputDir}/${ir.name}/${ir.name}.tsx`,
        content: tsxContent,
        description: `React component with CSS Modules`,
      },
      {
        path: `${outputDir}/${ir.name}/${ir.name}.module.css`,
        content: cssContent,
        description: `CSS Modules styles`,
      },
    ],
    props: ir.props,
    dependencies: ir.dependencies,
    warnings: ir.warnings,
  };
}

// ─── CSS Generation ───

function generateCSS(ir: ComponentIR): string {
  const lines: string[] = [];
  lines.push(`/* Generated from Figma: ${ir.figmaName} */`);
  lines.push(`/* ${ir.figmaUrl} */\n`);

  // Base styles from default tree
  emitNodeCSS(ir.defaultTree, lines, "");

  // State overrides
  for (const state of ir.stateOverrides) {
    lines.push("");
    for (const [className, overrideStyles] of Object.entries(state.overrides)) {
      const selector = className === ir.defaultTree.className
        ? `.${className}${state.selector}`
        : `.${ir.defaultTree.className}${state.selector} .${className}`;
      lines.push(`${selector} {`);
      emitStyleBlock(overrideStyles, lines);
      lines.push("}");
    }
  }

  // Dimensional variants
  for (const variant of ir.dimensionalVariants) {
    lines.push("");
    lines.push(`/* ${variant.propName}=${variant.propValue} */`);
    for (const [className, overrideStyles] of Object.entries(variant.overrides)) {
      const selector = className === ir.defaultTree.className
        ? `.${variant.modifierClass}`
        : `.${variant.modifierClass} .${className}`;
      lines.push(`${selector} {`);
      emitStyleBlock(overrideStyles, lines);
      lines.push("}");
    }
  }

  lines.push("");
  return lines.join("\n");
}

function emitNodeCSS(node: ParsedNode, lines: string[], indent: string): void {
  if (node.componentRef) return; // Skip — rendered as component import

  const styleEntries = Object.entries(node.styles).filter(([, v]) => v !== undefined);
  if (styleEntries.length > 0) {
    lines.push(`${indent}.${node.className} {`);
    emitStyleBlock(node.styles, lines, indent);
    lines.push(`${indent}}`);
  }

  for (const child of node.children) {
    emitNodeCSS(child, lines, indent);
  }
}

function emitStyleBlock(
  styles: Partial<ParsedStyles>,
  lines: string[],
  indent: string = ""
): void {
  for (const [prop, value] of Object.entries(styles)) {
    if (value === undefined) continue;
    lines.push(`${indent}  ${camelToKebab(prop)}: ${value};`);
  }
}

// ─── TSX Generation ───

function generateTSX(ir: ComponentIR): string {
  const lines: string[] = [];

  // Imports
  lines.push(`import React from "react";`);
  lines.push(`import styles from "./${ir.name}.module.css";`);

  // Component dependency imports
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
  // Add text content props
  const textProps = ir.props.filter((p) => p.source === "text-content");
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

  // Build className expression
  const dimProps = ir.props.filter((p) => p.source === "variant" && p.type === "enum");
  if (dimProps.length > 0) {
    const parts = [`styles["${ir.defaultTree.className}"]`];
    for (const dim of dimProps) {
      parts.push(`styles[\`${ir.defaultTree.className}--\${${dim.name}}\`]`);
    }
    lines.push(`  const className = [${parts.join(", ")}].filter(Boolean).join(" ");`);
  }

  // Render tree
  lines.push(`  return (`);
  const classExpr = dimProps.length > 0 ? "className" : `styles["${ir.defaultTree.className}"]`;
  emitJSXNode(ir.defaultTree, lines, "    ", classExpr, true, ir);
  lines.push(`  );`);
  lines.push(`};`);
  lines.push("");

  return lines.join("\n");
}

function emitJSXNode(
  node: ParsedNode,
  lines: string[],
  indent: string,
  classExpr: string | null,
  isRoot: boolean,
  ir: ComponentIR
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
  const classAttr = isRoot && classExpr
    ? ` className={${classExpr}}`
    : ` className={styles["${node.className}"]}`;

  // Text content node
  if (node.textContent !== undefined && node.children.length === 0) {
    if (node.isTextProp) {
      // Find the matching text prop
      const textProp = ir.props.find(
        (p) => p.source === "text-content" && p.defaultValue === node.textContent
      );
      const content = textProp ? `{${textProp.name}}` : node.textContent;
      lines.push(`${indent}<${Tag}${classAttr}>${content}</${Tag}>`);
    } else {
      lines.push(`${indent}<${Tag}${classAttr}>${node.textContent}</${Tag}>`);
    }
    return;
  }

  // Container node
  if (node.children.length === 0) {
    lines.push(`${indent}<${Tag}${classAttr} />`);
    return;
  }

  lines.push(`${indent}<${Tag}${classAttr}>`);
  for (const child of node.children) {
    emitJSXNode(child, lines, indent + "  ", null, false, ir);
  }
  lines.push(`${indent}</${Tag}>`);
}

// ─── Helpers ───

function camelToKebab(str: string): string {
  return str.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

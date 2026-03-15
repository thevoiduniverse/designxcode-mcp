/**
 * Code emitter: HTML + CSS.
 * Produces a .css file with BEM naming and a .html usage example.
 */

import type {
  ComponentIR,
  ParsedNode,
  ParsedStyles,
  EmittedComponent,
} from "../types/node-ir.js";

export function emitHTMLCSS(ir: ComponentIR, outputDir: string): EmittedComponent {
  const rootClass = ir.defaultTree.className;
  const cssContent = generateCSS(ir, rootClass);
  const htmlContent = generateHTML(ir, rootClass);

  return {
    componentName: ir.name,
    figmaName: ir.figmaName,
    figmaUrl: ir.figmaUrl,
    files: [
      {
        path: `${outputDir}/${ir.name}/${ir.name.toLowerCase()}.css`,
        content: cssContent,
        description: `CSS styles with BEM naming`,
      },
      {
        path: `${outputDir}/${ir.name}/${ir.name.toLowerCase()}.html`,
        content: htmlContent,
        description: `HTML usage example`,
      },
    ],
    props: ir.props,
    dependencies: ir.dependencies,
    warnings: ir.warnings,
  };
}

// ─── CSS ───

function generateCSS(ir: ComponentIR, rootClass: string): string {
  const lines: string[] = [];
  lines.push(`/* Generated from Figma: ${ir.figmaName} */`);
  lines.push(`/* ${ir.figmaUrl} */\n`);

  // Base styles
  emitNodeCSS(ir.defaultTree, lines, rootClass);

  // State overrides
  for (const state of ir.stateOverrides) {
    lines.push("");
    for (const [className, styles] of Object.entries(state.overrides)) {
      const selector = className === rootClass
        ? `.${rootClass}${state.selector}`
        : `.${rootClass}${state.selector} .${rootClass}__${className}`;
      lines.push(`${selector} {`);
      emitStyles(styles, lines);
      lines.push("}");
    }
  }

  // Dimensional variants
  for (const variant of ir.dimensionalVariants) {
    lines.push("");
    lines.push(`/* ${variant.propName}=${variant.propValue} */`);
    for (const [className, styles] of Object.entries(variant.overrides)) {
      const selector = className === rootClass
        ? `.${variant.modifierClass}`
        : `.${variant.modifierClass} .${rootClass}__${className}`;
      lines.push(`${selector} {`);
      emitStyles(styles, lines);
      lines.push("}");
    }
  }

  lines.push("");
  return lines.join("\n");
}

function emitNodeCSS(node: ParsedNode, lines: string[], rootClass: string): void {
  if (node.componentRef) return;

  const entries = Object.entries(node.styles).filter(([, v]) => v !== undefined);
  if (entries.length > 0) {
    const selector = node.className === rootClass
      ? `.${rootClass}`
      : `.${rootClass}__${node.className}`;
    lines.push(`${selector} {`);
    emitStyles(node.styles, lines);
    lines.push("}");
  }

  for (const child of node.children) {
    emitNodeCSS(child, lines, rootClass);
  }
}

function emitStyles(styles: Partial<ParsedStyles>, lines: string[]): void {
  for (const [prop, value] of Object.entries(styles)) {
    if (value === undefined) continue;
    lines.push(`  ${camelToKebab(prop)}: ${value};`);
  }
}

// ─── HTML ───

function generateHTML(ir: ComponentIR, rootClass: string): string {
  const lines: string[] = [];
  lines.push(`<!-- Generated from Figma: ${ir.figmaName} -->`);
  lines.push(`<!-- ${ir.figmaUrl} -->`);
  lines.push(`<!-- Usage example -->\n`);
  lines.push(`<link rel="stylesheet" href="${ir.name.toLowerCase()}.css" />\n`);

  emitHTMLNode(ir.defaultTree, lines, "", rootClass);

  // Show variant examples
  const dimProps = ir.props.filter((p) => p.source === "variant" && p.type === "enum");
  if (dimProps.length > 0) {
    lines.push(`\n<!-- Variant examples -->`);
    for (const dim of dimProps) {
      for (const val of dim.values ?? []) {
        if (val === dim.defaultValue) continue;
        lines.push(`<!-- ${dim.name}="${val}" -->`);
        lines.push(`<div class="${rootClass} ${rootClass}--${val.toLowerCase()}">`);
        lines.push(`  ...`);
        lines.push(`</div>`);
      }
    }
  }

  lines.push("");
  return lines.join("\n");
}

function emitHTMLNode(
  node: ParsedNode,
  lines: string[],
  indent: string,
  rootClass: string
): void {
  if (node.componentRef?.componentName) {
    lines.push(`${indent}<!-- ${node.componentRef.componentName} component -->`);
    return;
  }

  const cls = node.className === rootClass
    ? rootClass
    : `${rootClass}__${node.className}`;

  if (node.textContent !== undefined && node.children.length === 0) {
    lines.push(`${indent}<${node.tag} class="${cls}">${node.textContent}</${node.tag}>`);
    return;
  }

  if (node.children.length === 0) {
    lines.push(`${indent}<${node.tag} class="${cls}"></${node.tag}>`);
    return;
  }

  lines.push(`${indent}<${node.tag} class="${cls}">`);
  for (const child of node.children) {
    emitHTMLNode(child, lines, indent + "  ", rootClass);
  }
  lines.push(`${indent}</${node.tag}>`);
}

function camelToKebab(str: string): string {
  return str.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

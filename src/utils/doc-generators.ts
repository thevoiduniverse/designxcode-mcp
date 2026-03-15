/**
 * Format-specific document generators for design system documentation.
 * Each function takes structured design data and returns a complete document string.
 */

import type { FlatToken } from "./context-formatter.js";
import type { ComponentWithProps } from "./context-formatter.js";
import type { PatternGroup } from "./context-formatter.js";
import { toPascalCase, toCamelCase } from "./scaffold-templates.js";

// ─── Shared Types ───

export interface DocData {
  title: string;
  fileKey: string;
  generatedAt: string;
  colors: FlatToken[];
  typography: FlatToken[];
  spacing: FlatToken[];
  components: ComponentWithProps[];
  patterns: PatternGroup[];
  previews: Map<string, string>;  // nodeId → imageUrl
  warnings: string[];
}

// ─── Token Grouping ───

interface TokenGroup {
  name: string;
  tokens: FlatToken[];
}

function groupColorsByCategory(colors: FlatToken[]): TokenGroup[] {
  const groups = new Map<string, FlatToken[]>();
  for (const token of colors) {
    // Use the second-to-last path segment as group, or "Other" if flat
    const group = token.path.length >= 2
      ? token.path[token.path.length - 2].charAt(0).toUpperCase() + token.path[token.path.length - 2].slice(1)
      : "Other";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push(token);
  }
  return Array.from(groups.entries()).map(([name, tokens]) => ({ name, tokens }));
}

// ─── Markdown Generator ───

export function generateMarkdown(data: DocData): string {
  const lines: string[] = [];

  // Header
  lines.push(`# ${data.title}`);
  lines.push("");
  lines.push(`> Generated from Figma on ${data.generatedAt} — [Open in Figma](https://www.figma.com/design/${data.fileKey})`);
  lines.push("");

  if (data.warnings.length > 0) {
    for (const w of data.warnings) {
      lines.push(`> ⚠ ${w}`);
    }
    lines.push("");
  }

  // Colors
  if (data.colors.length > 0) {
    lines.push("## Color Palette");
    lines.push("");
    const groups = groupColorsByCategory(data.colors);
    for (const group of groups) {
      lines.push(`### ${group.name}`);
      lines.push("");
      lines.push("| Swatch | Variable | Value |");
      lines.push("|--------|----------|-------|");
      for (const token of group.tokens) {
        lines.push(`| ■ | \`--${token.name}\` | \`${token.value}\` |`);
      }
      lines.push("");
    }
  }

  // Typography
  if (data.typography.length > 0) {
    lines.push("## Typography Scale");
    lines.push("");
    lines.push("| Variable | Value |");
    lines.push("|----------|-------|");
    for (const token of data.typography) {
      lines.push(`| \`--${token.name}\` | ${token.value} |`);
    }
    lines.push("");
  }

  // Spacing
  if (data.spacing.length > 0) {
    lines.push("## Spacing Scale");
    lines.push("");
    lines.push("| Variable | Value | Visual |");
    lines.push("|----------|-------|--------|");
    const maxVal = Math.max(...data.spacing.map((t) => Number(t.value) || 0));
    for (const token of data.spacing) {
      const val = Number(token.value) || 0;
      const barLength = maxVal > 0 ? Math.round((val / maxVal) * 20) : 0;
      const bar = "█".repeat(barLength);
      lines.push(`| \`--${token.name}\` | ${token.value}px | ${bar} |`);
    }
    lines.push("");
  }

  // Components
  if (data.components.length > 0) {
    lines.push("## Component Catalog");
    lines.push("");
    lines.push("> Preview images are temporary Figma CDN links. For permanent documentation, download images and host them separately.");
    lines.push("");

    for (const { component, props, variantCount } of data.components) {
      const name = toPascalCase(component.name);
      lines.push(`### ${name}`);
      lines.push("");

      if (component.description) {
        lines.push(component.description);
        lines.push("");
      }

      // Preview
      const previewUrl = data.previews.get(component.nodeId ?? component.key);
      if (previewUrl) {
        lines.push(`![${name} preview](${previewUrl})`);
        lines.push("");
      }

      // Props table
      if (props.length > 0) {
        lines.push("| Prop | Type | Values | Default |");
        lines.push("|------|------|--------|---------|");
        for (const prop of props) {
          const values = prop.type === "enum" && prop.values ? prop.values.join(", ") : "—";
          lines.push(`| ${toCamelCase(prop.name)} | ${prop.type} | ${values} | ${prop.defaultValue ?? "—"} |`);
        }
        lines.push("");
      }

      // Usage
      const usageProps = props
        .filter((p) => p.defaultValue !== undefined)
        .map((p) => p.type === "boolean" ? toCamelCase(p.name) : `${toCamelCase(p.name)}="${p.defaultValue}"`)
        .join(" ");
      lines.push("```jsx");
      lines.push(`<${name}${usageProps ? " " + usageProps : ""}>content</${name}>`);
      lines.push("```");
      lines.push("");

      if (component.figmaUrl) {
        lines.push(`[Open in Figma](${component.figmaUrl})`);
        lines.push("");
      }
    }
  }

  // Patterns
  if (data.patterns.length > 0 && data.patterns.some((g) => g.patterns.length > 0)) {
    lines.push("## Usage Patterns");
    lines.push("");
    for (const group of data.patterns) {
      if (group.patterns.length === 0) continue;
      lines.push(`### ${group.category}`);
      for (const pattern of group.patterns) {
        lines.push(`- ${pattern}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

// ─── MDX Generator ───

export function generateMDX(data: DocData): string {
  const lines: string[] = [];

  lines.push("{/* Required components: ColorSwatch, TypeSample, SpacingScale, PropsTable, ComponentPreview */}");
  lines.push("{/* Provide these via your MDX provider or import them from your component library */}");
  lines.push("");

  // Header
  lines.push(`# ${data.title}`);
  lines.push("");
  lines.push(`> Generated from Figma on ${data.generatedAt} — [Open in Figma](https://www.figma.com/design/${data.fileKey})`);
  lines.push("");

  if (data.warnings.length > 0) {
    for (const w of data.warnings) {
      lines.push(`> ⚠ ${w}`);
    }
    lines.push("");
  }

  // Colors
  if (data.colors.length > 0) {
    lines.push("## Color Palette");
    lines.push("");
    const groups = groupColorsByCategory(data.colors);
    for (const group of groups) {
      lines.push(`### ${group.name}`);
      lines.push("");
      for (const token of group.tokens) {
        lines.push(`<ColorSwatch name="--${token.name}" hex="${token.value}" />`);
      }
      lines.push("");
    }
  }

  // Typography
  if (data.typography.length > 0) {
    lines.push("## Typography Scale");
    lines.push("");
    for (const token of data.typography) {
      const n = token.name.toLowerCase();
      if (n.includes("family") || n.includes("font-family")) {
        lines.push(`<TypeSample name="--${token.name}" fontFamily="${token.value}" fontSize={16} fontWeight={400} />`);
      } else if (n.includes("size") || n.includes("font-size")) {
        lines.push(`<TypeSample name="--${token.name}" fontFamily="inherit" fontSize={${token.value}} fontWeight={400} />`);
      } else {
        lines.push(`- \`--${token.name}\`: ${token.value}`);
      }
    }
    lines.push("");
  }

  // Spacing
  if (data.spacing.length > 0) {
    lines.push("## Spacing Scale");
    lines.push("");
    const tokenData = data.spacing.map((t) => `{name: "--${t.name}", value: ${t.value}}`);
    lines.push(`<SpacingScale tokens={[${tokenData.join(", ")}]} />`);
    lines.push("");
  }

  // Components
  if (data.components.length > 0) {
    lines.push("## Component Catalog");
    lines.push("");
    lines.push("> Preview images are temporary Figma CDN links.");
    lines.push("");

    for (const { component, props, variantCount } of data.components) {
      const name = toPascalCase(component.name);
      lines.push(`### ${name}`);
      lines.push("");

      if (component.description) {
        lines.push(component.description);
        lines.push("");
      }

      const previewUrl = data.previews.get(component.nodeId ?? component.key);
      if (previewUrl) {
        lines.push(`<ComponentPreview src="${previewUrl}" alt="${name}" />`);
        lines.push("");
      }

      if (props.length > 0) {
        const propsData = props.map((p) => ({
          name: toCamelCase(p.name),
          type: p.type,
          values: p.type === "enum" && p.values ? p.values : undefined,
          defaultValue: p.defaultValue,
        }));
        lines.push(`<PropsTable props={${JSON.stringify(propsData)}} />`);
        lines.push("");
      }

      const usageProps = props
        .filter((p) => p.defaultValue !== undefined)
        .map((p) => p.type === "boolean" ? toCamelCase(p.name) : `${toCamelCase(p.name)}="${p.defaultValue}"`)
        .join(" ");
      lines.push("```jsx");
      lines.push(`<${name}${usageProps ? " " + usageProps : ""}>content</${name}>`);
      lines.push("```");
      lines.push("");
    }
  }

  // Patterns
  if (data.patterns.length > 0 && data.patterns.some((g) => g.patterns.length > 0)) {
    lines.push("## Usage Patterns");
    lines.push("");
    for (const group of data.patterns) {
      if (group.patterns.length === 0) continue;
      lines.push(`### ${group.category}`);
      for (const pattern of group.patterns) {
        lines.push(`- ${pattern}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

// ─── HTML Generator ───

const HTML_TEMPLATE_START = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TITLE_PLACEHOLDER — Design System</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; max-width: 960px; margin: 0 auto; padding: 32px 24px; color: #1a1a1a; background: #fff; }
    h1 { font-size: 28px; margin-bottom: 8px; }
    h2 { font-size: 22px; margin: 40px 0 16px; border-bottom: 1px solid #e5e5e5; padding-bottom: 8px; }
    h3 { font-size: 18px; margin: 24px 0 12px; }
    table { width: 100%; border-collapse: collapse; margin: 12px 0; }
    th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #e5e5e5; font-size: 14px; }
    th { font-weight: 600; background: #f9f9f9; }
    code { background: #f3f3f3; padding: 2px 6px; border-radius: 3px; font-size: 13px; }
    pre { background: #f3f3f3; padding: 16px; border-radius: 6px; overflow-x: auto; margin: 12px 0; }
    pre code { background: none; padding: 0; }
    .swatch { width: 32px; height: 32px; border-radius: 4px; border: 1px solid #e5e5e5; display: inline-block; vertical-align: middle; }
    .color-row { display: flex; align-items: center; gap: 12px; padding: 6px 0; }
    .spacing-bar { background: #6366F1; height: 12px; border-radius: 2px; }
    .component-card { border: 1px solid #e5e5e5; border-radius: 8px; padding: 20px; margin: 16px 0; }
    .component-card img { max-width: 100%; height: auto; max-height: 300px; border-radius: 4px; margin: 12px 0; }
    .warning { background: #FEF3C7; border-left: 4px solid #F59E0B; padding: 12px 16px; margin: 12px 0; border-radius: 0 4px 4px 0; }
    .subtitle { color: #666; font-size: 14px; margin-bottom: 24px; }
    nav { margin: 24px 0; }
    nav a { color: #6366F1; text-decoration: none; display: block; padding: 4px 0; }
    nav a:hover { text-decoration: underline; }
  </style>
</head>
<body>`;

const HTML_TEMPLATE_END = `</body>\n</html>`;

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function generateHTML(data: DocData): string {
  const parts: string[] = [HTML_TEMPLATE_START.replace("TITLE_PLACEHOLDER", escapeHtml(data.title))];

  // Header
  parts.push(`  <h1>${escapeHtml(data.title)}</h1>`);
  parts.push(`  <p class="subtitle">Generated from Figma on ${data.generatedAt} — <a href="https://www.figma.com/design/${data.fileKey}">Open in Figma</a></p>`);

  if (data.warnings.length > 0) {
    for (const w of data.warnings) {
      parts.push(`  <div class="warning">${escapeHtml(w)}</div>`);
    }
  }

  // Table of contents
  const toc: string[] = [];
  if (data.colors.length > 0) toc.push('<a href="#colors">Color Palette</a>');
  if (data.typography.length > 0) toc.push('<a href="#typography">Typography Scale</a>');
  if (data.spacing.length > 0) toc.push('<a href="#spacing">Spacing Scale</a>');
  if (data.components.length > 0) toc.push('<a href="#components">Component Catalog</a>');
  if (data.patterns.some((g) => g.patterns.length > 0)) toc.push('<a href="#patterns">Usage Patterns</a>');

  if (toc.length > 0) {
    parts.push("  <nav>");
    parts.push("    <strong>Contents</strong>");
    parts.push(toc.map((a) => `    ${a}`).join("\n"));
    parts.push("  </nav>");
  }

  // Colors
  if (data.colors.length > 0) {
    parts.push('  <h2 id="colors">Color Palette</h2>');
    const groups = groupColorsByCategory(data.colors);
    for (const group of groups) {
      parts.push(`  <h3>${escapeHtml(group.name)}</h3>`);
      for (const token of group.tokens) {
        parts.push(`  <div class="color-row"><div class="swatch" style="background:${token.value}"></div><code>--${escapeHtml(token.name)}</code> ${escapeHtml(String(token.value))}</div>`);
      }
    }
  }

  // Typography
  if (data.typography.length > 0) {
    parts.push('  <h2 id="typography">Typography Scale</h2>');
    for (const token of data.typography) {
      const n = token.name.toLowerCase();
      if (n.includes("family") || n.includes("font-family")) {
        parts.push(`  <p style="font-family:${token.value},sans-serif;font-size:16px;margin:8px 0"><code>--${escapeHtml(token.name)}</code>: ${escapeHtml(String(token.value))} — The quick brown fox jumps over the lazy dog</p>`);
      } else if (n.includes("size") || n.includes("font-size")) {
        parts.push(`  <p style="font-size:${token.value}px;margin:8px 0"><code>--${escapeHtml(token.name)}</code>: ${token.value}px — The quick brown fox</p>`);
      } else {
        parts.push(`  <p style="margin:4px 0"><code>--${escapeHtml(token.name)}</code>: ${escapeHtml(String(token.value))}</p>`);
      }
    }
  }

  // Spacing
  if (data.spacing.length > 0) {
    parts.push('  <h2 id="spacing">Spacing Scale</h2>');
    const maxVal = Math.max(...data.spacing.map((t) => Number(t.value) || 0));
    for (const token of data.spacing) {
      const val = Number(token.value) || 0;
      const pct = maxVal > 0 ? (val / maxVal) * 100 : 0;
      parts.push(`  <div style="display:flex;align-items:center;gap:12px;padding:4px 0">`);
      parts.push(`    <code style="min-width:180px">--${escapeHtml(token.name)}</code>`);
      parts.push(`    <span style="min-width:50px">${val}px</span>`);
      parts.push(`    <div class="spacing-bar" style="width:${pct}%"></div>`);
      parts.push(`  </div>`);
    }
  }

  // Components
  if (data.components.length > 0) {
    parts.push('  <h2 id="components">Component Catalog</h2>');
    parts.push('  <p class="warning">Preview images are temporary Figma CDN links. For permanent documentation, download images and host them separately.</p>');

    for (const { component, props, variantCount } of data.components) {
      const name = toPascalCase(component.name);
      parts.push('  <div class="component-card">');
      parts.push(`    <h3>${escapeHtml(name)}</h3>`);

      if (component.description) {
        parts.push(`    <p>${escapeHtml(component.description)}</p>`);
      }

      const previewUrl = data.previews.get(component.nodeId ?? component.key);
      if (previewUrl) {
        parts.push(`    <img src="${escapeHtml(previewUrl)}" alt="${escapeHtml(name)} preview" />`);
      }

      if (props.length > 0) {
        parts.push("    <table>");
        parts.push("      <tr><th>Prop</th><th>Type</th><th>Values</th><th>Default</th></tr>");
        for (const prop of props) {
          const values = prop.type === "enum" && prop.values ? prop.values.join(", ") : "—";
          parts.push(`      <tr><td>${escapeHtml(toCamelCase(prop.name))}</td><td>${prop.type}</td><td>${escapeHtml(values)}</td><td>${prop.defaultValue ?? "—"}</td></tr>`);
        }
        parts.push("    </table>");
      }

      const usageProps = props
        .filter((p) => p.defaultValue !== undefined)
        .map((p) => p.type === "boolean" ? toCamelCase(p.name) : `${toCamelCase(p.name)}="${p.defaultValue}"`)
        .join(" ");
      parts.push(`    <pre><code>&lt;${escapeHtml(name)}${usageProps ? " " + escapeHtml(usageProps) : ""}&gt;content&lt;/${escapeHtml(name)}&gt;</code></pre>`);

      if (component.figmaUrl) {
        parts.push(`    <p><a href="${escapeHtml(component.figmaUrl)}">Open in Figma</a></p>`);
      }

      parts.push("  </div>");
    }
  }

  // Patterns
  if (data.patterns.length > 0 && data.patterns.some((g) => g.patterns.length > 0)) {
    parts.push('  <h2 id="patterns">Usage Patterns</h2>');
    for (const group of data.patterns) {
      if (group.patterns.length === 0) continue;
      parts.push(`  <h3>${escapeHtml(group.category)}</h3>`);
      parts.push("  <ul>");
      for (const pattern of group.patterns) {
        parts.push(`    <li>${escapeHtml(pattern)}</li>`);
      }
      parts.push("  </ul>");
    }
  }

  parts.push(HTML_TEMPLATE_END);
  return parts.join("\n");
}

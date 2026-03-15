/**
 * Formats design system data into LLM-optimized markdown.
 * Each formatter takes extracted Figma data and returns a markdown string
 * that an AI can directly reference when generating code.
 */

import type { W3CTokenFile } from "../types/tokens.js";
import type { FigmaComponentEntry } from "../types/components.js";
import type { ComponentProp } from "../types/scaffold.js";
import { toPascalCase, toCamelCase } from "./scaffold-templates.js";

// ─── Token Formatting ───

export interface FlatToken {
  name: string;
  path: string[];
  value: string | number | boolean;
  type: string;
}

/** Flatten a W3C nested token file into a flat array with CSS variable names */
export function flattenW3CTokens(
  tokens: W3CTokenFile,
  path: string[] = [],
  result: FlatToken[] = []
): FlatToken[] {
  for (const [key, val] of Object.entries(tokens)) {
    if (key.startsWith("$")) continue;

    if (typeof val === "object" && val !== null && "$value" in val) {
      const token = val as { $value: unknown; $type?: string };
      result.push({
        name: [...path, key].join("-"),
        path: [...path, key],
        value: token.$value as string | number | boolean,
        type: token.$type ?? "unknown",
      });
    } else if (typeof val === "object" && val !== null) {
      flattenW3CTokens(val as W3CTokenFile, [...path, key], result);
    }
  }
  return result;
}

/** Format tokens into markdown grouped by type */
export function formatTokensMarkdown(tokens: FlatToken[]): string {
  if (tokens.length === 0) {
    return "## Design Tokens\n\nNo tokens found in this file.\n";
  }

  const byType = new Map<string, FlatToken[]>();
  for (const token of tokens) {
    const category = categorizeToken(token);
    if (!byType.has(category)) byType.set(category, []);
    byType.get(category)!.push(token);
  }

  const lines: string[] = ["## Design Tokens\n"];
  for (const [category, categoryTokens] of byType) {
    lines.push(`### ${category}`);
    for (const token of categoryTokens) {
      lines.push(`--${token.name}: ${token.value};`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/** Categorize a token by its type for grouping */
function categorizeToken(token: FlatToken): string {
  switch (token.type) {
    case "color": return "Colors";
    case "number": {
      // Heuristic: if name contains spacing/size/gap/padding, it's spacing
      const n = token.name.toLowerCase();
      if (n.includes("spacing") || n.includes("gap") || n.includes("padding") || n.includes("margin")) return "Spacing";
      if (n.includes("radius") || n.includes("corner")) return "Border Radius";
      if (n.includes("size") || n.includes("width") || n.includes("height")) return "Sizing";
      return "Numbers";
    }
    case "fontFamily": return "Typography";
    case "fontWeight": return "Typography";
    case "string": {
      const n = token.name.toLowerCase();
      if (n.includes("font")) return "Typography";
      return "Strings";
    }
    case "shadow": return "Shadows";
    case "boolean": return "Flags";
    default: return "Other";
  }
}

// ─── Component Formatting ───

export interface ComponentWithProps {
  component: FigmaComponentEntry;
  props: ComponentProp[];
  variantCount: number;
}

/** Format components into markdown with props and usage examples */
export function formatComponentsMarkdown(components: ComponentWithProps[]): string {
  if (components.length === 0) {
    return "## Available Components\n\nNo components found.\n";
  }

  const lines: string[] = ["## Available Components\n"];

  for (const { component, props, variantCount } of components) {
    const pascalName = toPascalCase(component.name);
    lines.push(`### ${pascalName}`);

    if (props.length > 0) {
      const propStrings = props.map((p) => {
        if (p.type === "boolean") return `${toCamelCase(p.name)} (boolean)`;
        if (p.type === "enum" && p.values) return `${toCamelCase(p.name)} (${p.values.join(" | ")})`;
        return `${toCamelCase(p.name)} (string)`;
      });
      lines.push(`Props: ${propStrings.join(", ")}`);
    }

    lines.push(`Variants: ${variantCount}`);

    // Synthesize usage example
    const usageProps = props
      .filter((p) => p.defaultValue !== undefined)
      .map((p) => {
        const camel = toCamelCase(p.name);
        return p.type === "boolean"
          ? `${camel}`
          : `${camel}="${p.defaultValue}"`;
      })
      .join(" ");

    const propsStr = usageProps ? ` ${usageProps}` : "";
    lines.push(`Usage: <${pascalName}${propsStr}>content</${pascalName}>`);

    if (component.description) {
      lines.push(`Description: ${component.description}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ─── Pattern Formatting ───

export interface PatternGroup {
  category: string;
  patterns: string[];
}

/** Format patterns into markdown grouped by category */
export function formatPatternsMarkdown(groups: PatternGroup[]): string {
  if (groups.length === 0 || groups.every((g) => g.patterns.length === 0)) {
    return "## Usage Patterns\n\nNo recurring patterns detected — design may be too small or inconsistent to infer patterns. Consider adding explicit rules via set_design_rules.\n";
  }

  const lines: string[] = ["## Usage Patterns\n"];
  for (const group of groups) {
    if (group.patterns.length === 0) continue;
    lines.push(`### ${group.category}`);
    for (const pattern of group.patterns) {
      lines.push(`- ${pattern}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ─── Rules Formatting ───

export interface DesignRule {
  rule: string;
  category?: string;
}

/** Format rules into markdown */
export function formatRulesMarkdown(rules: DesignRule[]): string {
  if (rules.length === 0) {
    return "## Design Rules\n\nNo rules defined. Use set_design_rules to add constraints.\n";
  }

  const lines: string[] = ["## Design Rules\n"];
  for (const rule of rules) {
    lines.push(`- ${rule.rule}`);
  }
  lines.push("");

  return lines.join("\n");
}

// ─── Full Context Assembly ───

const CONTEXT_HEADER = `# Design System Context
Use these tokens, components, and patterns when generating code.
DO NOT use hardcoded colors, font sizes, or spacing values.
DO NOT create new components when an existing one matches.

## HARD RULES — NO EXCEPTIONS
1. NEVER invent, hardcode, or manually adjust any visual value. Every color, background, hover state, surface variation, card background, shadow, and typography value MUST come from this design system. If a value is not in the design system, DO NOT USE IT.
2. When using external UX research (Refero, design references, competitor screenshots) for layout and interaction patterns, you MUST still use THIS design system's tokens for all visual values. Research informs STRUCTURE and LAYOUT only — never colors, fonts, spacing values, or any other visual token.
3. If the design system has a primary color, use it. If a reference product uses blue but your design system uses pink, USE PINK. The design system is the single source of truth for all visual values.
4. If you need a color/value that doesn't exist in the design system (e.g., a card background, a hover tint), flag it to the user — do not invent it. Ask: "The design system doesn't have a value for X. Should I extract it from Figma or should you add it?"
`;

/** Assemble the full design system context document */
export function assembleContext(sections: {
  tokens?: string;
  components?: string;
  patterns?: string;
  rules?: string;
  warnings?: string[];
}): string {
  const parts: string[] = [CONTEXT_HEADER];

  if (sections.warnings && sections.warnings.length > 0) {
    parts.push(sections.warnings.map((w) => `> ⚠ ${w}`).join("\n"));
    parts.push("");
  }

  if (sections.tokens) parts.push(sections.tokens);
  if (sections.components) parts.push(sections.components);
  if (sections.patterns) parts.push(sections.patterns);
  if (sections.rules) parts.push(sections.rules);

  return parts.join("\n");
}

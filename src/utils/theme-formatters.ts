/**
 * Format-specific generators for multi-theme output.
 * Each function takes classified tokens (base + themed) and returns file content.
 */

import type { FlatToken } from "./context-formatter.js";
import { toCamelCase } from "./scaffold-templates.js";

// ─── Shared Types ───

export interface ClassifiedTokens {
  /** Tokens from single-mode collections — shared across all themes */
  base: FlatToken[];
  /** Tokens from multi-mode collections, grouped by mode name */
  themed: Map<string, FlatToken[]>;
  /** Which mode is the default */
  defaultMode: string;
  /** All mode names in order */
  modes: string[];
}

// ─── Token Classification (name-based heuristics) ───

type TailwindCategory = "colors" | "spacing" | "borderRadius" | "fontSize" | "fontFamily" | "boxShadow" | "other";

function categorizeTailwind(token: FlatToken): TailwindCategory {
  if (token.type === "color") return "colors";
  const n = token.name.toLowerCase();
  if (token.type === "number" || token.type === "dimension") {
    if (n.includes("spacing") || n.includes("gap") || n.includes("padding") || n.includes("margin") || n.includes("size") || n.includes("width") || n.includes("height")) return "spacing";
    if (n.includes("radius") || n.includes("corner")) return "borderRadius";
    if (n.includes("font-size") || n.includes("text-size")) return "fontSize";
    return "spacing"; // default numeric to spacing
  }
  if (token.type === "string") {
    if (n.includes("font")) return "fontFamily";
  }
  return "other";
}

/** Sanitize a mode name for use in CSS selectors */
function sanitizeModeName(name: string): string {
  return name.replace(/\s+/g, "-").toLowerCase();
}

/** Parse a color token path into group + shade for Tailwind nesting */
function parseColorPath(token: FlatToken): { group: string; shade: string } {
  const parts = token.path;
  if (parts.length >= 2) {
    return { group: parts[parts.length - 2], shade: parts[parts.length - 1] };
  }
  return { group: "default", shade: token.name };
}

// ─── CSS Generator ───

export type CssStrategy = "data-attribute" | "media-query" | "class";

export function generateCSS(
  tokens: ClassifiedTokens,
  strategy: CssStrategy
): string {
  const lines: string[] = [];

  // Base tokens
  if (tokens.base.length > 0) {
    lines.push("/* Base tokens (shared across all themes) */");
    lines.push(":root {");
    for (const token of tokens.base) {
      lines.push(`  --${token.name}: ${formatCSSValue(token)};`);
    }
    lines.push("}");
    lines.push("");
  }

  // Themed tokens per mode
  for (const mode of tokens.modes) {
    const modeTokens = tokens.themed.get(mode) ?? [];
    if (modeTokens.length === 0) continue;

    const sanitized = sanitizeModeName(mode);
    const isDefault = mode === tokens.defaultMode;
    const selector = buildSelector(sanitized, isDefault, strategy);
    const comment = isDefault ? `/* Default theme (${mode}) */` : `/* ${mode} theme */`;

    lines.push(comment);
    lines.push(`${selector} {`);
    for (const token of modeTokens) {
      lines.push(`  --${token.name}: ${formatCSSValue(token)};`);
    }
    lines.push("}");
    lines.push("");
  }

  return lines.join("\n");
}

function buildSelector(modeName: string, isDefault: boolean, strategy: CssStrategy): string {
  const base = isDefault ? ":root, " : "";
  switch (strategy) {
    case "data-attribute":
      return `${base}[data-theme="${modeName}"]`;
    case "media-query":
      // media-query only works for light/dark — for other modes, fall back to data-attribute
      if (modeName === "dark") return `@media (prefers-color-scheme: dark)`;
      if (modeName === "light" && isDefault) return `:root`;
      return `${base}[data-theme="${modeName}"]`;
    case "class":
      return `${base}.theme-${modeName}`;
  }
}

function formatCSSValue(token: FlatToken): string {
  if (token.type === "color") return String(token.value);
  if (typeof token.value === "number") return `${token.value}px`;
  return String(token.value);
}

// ─── Tailwind Generator ───

export function generateTailwind(tokens: ClassifiedTokens): string {
  // Tailwind references CSS variables for themed tokens, literal values for base
  const allTokens = [
    ...tokens.base,
    ...(tokens.themed.get(tokens.defaultMode) ?? []),
  ];

  const groups: Record<string, Record<string, unknown>> = {
    colors: {},
    spacing: {},
    borderRadius: {},
    fontSize: {},
    fontFamily: {},
  };

  const otherTokens: FlatToken[] = [];

  for (const token of allTokens) {
    const category = categorizeTailwind(token);

    if (category === "other") {
      otherTokens.push(token);
      continue;
    }

    if (category === "colors") {
      const { group, shade } = parseColorPath(token);
      if (!groups.colors[group]) groups.colors[group] = {};
      const isThemed = tokens.themed.has(tokens.defaultMode) &&
        (tokens.themed.get(tokens.defaultMode) ?? []).some((t) => t.name === token.name);
      (groups.colors[group] as Record<string, string>)[shade] = isThemed
        ? `var(--${token.name})`
        : String(token.value);
      continue;
    }

    const key = token.path[token.path.length - 1] ?? token.name;
    const isThemed = tokens.themed.has(tokens.defaultMode) &&
      (tokens.themed.get(tokens.defaultMode) ?? []).some((t) => t.name === token.name);
    const value = isThemed ? `var(--${token.name})` : formatCSSValue(token);

    if (category === "fontFamily") {
      (groups.fontFamily as Record<string, string[]>)[key] = [String(token.value), "sans-serif"];
    } else {
      (groups[category] as Record<string, string>)[key] = value;
    }
  }

  // Remove empty groups
  for (const [key, val] of Object.entries(groups)) {
    if (Object.keys(val).length === 0) delete groups[key];
  }

  const lines: string[] = [
    "/** @type {import('tailwindcss').Config['theme']} */",
    "module.exports = {",
    "  extend: {",
  ];

  for (const [category, values] of Object.entries(groups)) {
    lines.push(`    ${category}: ${JSON.stringify(values, null, 6).replace(/\n/g, "\n    ")},`);
  }

  lines.push("  },");
  lines.push("}");

  if (otherTokens.length > 0) {
    lines.push("");
    lines.push("// Other tokens (use as CSS variables):");
    for (const token of otherTokens) {
      lines.push(`// --${token.name}: ${token.value}`);
    }
  }

  return lines.join("\n");
}

// ─── ThemeProvider Generator ───

export function generateThemeProvider(tokens: ClassifiedTokens): string {
  const themeObjects: Record<string, Record<string, Record<string, string>>> = {};

  for (const mode of tokens.modes) {
    const modeTokens = tokens.themed.get(mode) ?? [];
    // Merge base tokens into every theme
    const allTokens = [...tokens.base, ...modeTokens];

    const theme: Record<string, Record<string, string>> = {
      colors: {},
      spacing: {},
      borderRadius: {},
    };

    for (const token of allTokens) {
      const category = categorizeTailwind(token);
      const key = toCamelCase(token.name.replace(/-/g, " "));

      if (category === "colors") {
        theme.colors[key] = String(token.value);
      } else if (category === "spacing" || category === "fontSize") {
        theme.spacing[key] = formatCSSValue(token);
      } else if (category === "borderRadius") {
        theme.borderRadius[key] = formatCSSValue(token);
      } else if (category === "fontFamily") {
        if (!theme.fontFamily) theme.fontFamily = {};
        theme.fontFamily[key] = String(token.value);
      } else {
        theme.colors[key] = String(token.value);
      }
    }

    // Remove empty groups
    for (const [k, v] of Object.entries(theme)) {
      if (Object.keys(v).length === 0) delete theme[k];
    }

    themeObjects[sanitizeModeName(mode)] = theme;
  }

  const themesJson = JSON.stringify(themeObjects, null, 2);

  const lines: string[] = [
    `export const themes = ${themesJson} as const;`,
    "",
    `export type Theme = typeof themes.${sanitizeModeName(tokens.defaultMode)};`,
    `export type ThemeName = keyof typeof themes;`,
  ];

  return lines.join("\n");
}

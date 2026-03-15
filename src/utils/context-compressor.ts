/**
 * Task-relevant filtering and size-capped compression for design system context.
 * Ensures the context fits within LLM token budgets while preserving the most relevant information.
 */

import type { FlatToken } from "./context-formatter.js";
import type { ComponentWithProps } from "./context-formatter.js";

/** Maximum context size in estimated LLM tokens (chars / 4) */
export const MAX_CONTEXT_TOKENS = 4000;

// ─── Task-Relevant Filtering ───

/** Keywords mapped to relevant token categories */
const TASK_CATEGORY_MAP: Record<string, string[]> = {
  form: ["Colors", "Spacing", "Typography", "Border Radius"],
  login: ["Colors", "Spacing", "Typography", "Border Radius"],
  table: ["Colors", "Spacing", "Typography", "Sizing"],
  chart: ["Colors", "Sizing", "Numbers"],
  dashboard: ["Colors", "Spacing", "Typography", "Shadows", "Sizing"],
  card: ["Colors", "Spacing", "Shadows", "Border Radius"],
  nav: ["Colors", "Spacing", "Typography"],
  button: ["Colors", "Spacing", "Typography", "Border Radius"],
  modal: ["Colors", "Spacing", "Shadows", "Typography"],
  settings: ["Colors", "Spacing", "Typography"],
};

/** Filter tokens by task relevance */
export function filterTokensByTask(
  tokens: FlatToken[],
  taskDescription: string
): FlatToken[] {
  const keywords = taskDescription.toLowerCase().split(/\s+/);
  const relevantCategories = new Set<string>();

  for (const keyword of keywords) {
    const categories = TASK_CATEGORY_MAP[keyword];
    if (categories) {
      categories.forEach((c) => relevantCategories.add(c));
    }
  }

  // If no keywords matched, return all tokens
  if (relevantCategories.size === 0) return tokens;

  return tokens.filter((t) => {
    const category = categorizeTokenForFilter(t);
    return relevantCategories.has(category);
  });
}

function categorizeTokenForFilter(token: FlatToken): string {
  switch (token.type) {
    case "color": return "Colors";
    case "number": {
      const n = token.name.toLowerCase();
      if (n.includes("spacing") || n.includes("gap") || n.includes("padding")) return "Spacing";
      if (n.includes("radius")) return "Border Radius";
      if (n.includes("size") || n.includes("width") || n.includes("height")) return "Sizing";
      return "Numbers";
    }
    case "shadow": return "Shadows";
    default: {
      const n = token.name.toLowerCase();
      if (n.includes("font")) return "Typography";
      return "Other";
    }
  }
}

/** Filter components by task relevance using keyword matching */
export function filterComponentsByTask(
  components: ComponentWithProps[],
  taskDescription: string
): ComponentWithProps[] {
  const keywords = taskDescription.toLowerCase().split(/\s+/);

  // Score each component by keyword relevance
  const scored = components.map((c) => {
    const nameWords = c.component.name.toLowerCase();
    const desc = (c.component.description ?? "").toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      if (nameWords.includes(kw)) score += 2;
      if (desc.includes(kw)) score += 1;
    }
    return { component: c, score };
  });

  // If no components match keywords, return all
  const matched = scored.filter((s) => s.score > 0);
  if (matched.length === 0) return components;

  // Return matched + a few common components (Button, Input, etc.)
  const commonNames = ["button", "input", "card", "link", "icon", "text"];
  const common = scored.filter(
    (s) => s.score === 0 && commonNames.some((cn) => s.component.component.name.toLowerCase().includes(cn))
  );

  return [...matched, ...common].map((s) => s.component);
}

// ─── Size-Capped Compression ───

/** Estimate LLM token count from a string */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Progressively compress context to fit within token budget */
export function compressContext(
  context: string,
  maxTokens: number = MAX_CONTEXT_TOKENS
): string {
  if (estimateTokens(context) <= maxTokens) return context;

  let result = context;

  // Stage 1: Remove variant details (keep only prop names, drop values)
  result = result.replace(
    /Props: (.+)/g,
    (_, props: string) => {
      const simplified = props
        .split(", ")
        .map((p) => p.replace(/\s*\([^)]+\)/, ""))
        .join(", ");
      return `Props: ${simplified}`;
    }
  );

  if (estimateTokens(result) <= maxTokens) return result;

  // Stage 2: Remove Description lines from components
  result = result.replace(/^Description: .+$/gm, "");

  if (estimateTokens(result) <= maxTokens) return result;

  // Stage 3: Remove Usage lines from components
  result = result.replace(/^Usage: .+$/gm, "");

  if (estimateTokens(result) <= maxTokens) return result;

  // Stage 4: Truncate tokens to most important categories
  // Keep Colors, Spacing, Typography — drop rest
  const lines = result.split("\n");
  const keepCategories = ["Colors", "Spacing", "Typography", "Shadows"];
  let inDroppedCategory = false;
  const filtered = lines.filter((line) => {
    if (line.startsWith("### ")) {
      const category = line.replace("### ", "");
      inDroppedCategory = !keepCategories.includes(category);
      return !inDroppedCategory;
    }
    if (inDroppedCategory && (line.startsWith("--") || line.trim() === "")) {
      return false;
    }
    return true;
  });

  result = filtered.join("\n");

  // Stage 5: Hard truncate if still too long
  if (estimateTokens(result) > maxTokens) {
    const charLimit = maxTokens * 4;
    result = result.substring(0, charLimit) + "\n\n[Context truncated to fit token budget]";
  }

  return result;
}

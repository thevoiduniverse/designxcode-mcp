/**
 * Tool: generate_theme_config — Extract multi-theme configurations from
 * Figma Variable modes into CSS, Tailwind, or ThemeProvider formats.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FigmaClient } from "../clients/figma.js";
import type { W3CTokenFile } from "../types/tokens.js";
import type { FigmaVariableCollection } from "../types/figma.js";
import { figmaVariablesToW3C } from "../utils/w3c-tokens.js";
import { flattenW3CTokens } from "../utils/context-formatter.js";
import type { FlatToken } from "../utils/context-formatter.js";
import {
  generateCSS,
  generateTailwind,
  generateThemeProvider,
} from "../utils/theme-formatters.js";
import type { ClassifiedTokens, CssStrategy } from "../utils/theme-formatters.js";
import { toUserMessage, McpToolError } from "../utils/errors.js";
import { inferModesFromFileTree } from "../utils/mode-inference.js";

const InputSchema = z.object({
  figma_file_key: z.string().min(1)
    .describe("The Figma file key (from the URL: figma.com/design/{THIS_PART}/...)"),
  output_format: z.enum(["css", "tailwind", "theme-provider", "all"])
    .default("css")
    .describe("Output format (default: 'css')"),
  color_scheme_strategy: z.enum(["data-attribute", "media-query", "class"])
    .default("data-attribute")
    .describe("CSS selector strategy for themes (CSS format only, default: 'data-attribute')"),
  default_mode: z.string().optional()
    .describe("Override which mode is the base theme (auto-detects if omitted)"),
}).strict();

type Input = z.infer<typeof InputSchema>;

export function registerGenerateThemeConfig(
  server: McpServer,
  figmaClient: FigmaClient
): void {
  server.registerTool(
    "generate_theme_config",
    {
      title: "Generate Theme Config",
      description: `Extract multi-theme configurations from Figma Variable modes.

Generates theme-aware output files (CSS custom properties with theme selectors,
Tailwind config, or TypeScript ThemeProvider) from Figma Variable modes (Light/Dark/etc).

Args:
  - figma_file_key (string): The Figma file key
  - output_format ('css' | 'tailwind' | 'theme-provider' | 'all'): Output format (default: 'css')
  - color_scheme_strategy ('data-attribute' | 'media-query' | 'class'): CSS selector strategy (default: 'data-attribute')
  - default_mode (string, optional): Override base theme mode name

Returns:
  JSON with generated file(s) and summary of modes/token counts.`,
      inputSchema: InputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: Input) => {
      try {
        // Try Variables API first (Enterprise/Organization), fall back to mode inference
        let classified: ClassifiedTokens;
        let source: "variables-api" | "mode-inference";

        try {
          // 1a. Enterprise path: fetch variables and collections
          const response = await figmaClient.getLocalVariables(params.figma_file_key);
          const variables = response.meta.variables;
          const collections = response.meta.variableCollections;
          const { tokenSets } = figmaVariablesToW3C(variables, collections);
          classified = classifyTokens(tokenSets, collections, params.default_mode);
          source = "variables-api";
        } catch (varError) {
          // 1b. Professional fallback: infer modes from resolved values in the file tree
          const isScopeError = varError instanceof McpToolError && varError.code === "FIGMA_SCOPE_ERROR";
          const is403 = varError instanceof Error && varError.message.includes("403");
          if (!isScopeError && !is403) throw varError; // Re-throw non-scope errors

          const fileResponse = await figmaClient.getFile(params.figma_file_key);
          const inferred = inferModesFromFileTree(fileResponse.document);

          if (!inferred) {
            return {
              isError: true,
              content: [{
                type: "text" as const,
                text: "No variable modes detected in this file. Ensure at least one frame has a variable mode override applied (via Figma's appearance panel).",
              }],
            };
          }

          classified = inferred;
          source = "mode-inference";
        }

        // 2. Generate output files
        const files: Array<{ path: string; content: string; description: string }> = [];
        const formats = params.output_format === "all"
          ? ["css", "tailwind", "theme-provider"] as const
          : [params.output_format] as const;

        for (const format of formats) {
          switch (format) {
            case "css":
              files.push({
                path: "theme.css",
                content: generateCSS(classified, params.color_scheme_strategy as CssStrategy),
                description: `CSS custom properties with ${params.color_scheme_strategy} theme switching`,
              });
              break;
            case "tailwind":
              files.push({
                path: "tailwind.theme.js",
                content: generateTailwind(classified),
                description: "Tailwind v3 theme.extend config with CSS variable references for themed tokens",
              });
              break;
            case "theme-provider":
              files.push({
                path: "theme.ts",
                content: generateThemeProvider(classified),
                description: "TypeScript theme objects with type exports for ThemeProvider",
              });
              break;
          }
        }

        const output = {
          files,
          summary: {
            source,
            modes: classified.modes,
            defaultMode: classified.defaultMode,
            baseTokenCount: classified.base.length,
            themedTokenCount: classified.themed.get(classified.defaultMode)?.length ?? 0,
            formats: formats as unknown as string[],
          },
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: toUserMessage(error) }],
        };
      }
    }
  );
}

/**
 * Classify token sets into base (single-mode) and themed (multi-mode).
 * Token sets from figmaVariablesToW3C are keyed as "collection" or "collection/mode".
 */
function classifyTokens(
  tokenSets: Record<string, W3CTokenFile>,
  collections: Record<string, FigmaVariableCollection>,
  defaultModeOverride?: string
): ClassifiedTokens {
  const base: FlatToken[] = [];
  const themed = new Map<string, FlatToken[]>();
  const modeNames = new Set<string>();
  let defaultMode = "default";

  // Build a map of collection name → mode info
  const collectionModes = new Map<string, { modes: string[]; defaultModeName: string }>();
  for (const collection of Object.values(collections)) {
    const sanitizedName = collection.name.replace(/\s+/g, "-").toLowerCase();
    const defaultModeObj = collection.modes.find((m) => m.modeId === collection.defaultModeId);
    const defaultModeName = defaultModeObj?.name ?? collection.modes[0]?.name ?? "default";
    collectionModes.set(sanitizedName, {
      modes: collection.modes.map((m) => m.name),
      defaultModeName,
    });
  }

  for (const [setKey, tokenFile] of Object.entries(tokenSets)) {
    const flat = flattenW3CTokens(tokenFile);
    const parts = setKey.split("/");

    if (parts.length === 1) {
      // Single-mode collection → base tokens
      base.push(...flat);
    } else {
      // Multi-mode: key is "collection/mode"
      const modeName = parts.slice(1).join("/");
      // Convert sanitized mode name back to original case for display
      // Use the raw mode name from the key
      const displayMode = modeName;
      modeNames.add(displayMode);

      if (!themed.has(displayMode)) themed.set(displayMode, []);
      themed.get(displayMode)!.push(...flat);

      // Detect default mode
      const collectionKey = parts[0];
      const info = collectionModes.get(collectionKey);
      if (info) {
        const sanitizedDefault = info.defaultModeName.replace(/\s+/g, "-").toLowerCase();
        if (sanitizedDefault === modeName) {
          defaultMode = displayMode;
        }
      }
    }
  }

  // Override default mode if specified
  if (defaultModeOverride) {
    const sanitized = defaultModeOverride.replace(/\s+/g, "-").toLowerCase();
    if (modeNames.has(sanitized)) {
      defaultMode = sanitized;
    }
  }

  // If no multi-mode collections found, treat all as base with single "default" mode
  if (modeNames.size === 0) {
    modeNames.add("default");
    defaultMode = "default";
  }

  return {
    base,
    themed,
    defaultMode,
    modes: Array.from(modeNames),
  };
}

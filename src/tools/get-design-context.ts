/**
 * Tool: get_design_context — Read design system context from cached MCP resources,
 * optionally filter by task relevance, and return a compressed markdown document.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FigmaClient } from "../clients/figma.js";
import type { DesignSystemCache } from "../cache/design-system-cache.js";
import { figmaVariablesToW3C, mergeTokenSets } from "../utils/w3c-tokens.js";
import {
  flattenW3CTokens,
  formatTokensMarkdown,
  formatComponentsMarkdown,
  formatPatternsMarkdown,
  formatRulesMarkdown,
  assembleContext,
} from "../utils/context-formatter.js";
import {
  filterTokensByTask,
  filterComponentsByTask,
  compressContext,
} from "../utils/context-compressor.js";
import { inferPatterns } from "../utils/pattern-inference.js";
import { fetchComponentsWithProps } from "../utils/component-context.js";
import { readRulesFile } from "./set-design-rules.js";
import { toUserMessage } from "../utils/errors.js";

const InputSchema = z.object({
  figma_file_key: z.string().min(1)
    .describe("The Figma file key"),
  task_description: z.string().optional()
    .describe("Optional task context for relevance filtering, e.g. 'build a login form'"),
  sections: z.array(z.enum(["tokens", "components", "patterns", "rules"]))
    .optional()
    .describe("Specific sections to include. Omit to include all sections."),
  refresh: z.boolean().default(false)
    .describe("Force cache invalidation and re-fetch from Figma API"),
}).strict();

type Input = z.infer<typeof InputSchema>;

export function registerGetDesignContext(
  server: McpServer,
  figmaClient: FigmaClient,
  cache: DesignSystemCache
): void {
  server.registerTool(
    "get_design_context",
    {
      title: "Get Design Context",
      description: `Load design system context (tokens, components, patterns, rules) from a Figma file.

Call this before generating UI code to ensure the output uses correct design tokens,
reuses existing components, and follows established patterns.

Args:
  - figma_file_key (string): The Figma file key
  - task_description (string, optional): Task context for relevance filtering
  - sections (string[], optional): Specific sections to include (default: all)
  - refresh (boolean): Force re-fetch from Figma (default: false)

Returns:
  Markdown document with design system tokens, components, patterns, and rules.

Examples:
  - "Load full design system" -> get_design_context with just figma_file_key
  - "Get context for a login form" -> get_design_context with task_description: "login form"
  - "Refresh tokens only" -> get_design_context with sections: ["tokens"], refresh: true`,
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
        const sections = params.sections ?? ["tokens", "components", "patterns", "rules"];

        // Invalidate cache if refresh requested
        if (params.refresh) {
          cache.invalidateAll(params.figma_file_key);
        }

        const warnings: string[] = [];
        let tokensMarkdown: string | undefined;
        let componentsMarkdown: string | undefined;
        let patternsMarkdown: string | undefined;
        let rulesMarkdown: string | undefined;

        // -- Tokens --
        // IMPORTANT: Cache stores the UNFILTERED result. Task filtering
        // is applied after retrieval to avoid poisoning the cache.
        if (sections.includes("tokens")) {
          tokensMarkdown = cache.get(params.figma_file_key, "tokens") ?? undefined;
          if (!tokensMarkdown) {
            try {
              const response = await figmaClient.getLocalVariables(params.figma_file_key);
              const variables = response.meta.variables;
              const collections = response.meta.variableCollections;

              if (Object.keys(variables).length > 0) {
                const { tokenSets } = figmaVariablesToW3C(variables, collections);
                const merged = mergeTokenSets(tokenSets);
                const flat = flattenW3CTokens(merged);
                tokensMarkdown = formatTokensMarkdown(flat);
              } else {
                tokensMarkdown = "## Design Tokens\n\nNo variables found.\n";
              }

              cache.set(params.figma_file_key, "tokens", tokensMarkdown);
            } catch (error) {
              warnings.push(`Token extraction failed: ${toUserMessage(error)}`);
            }
          }

          // Apply task filtering AFTER cache retrieval
          if (tokensMarkdown && params.task_description) {
            try {
              const response = await figmaClient.getLocalVariables(params.figma_file_key);
              const { tokenSets } = figmaVariablesToW3C(response.meta.variables, response.meta.variableCollections);
              const merged = mergeTokenSets(tokenSets);
              const flat = flattenW3CTokens(merged);
              const filtered = filterTokensByTask(flat, params.task_description);
              tokensMarkdown = formatTokensMarkdown(filtered);
            } catch {
              // If re-fetch fails, use unfiltered cached version
            }
          }
        }

        // -- Components --
        if (sections.includes("components")) {
          componentsMarkdown = cache.get(params.figma_file_key, "components") ?? undefined;
          if (!componentsMarkdown) {
            try {
              const componentsWithProps = await fetchComponentsWithProps(figmaClient, params.figma_file_key);
              componentsMarkdown = formatComponentsMarkdown(componentsWithProps);
              cache.set(params.figma_file_key, "components", componentsMarkdown);
            } catch (error) {
              warnings.push(`Component extraction failed: ${toUserMessage(error)}`);
            }
          }

          // Apply task filtering AFTER cache retrieval
          if (componentsMarkdown && params.task_description) {
            try {
              let componentsWithProps = await fetchComponentsWithProps(figmaClient, params.figma_file_key);
              componentsWithProps = filterComponentsByTask(componentsWithProps, params.task_description);
              componentsMarkdown = formatComponentsMarkdown(componentsWithProps);
            } catch {
              // If re-fetch fails, use unfiltered cached version
            }
          }
        }

        // -- Patterns --
        if (sections.includes("patterns")) {
          patternsMarkdown = cache.get(params.figma_file_key, "patterns") ?? undefined;
          if (!patternsMarkdown) {
            try {
              // Build token map for value->name mapping
              let tokenMap: Map<string, string> | undefined;
              try {
                const response = await figmaClient.getLocalVariables(params.figma_file_key);
                const { tokenSets } = figmaVariablesToW3C(response.meta.variables, response.meta.variableCollections);
                const merged = mergeTokenSets(tokenSets);
                const flat = flattenW3CTokens(merged);
                tokenMap = new Map(flat.map((t) => [String(t.value), `--${t.name}`]));
              } catch {
                // Token map is optional
              }

              const patternGroups = await inferPatterns(figmaClient, params.figma_file_key, tokenMap);
              patternsMarkdown = formatPatternsMarkdown(patternGroups);
              cache.set(params.figma_file_key, "patterns", patternsMarkdown);
            } catch (error) {
              warnings.push(`Pattern inference failed: ${toUserMessage(error)}`);
              patternsMarkdown = formatPatternsMarkdown([]);
            }
          }
        }

        // -- Rules --
        if (sections.includes("rules")) {
          rulesMarkdown = cache.get(params.figma_file_key, "rules") ?? undefined;
          if (!rulesMarkdown) {
            const rules = readRulesFile(params.figma_file_key);
            rulesMarkdown = formatRulesMarkdown(rules);
            cache.set(params.figma_file_key, "rules", rulesMarkdown);
          }
        }

        // -- Assemble and compress --
        let context = assembleContext({
          tokens: tokensMarkdown,
          components: componentsMarkdown,
          patterns: patternsMarkdown,
          rules: rulesMarkdown,
          warnings,
        });

        context = compressContext(context);

        return {
          content: [{ type: "text" as const, text: context }],
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

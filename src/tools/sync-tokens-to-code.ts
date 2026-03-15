/**
 * Tool 2: sync_tokens_to_code — Generate platform-specific token files from Figma.
 * Reads Figma variables, transforms via Style Dictionary, returns generated files.
 * Does NOT commit — just prepares files.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FigmaClient } from "../clients/figma.js";
import { figmaVariablesToW3C, mergeTokenSets } from "../utils/w3c-tokens.js";
import { transformTokens } from "../transforms/style-dictionary.js";
import { figmaNoVariables, toUserMessage, McpToolError } from "../utils/errors.js";
import { inferTokensFromStyles } from "../utils/token-inference.js";
import type { SDPlatform } from "../types/tokens.js";

const InputSchema = z.object({
  figma_file_key: z.string()
    .min(1)
    .describe("The Figma file key (from the URL: figma.com/design/{THIS_PART}/...)"),
  platforms: z.array(z.enum(["css", "scss", "tailwind", "swift", "kotlin", "json"]))
    .min(1)
    .describe("Target platforms to generate token files for"),
  collection_names: z.array(z.string())
    .optional()
    .describe("Optional list of variable collection names to include"),
  output_dir: z.string()
    .optional()
    .default("tokens")
    .describe("Output directory path for generated files (default: 'tokens')"),
}).strict();

type Input = z.infer<typeof InputSchema>;

export function registerSyncTokensToCode(server: McpServer, figmaClient: FigmaClient): void {
  server.registerTool(
    "sync_tokens_to_code",
    {
      title: "Sync Tokens to Code",
      description: `Generate platform-specific design token files from Figma variables.

Extracts tokens from Figma, transforms them through Style Dictionary into platform-specific code (CSS custom properties, SCSS variables, Tailwind config, Swift UIColor, Kotlin Compose, or JSON).

This tool does NOT commit files — it returns the generated file contents for review. Use generate_sync_pr to commit and create a PR.

Args:
  - figma_file_key (string): The Figma file key
  - platforms (string[]): Target platforms — one or more of: 'css', 'scss', 'tailwind', 'swift', 'kotlin', 'json'
  - collection_names (string[], optional): Filter to specific collections
  - output_dir (string, optional): Output directory path (default: 'tokens')

Returns:
  JSON with generated files (path + content) and a summary of what was generated per platform.

Examples:
  - "Generate CSS and SCSS tokens from Figma" → sync_tokens_to_code with platforms: ["css", "scss"]
  - "Create mobile tokens" → sync_tokens_to_code with platforms: ["swift", "kotlin"]`,
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
        let tokenSets: Record<string, any>;
        let stats: any;

        try {
          // Enterprise path: Variables API
          const response = await figmaClient.getLocalVariables(params.figma_file_key);
          const { variables, variableCollections: collections } = response.meta;

          if (Object.keys(variables).length === 0) {
            throw figmaNoVariables(params.figma_file_key);
          }

          const result = figmaVariablesToW3C(variables, collections, {
            collectionNames: params.collection_names,
          });
          tokenSets = result.tokenSets;
          stats = result.stats;
        } catch (varError) {
          // Professional fallback: infer from styles + file tree
          const isScopeError = varError instanceof McpToolError && varError.code === "FIGMA_SCOPE_ERROR";
          const is403 = varError instanceof Error && varError.message.includes("403");
          if (!isScopeError && !is403) throw varError;

          const result = await inferTokensFromStyles(
            figmaClient,
            params.figma_file_key,
            params.collection_names
          );
          tokenSets = result.tokenSets;
          stats = result.stats;
        }

        // Merge all token sets into one for transformation
        const mergedTokens = mergeTokenSets(tokenSets);

        const results = transformTokens(mergedTokens, params.platforms as SDPlatform[]);

        const files = results.map((r) => ({
          path: `${params.output_dir}/${r.fileName}`,
          platform: r.platform,
          content: r.content,
        }));

        const output = {
          files,
          summary: {
            tokenStats: stats,
            platforms: results.map((r) => ({
              platform: r.platform,
              fileName: r.fileName,
              path: `${params.output_dir}/${r.fileName}`,
            })),
            totalFiles: files.length,
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

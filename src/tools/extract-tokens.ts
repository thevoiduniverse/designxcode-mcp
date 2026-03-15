/**
 * Tool 1: extract_tokens — Read-only extraction of design tokens from Figma.
 * Fetches Figma variables and converts to W3C, Style Dictionary, or raw format.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FigmaClient } from "../clients/figma.js";
import { figmaVariablesToW3C } from "../utils/w3c-tokens.js";
import { figmaNoVariables, toUserMessage, McpToolError } from "../utils/errors.js";
import type { W3CTokenFile, TokenStats } from "../types/tokens.js";
import { inferTokensFromStyles } from "../utils/token-inference.js";

const InputSchema = z.object({
  figma_file_key: z.string()
    .min(1)
    .describe("The Figma file key (from the URL: figma.com/design/{THIS_PART}/...)"),
  collection_names: z.array(z.string())
    .optional()
    .describe("Optional list of variable collection names to include. Omit to include all."),
  output_format: z.enum(["w3c", "style-dictionary", "raw"])
    .default("w3c")
    .describe("Output format: 'w3c' (W3C Design Token format), 'style-dictionary' (SD input format), or 'raw' (Figma API response)"),
}).strict();

type Input = z.infer<typeof InputSchema>;

export function registerExtractTokens(server: McpServer, figmaClient: FigmaClient): void {
  server.registerTool(
    "extract_tokens",
    {
      title: "Extract Design Tokens",
      description: `Extract design tokens (variables) from a Figma file and convert to standard formats.

Fetches all Figma Variables from the specified file and converts them to the requested format.
Supports W3C Design Token Community Group format, Style Dictionary input format, or raw Figma API response.

Args:
  - figma_file_key (string): The Figma file key from the URL
  - collection_names (string[], optional): Filter to specific variable collections
  - output_format ('w3c' | 'style-dictionary' | 'raw'): Output format (default: 'w3c')

Returns:
  JSON with token data and summary statistics including counts by type and collection.

Examples:
  - "Extract all design tokens from our Figma file" → extract_tokens with just figma_file_key
  - "Get only color tokens" → extract_tokens with collection_names: ["Colors"]
  - "Export tokens for Style Dictionary pipeline" → extract_tokens with output_format: "style-dictionary"`,
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
        let tokenSets: Record<string, W3CTokenFile>;
        let stats: TokenStats;
        let source: "variables-api" | "style-inference";

        try {
          // Enterprise path: Variables API
          const response = await figmaClient.getLocalVariables(params.figma_file_key);
          const variables = response.meta.variables;
          const collections = response.meta.variableCollections;

          if (Object.keys(variables).length === 0) {
            throw figmaNoVariables(params.figma_file_key);
          }

          if (params.output_format === "raw") {
            const output = {
              variables: Object.values(variables),
              collections: Object.values(collections),
              stats: {
                totalVariables: Object.keys(variables).length,
                totalCollections: Object.keys(collections).length,
              },
            };
            return {
              content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
            };
          }

          const result = figmaVariablesToW3C(variables, collections, {
            collectionNames: params.collection_names,
          });
          tokenSets = result.tokenSets;
          stats = result.stats;
          source = "variables-api";
        } catch (varError) {
          // Professional fallback: infer tokens from published styles + file tree
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
          source = "style-inference";
        }

        if (params.output_format === "style-dictionary") {
          const sdSets: Record<string, unknown> = {};
          for (const [key, tokenFile] of Object.entries(tokenSets)) {
            sdSets[key] = convertW3CToSD(tokenFile);
          }
          const output = { tokenSets: sdSets, stats, source };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
          };
        }

        // Default: W3C format
        const output = { tokenSets, stats, source };
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

/** Convert W3C token format ($value/$type) to Style Dictionary format (value/type) */
function convertW3CToSD(obj: W3CTokenFile): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, val] of Object.entries(obj)) {
    if (key.startsWith("$")) continue;

    if (typeof val === "object" && val !== null && "$value" in val) {
      const token = val as { $value: unknown; $type?: string; $description?: string };
      result[key] = {
        value: token.$value,
        ...(token.$type ? { type: token.$type } : {}),
        ...(token.$description ? { comment: token.$description } : {}),
      };
    } else if (typeof val === "object" && val !== null) {
      result[key] = convertW3CToSD(val as W3CTokenFile);
    }
  }

  return result;
}

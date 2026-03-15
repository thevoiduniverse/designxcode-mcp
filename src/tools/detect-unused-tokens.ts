/**
 * Tool 9: detect_unused_tokens — Scan a GitHub repo for token references
 * and flag design tokens that appear unused in the codebase.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FigmaClient } from "../clients/figma.js";
import { GitHubClient } from "../clients/github.js";
import { figmaNoVariables, toUserMessage, McpToolError } from "../utils/errors.js";
import { inferTokensFromStyles } from "../utils/token-inference.js";
import { figmaVariablesToW3C, mergeTokenSets } from "../utils/w3c-tokens.js";
import { deriveSearchPatterns, searchTokenUsage } from "../utils/token-search.js";
import type { UnusedTokenEntry, UnusedTokenResult } from "../types/components.js";
import type { W3CTokenFile } from "../types/tokens.js";
import type { TokenSearchPatterns } from "../utils/token-search.js";

const InputSchema = z.object({
  figma_file_key: z.string()
    .min(1)
    .describe("The Figma file key (from the URL: figma.com/design/{THIS_PART}/...)"),
  github_repo: z.string()
    .min(1)
    .describe("GitHub repository in 'owner/repo' format"),
  collection_names: z.array(z.string())
    .optional()
    .describe("Filter to specific variable collection names"),
  search_patterns: z.array(z.enum(["css", "scss", "tailwind", "all"]))
    .default(["all"])
    .describe("Token reference patterns to search for (default: all)"),
  file_extensions: z.array(z.string())
    .optional()
    .describe("Filter search to specific file extensions (e.g. ['tsx', 'css', 'scss'])"),
}).strict();

type Input = z.infer<typeof InputSchema>;

export function registerDetectUnusedTokens(
  server: McpServer,
  figmaClient: FigmaClient,
  githubClient: GitHubClient | null
): void {
  server.registerTool(
    "detect_unused_tokens",
    {
      title: "Detect Unused Tokens",
      description: `Scan a GitHub repository for design token usage and identify unused tokens.

Extracts tokens from a Figma file, derives CSS/SCSS/Tailwind variable names, and searches
the GitHub repo for references. Reports which tokens have zero references in the codebase.

Args:
  - figma_file_key (string): The Figma file key from the URL
  - github_repo (string): GitHub repository in 'owner/repo' format
  - collection_names (string[], optional): Filter to specific variable collections
  - search_patterns (string[]): Pattern types to search: 'css', 'scss', 'tailwind', 'all' (default: ['all'])
  - file_extensions (string[], optional): Filter to specific file extensions

Returns:
  JSON report with total/used/unused token counts, usage map, and list of unused tokens.

Examples:
  - "Find unused tokens in our repo" → detect_unused_tokens with figma_file_key + github_repo
  - "Check if color tokens are used" → detect_unused_tokens with collection_names: ["Colors"]
  - "Search only CSS files" → detect_unused_tokens with file_extensions: ["css", "scss"]`,
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
        if (!githubClient) {
          return {
            isError: true,
            content: [{
              type: "text" as const,
              text: "GITHUB_TOKEN is required for detect_unused_tokens. Set it in your environment with 'repo' scope.",
            }],
          };
        }

        // 1. Extract tokens from Figma (Enterprise API or Professional fallback)
        let tokenSets: Record<string, W3CTokenFile>;
        let stats: any;

        try {
          const response = await figmaClient.getLocalVariables(params.figma_file_key);
          const variables = response.meta.variables;
          const collections = response.meta.variableCollections;

          if (Object.keys(variables).length === 0) {
            throw figmaNoVariables(params.figma_file_key);
          }

          const result = figmaVariablesToW3C(variables, collections, {
            collectionNames: params.collection_names,
          });
          tokenSets = result.tokenSets;
          stats = result.stats;
        } catch (varError) {
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

        // 2. Merge and flatten tokens
        const merged = mergeTokenSets(tokenSets);
        const flatTokens = flattenTokens(merged);

        if (flatTokens.length === 0) {
          const output: UnusedTokenResult = {
            totalTokens: 0,
            usedTokens: 0,
            unusedTokens: [],
            usageMap: [],
            summary: "No tokens found to analyze.",
          };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
          };
        }

        // 3. Derive search patterns for each token
        const patterns: TokenSearchPatterns[] = flatTokens.map((t) =>
          deriveSearchPatterns(t.name, t.path)
        );

        // 4. Search GitHub repo for token references
        const { usage, warnings } = await searchTokenUsage(
          githubClient,
          params.github_repo,
          patterns,
          params.search_patterns,
          params.file_extensions
        );

        // 5. Build unused token list
        const unusedTokens: UnusedTokenEntry[] = [];
        let usedCount = 0;

        for (const entry of usage) {
          if (entry.references === 0) {
            const tokenInfo = flatTokens.find((t) => t.name === entry.tokenName);
            if (tokenInfo) {
              const searchPattern = patterns.find((p) => p.tokenName === entry.tokenName);
              unusedTokens.push({
                name: tokenInfo.name,
                type: tokenInfo.type,
                value: tokenInfo.value,
                collection: tokenInfo.collection,
                cssVarName: searchPattern?.cssVar ?? "",
                scssVarName: searchPattern?.scssVar ?? "",
              });
            }
          } else {
            usedCount++;
          }
        }

        const result: UnusedTokenResult = {
          totalTokens: flatTokens.length,
          usedTokens: usedCount,
          unusedTokens,
          usageMap: usage.filter((u) => u.references > 0),
          summary: `${unusedTokens.length} of ${flatTokens.length} tokens appear unused in ${params.github_repo}. ` +
            `${usedCount} tokens have references in the codebase.` +
            (warnings.length > 0 ? ` (${warnings.length} warnings — results may be incomplete)` : ""),
        };

        const output: Record<string, unknown> = { ...result };
        if (warnings.length > 0) {
          output.warnings = warnings;
        }
        output.tokenStats = stats;

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

/** Flatten a nested W3C token file into a flat array of tokens */
interface FlatToken {
  name: string;
  path: string[];
  value: string | number | boolean;
  type: string;
  collection?: string;
}

function flattenTokens(
  tokens: W3CTokenFile,
  path: string[] = [],
  result: FlatToken[] = []
): FlatToken[] {
  for (const [key, val] of Object.entries(tokens)) {
    if (key.startsWith("$")) continue;

    if (typeof val === "object" && val !== null && "$value" in val) {
      const token = val as { $value: unknown; $type?: string; $description?: string };
      result.push({
        name: [...path, key].join("/"),
        path: [...path, key],
        value: token.$value as string | number | boolean,
        type: token.$type ?? "unknown",
        collection: path[0],
      });
    } else if (typeof val === "object" && val !== null) {
      flattenTokens(val as W3CTokenFile, [...path, key], result);
    }
  }

  return result;
}

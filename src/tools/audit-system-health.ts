/**
 * Tool 4: audit_system_health — Orchestrator tool that combines token drift + component parity
 * into a single health score for the design system.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FigmaClient } from "../clients/figma.js";
import { GitHubClient } from "../clients/github.js";
import { figmaVariablesToW3C, mergeTokenSets } from "../utils/w3c-tokens.js";
import { diffTokens, diffComponents } from "../utils/diff.js";
import { extractFigmaComponents, extractFigmaComponentsFromFile, parseStorybookManifest } from "../utils/component-parsers.js";
import { toUserMessage } from "../utils/errors.js";
import type { W3CTokenFile } from "../types/tokens.js";
import type {
  TokenDiffResult,
  ComponentDiffResult,
  CodeComponentEntry,
  SystemHealthReport,
} from "../types/components.js";

const InputSchema = z.object({
  figma_file_key: z.string()
    .min(1)
    .describe("The Figma file key"),
  github_repo: z.string()
    .min(1)
    .describe("GitHub repository in 'owner/repo' format"),
  token_file_path: z.string()
    .optional()
    .describe("Path to the token file in the repo (JSON, W3C format) to compare against Figma tokens"),
  storybook_manifest_path: z.string()
    .optional()
    .describe("Path to Storybook stories.json in the repo"),
  component_mapping_path: z.string()
    .optional()
    .describe("Path to component mapping JSON in the repo"),
}).strict();

type Input = z.infer<typeof InputSchema>;

export function registerAuditSystemHealth(
  server: McpServer,
  figmaClient: FigmaClient,
  githubClient: GitHubClient | null
): void {
  server.registerTool(
    "audit_system_health",
    {
      title: "Audit Design System Health",
      description: `Run a comprehensive health check on your design system, combining token drift analysis and component parity into a single sync score.

This is an orchestrator tool that calls extract_tokens + audit_component_parity internally and merges the results into a unified health report.

Args:
  - figma_file_key (string): The Figma file key
  - github_repo (string): GitHub repo in 'owner/repo' format
  - token_file_path (string, optional): Path to token JSON file in the repo to diff against
  - storybook_manifest_path (string, optional): Path to stories.json for component parity
  - component_mapping_path (string, optional): Path to component mapping JSON

Returns:
  Health report with:
  - score (0-100): Overall sync health
  - tokenDrift: Token diff results (added, removed, changed)
  - componentParity: Component coverage results
  - warnings: Array of non-fatal errors encountered
  - timestamp: When the audit ran

Examples:
  - "How in sync is our design system?" → audit_system_health
  - "Give me a health report for our DS" → audit_system_health with all paths`,
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
              text: "GITHUB_TOKEN is not set. This tool requires GitHub access.\n\nSuggestion: Set GITHUB_TOKEN with 'repo' scope.",
            }],
          };
        }

        let tokenDrift: TokenDiffResult | null = null;
        let componentParity: ComponentDiffResult | null = null;
        const warnings: string[] = [];

        // Token drift analysis
        if (params.token_file_path) {
          try {
            const [figmaResponse, codeTokenContent] = await Promise.all([
              figmaClient.getLocalVariables(params.figma_file_key),
              githubClient.getFileContent(params.github_repo, params.token_file_path),
            ]);

            const { tokenSets } = figmaVariablesToW3C(
              figmaResponse.meta.variables,
              figmaResponse.meta.variableCollections
            );

            const figmaTokens = mergeTokenSets(tokenSets);
            const codeTokens = JSON.parse(codeTokenContent) as W3CTokenFile;

            tokenDrift = diffTokens(figmaTokens, codeTokens);
          } catch (error) {
            warnings.push(`Token drift analysis failed: ${toUserMessage(error)}`);
          }
        }

        // Component parity analysis
        if (params.storybook_manifest_path || params.component_mapping_path) {
          try {
            const figmaCompResponse = await figmaClient.getComponents(params.figma_file_key);
            let figmaComponents = extractFigmaComponents(
              figmaCompResponse,
              params.figma_file_key
            );

            let usedFallback = false;
            if (figmaComponents.length === 0) {
              const fileResponse = await figmaClient.getFile(params.figma_file_key);
              figmaComponents = extractFigmaComponentsFromFile(
                fileResponse,
                params.figma_file_key
              );
              usedFallback = figmaComponents.length > 0;
            }

            let codeComponents: CodeComponentEntry[] = [];

            if (params.storybook_manifest_path) {
              const manifestContent = await githubClient.getFileContent(
                params.github_repo,
                params.storybook_manifest_path
              );
              codeComponents = parseStorybookManifest(manifestContent);
            }

            if (params.component_mapping_path) {
              const mappingContent = await githubClient.getFileContent(
                params.github_repo,
                params.component_mapping_path
              );
              const mappings = JSON.parse(mappingContent);
              if (Array.isArray(mappings) && codeComponents.length === 0) {
                codeComponents = mappings.map((m: { codeName: string; filePath?: string }) => ({
                  name: m.codeName,
                  filePath: m.filePath,
                  hasStory: false,
                }));
              }
            }

            componentParity = diffComponents(figmaComponents, codeComponents);

            if (usedFallback) {
              warnings.push(
                "No published components found. Fell back to scanning the file tree for local (unpublished) components. " +
                "Publish your components to a library for faster and more reliable results."
              );
            } else if (figmaComponents.length === 0) {
              warnings.push(
                "No components found in the Figma file — neither published nor in the document tree. " +
                "Ensure the file contains component nodes, or use a component_mapping_path to define mappings manually."
              );
            }
          } catch (error) {
            warnings.push(`Component parity analysis failed: ${toUserMessage(error)}`);
          }
        }

        // Calculate health score
        const score = calculateHealthScore(tokenDrift, componentParity);

        const report: SystemHealthReport = {
          score,
          tokenDrift,
          componentParity,
          timestamp: new Date().toISOString(),
          figmaFileKey: params.figma_file_key,
          githubRepo: params.github_repo,
        };

        // Include warnings in output if any
        const output = warnings.length > 0
          ? { ...report, warnings }
          : report;

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
 * Calculate a 0-100 health score based on token drift and component parity.
 * Weights: 50% tokens, 50% components. If only one is available, it gets 100% weight.
 */
function calculateHealthScore(
  tokenDrift: TokenDiffResult | null,
  componentParity: ComponentDiffResult | null
): number {
  let tokenScore: number | null = null;
  let componentScore: number | null = null;

  if (tokenDrift) {
    const total = tokenDrift.summary.totalFigma;
    if (total === 0) {
      tokenScore = 100;
    } else {
      const driftCount = tokenDrift.summary.added + tokenDrift.summary.removed + tokenDrift.summary.changed;
      tokenScore = Math.max(0, Math.round(((total - driftCount) / total) * 100));
    }
  }

  if (componentParity) {
    componentScore = componentParity.summary.coveragePercent;
  }

  if (tokenScore !== null && componentScore !== null) {
    return Math.round((tokenScore + componentScore) / 2);
  }
  if (tokenScore !== null) return tokenScore;
  if (componentScore !== null) return componentScore;
  return 0;
}

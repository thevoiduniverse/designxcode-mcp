/**
 * Tool 3: audit_component_parity — Compare Figma components vs code components.
 * Read-only audit that reports coverage, missing components, and matches.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FigmaClient } from "../clients/figma.js";
import { GitHubClient } from "../clients/github.js";
import { diffComponents } from "../utils/diff.js";
import { extractFigmaComponents, extractFigmaComponentsFromFile, parseStorybookManifest } from "../utils/component-parsers.js";
import { toUserMessage } from "../utils/errors.js";
import type { CodeComponentEntry, ComponentMapping } from "../types/components.js";

const InputSchema = z.object({
  figma_file_key: z.string()
    .min(1)
    .describe("The Figma file key"),
  figma_page_name: z.string()
    .optional()
    .describe("Optional Figma page name to filter components (e.g. 'Components')"),
  github_repo: z.string()
    .min(1)
    .describe("GitHub repository in 'owner/repo' format"),
  storybook_manifest_path: z.string()
    .optional()
    .describe("Path to Storybook stories.json manifest in the repo (e.g. 'storybook-static/stories.json')"),
  component_mapping_path: z.string()
    .optional()
    .describe("Path to a JSON mapping file in the repo that maps Figma names to code names"),
}).strict();

type Input = z.infer<typeof InputSchema>;

export function registerAuditComponentParity(
  server: McpServer,
  figmaClient: FigmaClient,
  githubClient: GitHubClient | null
): void {
  server.registerTool(
    "audit_component_parity",
    {
      title: "Audit Component Parity",
      description: `Compare Figma components against code components to find coverage gaps.

Fetches components from Figma and compares against a Storybook manifest or component mapping from GitHub.
Uses fuzzy name matching (normalizes casing, strips spaces/hyphens) to find matches.

Args:
  - figma_file_key (string): The Figma file key
  - figma_page_name (string, optional): Filter Figma components to a specific page
  - github_repo (string): GitHub repo in 'owner/repo' format
  - storybook_manifest_path (string, optional): Path to stories.json in the repo
  - component_mapping_path (string, optional): Path to a JSON mapping file

Returns:
  Coverage report with: matched components, missing in code, missing in Figma, coverage percentage, and Figma links.

Examples:
  - "How many of our Figma components are implemented?" → audit_component_parity
  - "Check parity for our design system" → audit_component_parity with storybook path`,
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
              text: "GITHUB_TOKEN is not set. This tool requires GitHub access to read code components.\n\nSuggestion: Set GITHUB_TOKEN with 'repo' scope.",
            }],
          };
        }

        // Fetch Figma components (published first, fallback to file tree for unpublished)
        const figmaResponse = await figmaClient.getComponents(params.figma_file_key);
        let figmaComponents = extractFigmaComponents(
          figmaResponse,
          params.figma_file_key,
          params.figma_page_name
        );

        let usedFallback = false;
        if (figmaComponents.length === 0) {
          const fileResponse = await figmaClient.getFile(params.figma_file_key);
          figmaComponents = extractFigmaComponentsFromFile(
            fileResponse,
            params.figma_file_key,
            params.figma_page_name
          );
          usedFallback = figmaComponents.length > 0;
        }

        // Fetch code components from Storybook manifest or mapping file
        let codeComponents: CodeComponentEntry[] = [];
        let mappings: ComponentMapping[] | undefined;

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
          const parsed = JSON.parse(mappingContent);
          if (Array.isArray(parsed)) {
            mappings = parsed as ComponentMapping[];
            // Also add mapped code names to code components if not from storybook
            if (codeComponents.length === 0) {
              codeComponents = parsed.map((m: ComponentMapping) => ({
                name: m.codeName,
                filePath: m.filePath,
                hasStory: false,
              }));
            }
          }
        }

        if (codeComponents.length === 0 && !params.storybook_manifest_path && !params.component_mapping_path) {
          return {
            isError: true,
            content: [{
              type: "text" as const,
              text: "No code component source specified. Provide either storybook_manifest_path or component_mapping_path to compare against.",
            }],
          };
        }

        const result = diffComponents(figmaComponents, codeComponents, mappings);

        const warnings: string[] = [];
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

        const output = {
          ...result,
          ...(warnings.length > 0 ? { warnings } : {}),
          figmaFileKey: params.figma_file_key,
          githubRepo: params.github_repo,
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


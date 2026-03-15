/**
 * Tool 5: generate_sync_pr — Create a GitHub PR with token/component updates.
 * Supports dry_run mode for previewing changes without creating the PR.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GitHubClient, type FileToCommit } from "../clients/github.js";
import { toUserMessage } from "../utils/errors.js";

const TokenUpdateSchema = z.object({
  path: z.string().describe("File path in the repo"),
  content: z.string().describe("New file content"),
  platform: z.string().optional().describe("Platform this file targets (e.g. 'css', 'swift')"),
}).strict();

const InputSchema = z.object({
  github_repo: z.string()
    .min(1)
    .describe("GitHub repository in 'owner/repo' format"),
  base_branch: z.string()
    .optional()
    .describe("Base branch to create PR against (default: repo's default branch)"),
  token_updates: z.array(TokenUpdateSchema)
    .min(1)
    .describe("Array of file updates to include in the PR. Each has 'path' and 'content'."),
  pr_title: z.string()
    .optional()
    .default("chore(tokens): sync design tokens from Figma")
    .describe("PR title"),
  pr_body: z.string()
    .optional()
    .describe("Optional custom PR body. If not provided, a structured body is auto-generated."),
  dry_run: z.boolean()
    .optional()
    .default(false)
    .describe("If true, return a preview of the PR without actually creating it"),
}).strict();

type Input = z.infer<typeof InputSchema>;

export function registerGenerateSyncPR(
  server: McpServer,
  githubClient: GitHubClient | null
): void {
  server.registerTool(
    "generate_sync_pr",
    {
      title: "Generate Sync PR",
      description: `Create a GitHub pull request to sync design token changes from Figma to code.

Takes an array of file updates (typically from sync_tokens_to_code output) and creates a branch, commits the files, and opens a PR. Supports dry_run mode to preview without creating.

Args:
  - github_repo (string): GitHub repo in 'owner/repo' format
  - base_branch (string, optional): Base branch (default: repo's default branch)
  - token_updates (array): Files to update, each with 'path' and 'content'
  - pr_title (string, optional): PR title
  - pr_body (string, optional): Custom PR body
  - dry_run (boolean, optional): Preview without creating (default: false)

Returns:
  For dry_run: PR preview with branch name, title, body, and files.
  For real: Created PR URL, number, branch, and commit SHA.

Examples:
  - "Create a PR with the token updates" → generate_sync_pr with token_updates from sync_tokens_to_code
  - "Preview what the PR would look like" → generate_sync_pr with dry_run: true`,
      inputSchema: InputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
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
              text: "GITHUB_TOKEN is not set. This tool requires GitHub access to create PRs.\n\nSuggestion: Set GITHUB_TOKEN with 'repo' scope.",
            }],
          };
        }

        const baseBranch = params.base_branch ?? await githubClient.getDefaultBranch(params.github_repo);
        const branchName = `designxcode/sync-tokens-${Date.now()}`;

        const body = params.pr_body ?? generatePRBody(params.token_updates);

        // Dry run — return preview
        if (params.dry_run) {
          const output = {
            dryRun: true,
            branch: branchName,
            baseBranch,
            title: params.pr_title,
            body,
            files: params.token_updates.map((f) => ({
              path: f.path,
              platform: f.platform,
              contentLength: f.content.length,
              preview: f.content.substring(0, 200) + (f.content.length > 200 ? "..." : ""),
            })),
          };

          return {
            content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
          };
        }

        // Real run — create branch, commit, PR
        await githubClient.createBranch(params.github_repo, baseBranch, branchName);

        const files: FileToCommit[] = params.token_updates.map((f) => ({
          path: f.path,
          content: f.content,
        }));

        const commitSha = await githubClient.commitFiles(
          params.github_repo,
          branchName,
          files,
          params.pr_title ?? "chore(tokens): sync design tokens from Figma"
        );

        const pr = await githubClient.createPR(
          params.github_repo,
          branchName,
          baseBranch,
          params.pr_title ?? "chore(tokens): sync design tokens from Figma",
          body
        );

        const output = {
          created: true,
          pr: {
            number: pr.number,
            url: pr.url,
          },
          branch: branchName,
          baseBranch,
          commitSha,
          filesUpdated: files.length,
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

function generatePRBody(
  updates: Array<{ path: string; content: string; platform?: string }>
): string {
  const fileList = updates
    .map((f) => `- \`${f.path}\`${f.platform ? ` (${f.platform})` : ""}`)
    .join("\n");

  return `## Summary

Automated design token sync from Figma via DesignxCode MCP.

## Files Updated

${fileList}

## Token Changes

This PR updates design tokens to match the current Figma source of truth.
Review the file diffs below for specific value changes.

---

*Generated by [DesignxCode MCP](https://github.com/designxcode/mcp-server)*`;
}

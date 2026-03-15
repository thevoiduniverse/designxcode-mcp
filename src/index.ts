#!/usr/bin/env node
/**
 * DesignxCode MCP Server
 *
 * Keeps Figma design systems and code in sync — auditing token drift,
 * comparing component parity, transforming tokens into multi-platform code,
 * and auto-generating GitHub PRs to fix drifts.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FigmaClient } from "./clients/figma.js";
import { GitHubClient } from "./clients/github.js";
import { envVarMissing } from "./utils/errors.js";

/**
 * Load .env file from the project root into process.env.
 * Only sets vars that aren't already in the environment,
 * so Claude Code's env config still takes precedence when valid.
 */
function loadEnvFile(): void {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const envPath = resolve(__dirname, "..", ".env");
  try {
    const contents = readFileSync(envPath, "utf-8");
    for (const line of contents.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();
      // Strip surrounding quotes
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      // .env values override process.env so token updates take effect without restarting Claude Code
      process.env[key] = value;
    }
  } catch {
    // No .env file — that's fine, fall through to process.env
  }
}
import { registerExtractTokens } from "./tools/extract-tokens.js";
import { registerSyncTokensToCode } from "./tools/sync-tokens-to-code.js";
import { registerAuditComponentParity } from "./tools/audit-component-parity.js";
import { registerAuditSystemHealth } from "./tools/audit-system-health.js";
import { registerGenerateSyncPR } from "./tools/generate-sync-pr.js";
import { registerExtractStyles } from "./tools/extract-styles.js";
import { registerExportAssets } from "./tools/export-assets.js";
// generate-component-scaffold removed: subsumed by generate-coded-components
import { registerDetectUnusedTokens } from "./tools/detect-unused-tokens.js";
import { DesignSystemCache } from "./cache/design-system-cache.js";
import { registerDesignSystemResources } from "./resources/design-system-resources.js";
import { registerGetDesignContext } from "./tools/get-design-context.js";
import { registerSetDesignRules } from "./tools/set-design-rules.js";
import { registerUseDesignSystemPrompt } from "./prompts/use-design-system.js";
import { registerGenerateThemeConfig } from "./tools/generate-theme-config.js";
// generate-design-doc removed: overlaps with get-design-context
import { registerGenerateCodedComponents } from "./tools/generate-coded-components.js";
import { registerImplementDesign } from "./tools/implement-design.js";

async function main(): Promise<void> {
  // Load .env file (overrides stale process.env from Claude Code)
  loadEnvFile();

  // Validate required env vars
  const figmaToken = process.env.FIGMA_ACCESS_TOKEN;
  if (!figmaToken) {
    const error = envVarMissing(
      "FIGMA_ACCESS_TOKEN",
      "Required for all Figma API operations",
      "https://www.figma.com/developers/api#access-tokens"
    );
    console.error(error.toUserMessage());
    process.exit(1);
  }

  // GitHub token is optional — some tools work without it
  const githubToken = process.env.GITHUB_TOKEN;
  if (!githubToken) {
    console.error(
      "Warning: GITHUB_TOKEN is not set. Tools requiring GitHub access (audit_component_parity, audit_system_health, generate_sync_pr, detect_unused_tokens) will not work.\n" +
      "Set GITHUB_TOKEN with 'repo' scope to enable all features."
    );
  }

  // Initialize clients
  const figmaClient = new FigmaClient(figmaToken);
  const githubClient = githubToken ? new GitHubClient(githubToken) : null;

  // Create MCP server
  const server = new McpServer({
    name: "designxcode-mcp",
    version: "1.0.0",
  });

  // Initialize design system cache
  const dsCache = new DesignSystemCache();

  // Register all tools
  registerExtractTokens(server, figmaClient);
  registerSyncTokensToCode(server, figmaClient);
  registerAuditComponentParity(server, figmaClient, githubClient);
  registerAuditSystemHealth(server, figmaClient, githubClient);
  registerGenerateSyncPR(server, githubClient);
  registerExtractStyles(server, figmaClient);
  registerExportAssets(server, figmaClient);

  registerDetectUnusedTokens(server, figmaClient, githubClient);

  // Register design system context layer
  registerDesignSystemResources(server, figmaClient, dsCache);
  registerGetDesignContext(server, figmaClient, dsCache);
  registerSetDesignRules(server, dsCache);
  registerUseDesignSystemPrompt(server);

  // Register theme tool
  registerGenerateThemeConfig(server, figmaClient);

  // Register coded component generation
  registerGenerateCodedComponents(server, figmaClient);

  // Register design implementation (frame → design-system-aware code)
  registerImplementDesign(server, figmaClient, dsCache);

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("DesignxCode MCP server running via stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

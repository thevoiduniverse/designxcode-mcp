/**
 * Registers four MCP resources for design system context:
 * - designsystem://tokens/{fileKey}
 * - designsystem://components/{fileKey}
 * - designsystem://patterns/{fileKey}
 * - designsystem://rules/{fileKey}
 */

import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FigmaClient } from "../clients/figma.js";
import type { DesignSystemCache } from "../cache/design-system-cache.js";
import { figmaVariablesToW3C, mergeTokenSets } from "../utils/w3c-tokens.js";
import { fetchComponentsWithProps } from "../utils/component-context.js";
import {
  flattenW3CTokens,
  formatTokensMarkdown,
  formatComponentsMarkdown,
  formatPatternsMarkdown,
  formatRulesMarkdown,
} from "../utils/context-formatter.js";
import { inferPatterns } from "../utils/pattern-inference.js";
import { toUserMessage } from "../utils/errors.js";
import { readRulesFile } from "../tools/set-design-rules.js";

export function registerDesignSystemResources(
  server: McpServer,
  figmaClient: FigmaClient,
  cache: DesignSystemCache
): void {
  // --- Tokens Resource ---
  server.registerResource(
    "design-system-tokens",
    new ResourceTemplate("designsystem://tokens/{fileKey}", { list: undefined }),
    { title: "Design System Tokens", description: "Design tokens as CSS variable mappings from a Figma file" },
    async (uri, variables) => {
      const fileKey = variables.fileKey as string;

      const cached = cache.get(fileKey, "tokens");
      if (cached) {
        return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: cached }] };
      }

      try {
        // Fetch variables
        const response = await figmaClient.getLocalVariables(fileKey);
        const variablesData = response.meta.variables;
        const collections = response.meta.variableCollections;

        let markdown: string;

        if (Object.keys(variablesData).length > 0) {
          const { tokenSets } = figmaVariablesToW3C(variablesData, collections);
          const merged = mergeTokenSets(tokenSets);
          const flat = flattenW3CTokens(merged);
          markdown = formatTokensMarkdown(flat);
        } else {
          markdown = "## Design Tokens\n\nNo variables found. Check if the file uses Figma Variables.\n";
        }

        cache.set(fileKey, "tokens", markdown);
        return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: markdown }] };
      } catch (error) {
        const msg = `## Design Tokens\n\n> Error: ${toUserMessage(error)}\n`;
        return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: msg }] };
      }
    }
  );

  // --- Components Resource ---
  server.registerResource(
    "design-system-components",
    new ResourceTemplate("designsystem://components/{fileKey}", { list: undefined }),
    { title: "Design System Components", description: "Component inventory with props and variants from a Figma file" },
    async (uri, variables) => {
      const fileKey = variables.fileKey as string;

      const cached = cache.get(fileKey, "components");
      if (cached) {
        return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: cached }] };
      }

      try {
        const componentsWithProps = await fetchComponentsWithProps(figmaClient, fileKey);
        const markdown = formatComponentsMarkdown(componentsWithProps);
        cache.set(fileKey, "components", markdown);
        return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: markdown }] };
      } catch (error) {
        const msg = `## Available Components\n\n> Error: ${toUserMessage(error)}\n`;
        return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: msg }] };
      }
    }
  );

  // --- Patterns Resource ---
  server.registerResource(
    "design-system-patterns",
    new ResourceTemplate("designsystem://patterns/{fileKey}", { list: undefined }),
    { title: "Design System Patterns", description: "Auto-inferred usage patterns from Figma layouts" },
    async (uri, variables) => {
      const fileKey = variables.fileKey as string;

      const cached = cache.get(fileKey, "patterns");
      if (cached) {
        return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: cached }] };
      }

      try {
        // Build token map for value -> name mapping
        let tokenMap: Map<string, string> | undefined;
        try {
          const response = await figmaClient.getLocalVariables(fileKey);
          const { tokenSets } = figmaVariablesToW3C(response.meta.variables, response.meta.variableCollections);
          const merged = mergeTokenSets(tokenSets);
          const flat = flattenW3CTokens(merged);
          tokenMap = new Map(flat.map((t) => [String(t.value), `--${t.name}`]));
        } catch {
          // Token map is optional -- patterns still work without it
        }

        const patternGroups = await inferPatterns(figmaClient, fileKey, tokenMap);
        const markdown = formatPatternsMarkdown(patternGroups);
        cache.set(fileKey, "patterns", markdown);
        return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: markdown }] };
      } catch (error) {
        const msg = `## Usage Patterns\n\n> Error: Pattern inference failed: ${toUserMessage(error)}. Tokens and components are still available.\n`;
        return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: msg }] };
      }
    }
  );

  // --- Rules Resource ---
  server.registerResource(
    "design-system-rules",
    new ResourceTemplate("designsystem://rules/{fileKey}", { list: undefined }),
    { title: "Design System Rules", description: "User-defined design rules and overrides" },
    async (uri, variables) => {
      const fileKey = variables.fileKey as string;

      const cached = cache.get(fileKey, "rules");
      if (cached) {
        return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: cached }] };
      }

      const rules = readRulesFile(fileKey);
      const markdown = formatRulesMarkdown(rules);
      cache.set(fileKey, "rules", markdown);
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: markdown }] };
    }
  );
}

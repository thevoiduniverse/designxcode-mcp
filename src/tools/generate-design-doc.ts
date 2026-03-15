/**
 * Tool: generate_design_doc — Auto-generate a self-contained design system
 * reference document from a Figma file.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FigmaClient } from "../clients/figma.js";
import type { DesignSystemCache } from "../cache/design-system-cache.js";
import { figmaVariablesToW3C, mergeTokenSets } from "../utils/w3c-tokens.js";
import { flattenW3CTokens } from "../utils/context-formatter.js";
import type { FlatToken, ComponentWithProps, PatternGroup } from "../utils/context-formatter.js";
import { fetchComponentsWithProps } from "../utils/component-context.js";
import { inferPatterns } from "../utils/pattern-inference.js";
import { generateMarkdown, generateMDX, generateHTML } from "../utils/doc-generators.js";
import type { DocData } from "../utils/doc-generators.js";
import { toUserMessage } from "../utils/errors.js";

const InputSchema = z.object({
  figma_file_key: z.string().min(1)
    .describe("The Figma file key (from the URL: figma.com/design/{THIS_PART}/...)"),
  output_format: z.enum(["markdown", "mdx", "html", "all"])
    .default("markdown")
    .describe("Output format (default: 'markdown')"),
  include_sections: z.array(z.enum(["tokens", "components", "patterns"]))
    .optional()
    .describe("Sections to include (default: all)"),
  include_previews: z.boolean().default(true)
    .describe("Fetch Figma preview images for components (default: true)"),
  title: z.string().optional()
    .describe("Document title (defaults to Figma file name)"),
}).strict();

type Input = z.infer<typeof InputSchema>;

/** Categorize a flat token for doc sections */
function categorizeForDoc(token: FlatToken): "color" | "typography" | "spacing" | "other" {
  if (token.type === "color") return "color";
  const n = token.name.toLowerCase();
  if (n.includes("font") || n.includes("text-size") || n.includes("line-height") || n.includes("letter-spacing")) return "typography";
  if (n.includes("spacing") || n.includes("gap") || n.includes("padding") || n.includes("margin") || n.includes("size") || n.includes("width") || n.includes("height") || n.includes("radius")) return "spacing";
  return "other";
}

export function registerGenerateDesignDoc(
  server: McpServer,
  figmaClient: FigmaClient,
  cache: DesignSystemCache
): void {
  server.registerTool(
    "generate_design_doc",
    {
      title: "Generate Design Doc",
      description: `Generate a self-contained design system reference document from a Figma file.

Includes color palette with visual swatches, typography scale, spacing scale,
component catalog with props/previews/usage examples, and inferred usage patterns.

Args:
  - figma_file_key (string): The Figma file key
  - output_format ('markdown' | 'mdx' | 'html' | 'all'): Output format (default: 'markdown')
  - include_sections (string[], optional): Sections to include (default: all)
  - include_previews (boolean): Fetch Figma component previews (default: true)
  - title (string, optional): Document title (defaults to Figma file name)

Returns:
  JSON with generated document file(s) and summary stats.`,
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
        const sections = params.include_sections ?? ["tokens", "components", "patterns"];
        const warnings: string[] = [];

        // 1. Get file name for title
        let docTitle = params.title ?? "Design System";
        if (!params.title) {
          try {
            const file = await figmaClient.getFile(params.figma_file_key, 1);
            docTitle = file.name ?? "Design System";
          } catch {
            // Use default title
          }
        }

        // 2. Fetch and categorize tokens
        let colors: FlatToken[] = [];
        let typography: FlatToken[] = [];
        let spacing: FlatToken[] = [];

        if (sections.includes("tokens")) {
          try {
            const response = await figmaClient.getLocalVariables(params.figma_file_key);
            const { tokenSets } = figmaVariablesToW3C(response.meta.variables, response.meta.variableCollections);
            const merged = mergeTokenSets(tokenSets);
            const flat = flattenW3CTokens(merged);

            for (const token of flat) {
              const cat = categorizeForDoc(token);
              if (cat === "color") colors.push(token);
              else if (cat === "typography") typography.push(token);
              else if (cat === "spacing") spacing.push(token);
            }

            // Sort spacing by value ascending
            spacing.sort((a, b) => (Number(a.value) || 0) - (Number(b.value) || 0));
          } catch (error) {
            warnings.push(`Token extraction failed: ${toUserMessage(error)}`);
          }
        }

        // 3. Fetch components
        let componentsWithProps: ComponentWithProps[] = [];
        if (sections.includes("components")) {
          try {
            componentsWithProps = await fetchComponentsWithProps(figmaClient, params.figma_file_key);
          } catch (error) {
            warnings.push(`Component extraction failed: ${toUserMessage(error)}`);
          }
        }

        // 4. Fetch preview images (using nodeId from FigmaComponentEntry)
        const previews = new Map<string, string>();
        if (params.include_previews && componentsWithProps.length > 0) {
          try {
            const nodeIds = componentsWithProps
              .map((c) => c.component.nodeId)
              .filter((id): id is string => !!id);
            if (nodeIds.length > 0) {
              const imageResponse = await figmaClient.getImages(
                params.figma_file_key,
                nodeIds,
                "png",
                2
              );
              for (const [nodeId, url] of Object.entries(imageResponse.images)) {
                if (url) previews.set(nodeId, url);
              }
              if (previews.size > 0) {
                warnings.push(
                  "Preview images are temporary Figma CDN links (~2 weeks). " +
                  "For permanent docs, use export_assets to download and self-host."
                );
              }
            }
          } catch {
            warnings.push("Failed to fetch component preview images.");
          }
        }

        // 5. Patterns (with cache — store JSON, not markdown)
        let patternGroups: PatternGroup[] = [];
        if (sections.includes("patterns")) {
          const cachedPatterns = cache.get(params.figma_file_key, "patterns-json");
          if (cachedPatterns) {
            try {
              patternGroups = JSON.parse(cachedPatterns) as PatternGroup[];
            } catch {
              // Corrupted cache — re-infer
              patternGroups = [];
            }
          }
          if (patternGroups.length === 0) {
            try {
              patternGroups = await inferPatterns(figmaClient, params.figma_file_key);
              cache.set(params.figma_file_key, "patterns-json", JSON.stringify(patternGroups));
            } catch {
              // Patterns are best-effort
            }
          }
        }

        // 6. Assemble doc data
        const docData: DocData = {
          title: docTitle,
          fileKey: params.figma_file_key,
          generatedAt: new Date().toISOString().split("T")[0],
          colors,
          typography,
          spacing,
          components: componentsWithProps,
          patterns: patternGroups,
          previews,
          warnings,
        };

        // 7. Generate output files
        const files: Array<{ path: string; content: string; description: string }> = [];
        const formats = params.output_format === "all"
          ? ["markdown", "mdx", "html"] as const
          : [params.output_format] as const;

        for (const format of formats) {
          switch (format) {
            case "markdown":
              files.push({
                path: "design-system.md",
                content: generateMarkdown(docData),
                description: "Design system documentation in Markdown format",
              });
              break;
            case "mdx":
              files.push({
                path: "design-system.mdx",
                content: generateMDX(docData),
                description: "Design system documentation in MDX format (requires custom components)",
              });
              break;
            case "html":
              files.push({
                path: "design-system.html",
                content: generateHTML(docData),
                description: "Self-contained HTML design system documentation",
              });
              break;
          }
        }

        const output = {
          files,
          summary: {
            title: docTitle,
            colorCount: colors.length,
            typographyCount: typography.length,
            spacingCount: spacing.length,
            componentCount: componentsWithProps.length,
            patternCount: patternGroups.reduce((sum, g) => sum + g.patterns.length, 0),
            formats: formats as unknown as string[],
            includesPreviews: previews.size > 0,
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

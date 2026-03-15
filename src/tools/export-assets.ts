/**
 * Tool 7: export_assets — Export SVG/PNG/JPG/PDF assets from Figma components.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FigmaClient } from "../clients/figma.js";
import { toUserMessage } from "../utils/errors.js";
import {
  extractFigmaComponents,
  extractFigmaComponentsFromFile,
} from "../utils/component-parsers.js";

const InputSchema = z.object({
  figma_file_key: z.string()
    .min(1)
    .describe("The Figma file key (from the URL: figma.com/design/{THIS_PART}/...)"),
  node_ids: z.array(z.string())
    .optional()
    .describe("Specific node IDs to export. If omitted, exports all components."),
  component_names: z.array(z.string())
    .optional()
    .describe("Filter components by name (alternative to node_ids)."),
  format: z.enum(["svg", "png", "jpg", "pdf"])
    .default("svg")
    .describe("Export format (default: 'svg')"),
  scale: z.number()
    .min(0.01)
    .max(4)
    .default(1)
    .describe("Render scale 0.01–4 (default: 1, ignored for SVG)"),
  page_name: z.string()
    .optional()
    .describe("Filter components to a specific page"),
  inline_svg: z.boolean()
    .default(false)
    .describe("If true and format is 'svg', fetch and return SVG content inline"),
}).strict();

type Input = z.infer<typeof InputSchema>;

export function registerExportAssets(server: McpServer, figmaClient: FigmaClient): void {
  server.registerTool(
    "export_assets",
    {
      title: "Export Figma Assets",
      description: `Export SVG/PNG/JPG/PDF assets from Figma components.

Renders component nodes as images via the Figma Image API. Can export specific nodes by ID,
filter by component name or page, and optionally fetch SVG content inline.

Args:
  - figma_file_key (string): The Figma file key from the URL
  - node_ids (string[], optional): Specific node IDs to export
  - component_names (string[], optional): Filter components by name
  - format ('svg' | 'png' | 'jpg' | 'pdf'): Export format (default: 'svg')
  - scale (number, optional): Render scale 0.01–4 (default: 1, ignored for SVG)
  - page_name (string, optional): Filter to a specific page
  - inline_svg (boolean, optional): Fetch SVG content inline (default: false)

Returns:
  JSON with asset URLs (and optional inline SVG content) for each exported component.

Examples:
  - "Export all icons as SVG" → export_assets with format: "svg", page_name: "Icons"
  - "Export Button component as PNG at 2x" → export_assets with component_names: ["Button"], format: "png", scale: 2
  - "Get inline SVG for the Logo" → export_assets with component_names: ["Logo"], inline_svg: true`,
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
        let nodeIds: string[] = [];
        let componentNameMap = new Map<string, string>(); // nodeId → name

        if (params.node_ids && params.node_ids.length > 0) {
          // Use provided node IDs directly
          nodeIds = params.node_ids;
          for (const id of nodeIds) {
            componentNameMap.set(id, id);
          }
        } else {
          // Fetch components and resolve node IDs
          let components;
          try {
            const response = await figmaClient.getComponents(params.figma_file_key);
            components = extractFigmaComponents(response, params.figma_file_key, params.page_name);
          } catch {
            // Fallback to file tree for unpublished components
            const fileResponse = await figmaClient.getFile(params.figma_file_key);
            components = extractFigmaComponentsFromFile(fileResponse, params.figma_file_key, params.page_name);
          }

          // Filter by name if specified
          if (params.component_names && params.component_names.length > 0) {
            const nameSet = new Set(params.component_names.map((n) => n.toLowerCase()));
            components = components.filter((c) =>
              nameSet.has(c.name.toLowerCase())
            );
          }

          if (components.length === 0) {
            const output = {
              assets: [],
              summary: {
                total: 0,
                format: params.format,
                message: "No matching components found",
              },
            };
            return {
              content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
            };
          }

          // Extract node IDs from figmaUrls
          for (const comp of components) {
            const nodeId = extractNodeId(comp.figmaUrl);
            if (nodeId) {
              nodeIds.push(nodeId);
              componentNameMap.set(nodeId, comp.name);
            }
          }
        }

        if (nodeIds.length === 0) {
          const output = {
            assets: [],
            summary: { total: 0, format: params.format, message: "No exportable nodes found" },
          };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
          };
        }

        // Fetch images from Figma
        const imagesResponse = await figmaClient.getImages(
          params.figma_file_key,
          nodeIds,
          params.format,
          params.scale
        );

        if (imagesResponse.err) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: `Figma image export error: ${imagesResponse.err}` }],
          };
        }

        // Build asset list
        const assets: Array<{
          name: string;
          nodeId: string;
          format: string;
          url: string | null;
          svgContent?: string;
        }> = [];

        for (const [nodeId, url] of Object.entries(imagesResponse.images)) {
          const asset: typeof assets[number] = {
            name: componentNameMap.get(nodeId) ?? nodeId,
            nodeId,
            format: params.format,
            url,
          };

          // Fetch inline SVG content if requested
          if (params.inline_svg && params.format === "svg" && url) {
            try {
              const svgResponse = await fetch(url);
              if (svgResponse.ok) {
                asset.svgContent = await svgResponse.text();
              }
            } catch {
              // Failed to fetch inline SVG, URL is still available
            }
          }

          assets.push(asset);
        }

        const output = {
          assets,
          summary: {
            total: assets.length,
            format: params.format,
            scale: params.format === "svg" ? undefined : params.scale,
            withInlineSvg: params.inline_svg && params.format === "svg",
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

/** Extract node ID from a Figma URL */
function extractNodeId(figmaUrl?: string): string | undefined {
  if (!figmaUrl) return undefined;
  const match = figmaUrl.match(/node-id=([^&]+)/);
  if (match) {
    return decodeURIComponent(match[1]);
  }
  return undefined;
}

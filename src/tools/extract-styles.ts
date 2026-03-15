/**
 * Tool 6: extract_styles — Extract typography, fill, effect, and grid styles
 * from Figma with resolved values from actual document nodes.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FigmaClient } from "../clients/figma.js";
import { figmaNoStyles, toUserMessage } from "../utils/errors.js";
import {
  parseNodeFills,
  parseNodeTextStyle,
  parseNodeEffects,
  parseNodeGrids,
  stylesToCSS,
} from "../utils/style-parsers.js";
import type { ExtractedStyle, StyleProperties } from "../types/styles.js";

const StyleTypeEnum = z.enum(["FILL", "TEXT", "EFFECT", "GRID"]);

const InputSchema = z.object({
  figma_file_key: z.string()
    .min(1)
    .describe("The Figma file key (from the URL: figma.com/design/{THIS_PART}/...)"),
  style_types: z.array(StyleTypeEnum)
    .optional()
    .describe("Filter to specific style types. Omit to include all (FILL, TEXT, EFFECT, GRID)."),
  output_format: z.enum(["structured", "css", "raw"])
    .default("structured")
    .describe("Output format: 'structured' (grouped JSON), 'css' (custom properties), or 'raw' (node data)"),
}).strict();

type Input = z.infer<typeof InputSchema>;

export function registerExtractStyles(server: McpServer, figmaClient: FigmaClient): void {
  server.registerTool(
    "extract_styles",
    {
      title: "Extract Figma Styles",
      description: `Extract typography, fill, effect, and grid styles from a Figma file with resolved values.

Unlike variables/tokens, styles contain visual properties like font families, colors, shadows, and grid layouts.
This tool fetches style metadata AND resolves the actual property values from document nodes.

Args:
  - figma_file_key (string): The Figma file key from the URL
  - style_types (string[], optional): Filter to specific types: "FILL", "TEXT", "EFFECT", "GRID"
  - output_format ('structured' | 'css' | 'raw'): Output format (default: 'structured')

Returns:
  JSON with styles grouped by type, including resolved property values and summary statistics.

Examples:
  - "Extract all styles from our Figma file" → extract_styles with just figma_file_key
  - "Get only typography styles" → extract_styles with style_types: ["TEXT"]
  - "Export styles as CSS custom properties" → extract_styles with output_format: "css"`,
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
        // 1. Fetch style metadata (returns array of styles)
        const stylesResponse = await figmaClient.getFileStyles(params.figma_file_key);
        const styles = stylesResponse.meta.styles;

        if (styles.length === 0) {
          throw figmaNoStyles(params.figma_file_key);
        }

        // 2. Filter by style types if provided
        let filteredStyles = styles;
        if (params.style_types && params.style_types.length > 0) {
          filteredStyles = filteredStyles.filter((style) =>
            params.style_types!.includes(style.style_type)
          );
        }

        if (filteredStyles.length === 0) {
          const output = {
            styles: [],
            stats: { total: 0, byType: {} },
            message: `No styles found matching types: ${params.style_types?.join(", ")}`,
          };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
          };
        }

        // 3. Get node IDs and fetch node properties
        const nodeIds = filteredStyles.map((s) => s.node_id);

        // Batch node requests (Figma API supports up to ~50 nodes per request)
        const BATCH_SIZE = 50;
        const extractedStyles: ExtractedStyle[] = [];

        for (let i = 0; i < nodeIds.length; i += BATCH_SIZE) {
          const batchIds = nodeIds.slice(i, i + BATCH_SIZE);
          const nodesResponse = await figmaClient.getNodes(params.figma_file_key, batchIds);

          for (const style of filteredStyles) {
            if (!batchIds.includes(style.node_id)) continue;

            const nodeData = nodesResponse.nodes[style.node_id];
            if (!nodeData) continue;

            const node = nodeData.document;
            let properties: StyleProperties;

            switch (style.style_type) {
              case "FILL":
                properties = parseNodeFills(node);
                break;
              case "TEXT":
                properties = parseNodeTextStyle(node);
                break;
              case "EFFECT":
                properties = parseNodeEffects(node);
                break;
              case "GRID":
                properties = parseNodeGrids(node);
                break;
            }

            extractedStyles.push({
              name: style.name,
              key: style.key,
              styleType: style.style_type,
              description: style.description,
              nodeId: style.node_id,
              properties,
            });
          }
        }

        // 4. Format output
        if (params.output_format === "raw") {
          return {
            content: [{ type: "text" as const, text: JSON.stringify(extractedStyles, null, 2) }],
          };
        }

        if (params.output_format === "css") {
          const css = stylesToCSS(extractedStyles);
          return {
            content: [{ type: "text" as const, text: css }],
          };
        }

        // Structured output: group by type
        const byType: Record<string, ExtractedStyle[]> = {};
        for (const style of extractedStyles) {
          if (!byType[style.styleType]) {
            byType[style.styleType] = [];
          }
          byType[style.styleType].push(style);
        }

        const stats = {
          total: extractedStyles.length,
          byType: Object.fromEntries(
            Object.entries(byType).map(([type, styles]) => [type, styles.length])
          ),
        };

        const output = { styles: byType, stats };
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

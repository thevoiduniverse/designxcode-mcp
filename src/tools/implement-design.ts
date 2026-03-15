/**
 * Tool: implement_design
 * Converts a Figma frame into production code using design system tokens and components.
 * Every visual value is either matched to a token or explicitly flagged in the mapping report.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FigmaClient } from "../clients/figma.js";
import type { DesignSystemCache } from "../cache/design-system-cache.js";
import type { ComponentIR, EmittedComponent } from "../types/node-ir.js";
import { VariableResolver } from "../utils/variable-resolver.js";
import { parseNodeTree, sanitizeClassName } from "../utils/node-parser.js";
import { emitReactCSS } from "../utils/emitter-react-css.js";
import { emitHTMLCSS } from "../utils/emitter-html-css.js";
import { emitReactTailwind } from "../utils/emitter-react-tailwind.js";
import { emitReactNative } from "../utils/emitter-react-native.js";
import { toPascalCase } from "../utils/scaffold-templates.js";
import { toUserMessage } from "../utils/errors.js";
import { readRulesFile } from "./set-design-rules.js";
import {
  buildTokensByValue,
  buildStylesBySignature,
  matchTokens,
  loadLocalTokens,
} from "../utils/token-matcher.js";
import type { TokenMatchRecord } from "../utils/token-matcher.js";
import {
  buildComponentsByName,
  matchComponents,
} from "../utils/component-matcher.js";
import type { ComponentMatchRecord } from "../utils/component-matcher.js";

const InputSchema = z.object({
  figma_file_key: z.string().min(1)
    .describe("Figma file key containing the frame to implement"),
  node_id: z.string().min(1)
    .describe("Node ID of the frame/section to implement"),
  framework: z.enum(["react-tailwind", "react-css", "react-native", "html-css"])
    .describe("Target framework for code generation"),
  component_name: z.string().optional()
    .describe("Name for the generated component (default: inferred from Figma frame name)"),
  design_system_file_key: z.string().optional()
    .describe("Figma file key for the design system (tokens, components). If omitted, uses figma_file_key."),
}).strict();

type Input = z.infer<typeof InputSchema>;

export function registerImplementDesign(
  server: McpServer,
  figmaClient: FigmaClient,
  cache: DesignSystemCache,
): void {
  server.registerTool(
    "implement_design",
    {
      title: "Implement Design",
      description: `Convert a Figma frame into production code using design system tokens and components.

Every visual value (color, spacing, typography, shadow) is matched against the project's
design system tokens. Matched values use token references (e.g., var(--primary)); unmatched
values use raw Figma values and are flagged in the mapping report.

Args:
  - figma_file_key (string): Figma file key containing the frame to implement
  - node_id (string): Node ID of the frame/section to implement
  - framework ('react-tailwind' | 'react-css' | 'react-native' | 'html-css'): Target framework
  - component_name (string, optional): Name for the generated component (inferred from frame name if omitted)
  - design_system_file_key (string, optional): Figma file key for the design system (tokens, variables, components). Use when the design system is in a different file than the frame being implemented.

Returns:
  Three content blocks: generated code, token/component mapping report, and a Figma screenshot.`,
      inputSchema: InputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (params: Input) => {
      try {
        const warnings: string[] = [];
        const fileKey = params.figma_file_key;
        const dsFileKey = params.design_system_file_key || fileKey;
        const nodeId = params.node_id;

        if (dsFileKey !== fileKey) {
          warnings.push(`Using design system from separate file: ${dsFileKey}`);
        }

        // ── Step 1 + 2: Load design system context and fetch target frame (parallel) ──

        const [
          varsResult,
          componentsResponse,
          nodesResponse,
          imageResult,
        ] = await Promise.all([
          // Variables for token resolution — from DESIGN SYSTEM file
          figmaClient.getLocalVariables(dsFileKey).catch((err) => {
            warnings.push(
              "Variables API unavailable (requires Figma Enterprise/Organization plan). " +
              "Token matching will rely on value-based lookup only."
            );
            return null;
          }),
          // Component metadata — from DESIGN SYSTEM file
          figmaClient.getComponents(dsFileKey).catch((err) => {
            warnings.push(`Components API error: ${toUserMessage(err)}`);
            return null;
          }),
          // Target node tree — from FRAME file
          figmaClient.getNodes(fileKey, [nodeId]),
          // Screenshot — from FRAME file
          figmaClient.getImages(fileKey, [nodeId], "png", 2).catch((err) => {
            warnings.push(`Screenshot unavailable: ${toUserMessage(err)}`);
            return null;
          }),
        ]);

        // Validate node exists
        const nodeData = nodesResponse.nodes[nodeId];
        if (!nodeData) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: "Node not found in file. Check the node_id parameter." }],
          };
        }
        const rootNode = nodeData.document;

        // Read design rules from design system file (best-effort)
        const rules = readRulesFile(dsFileKey);

        // ── Step 2b: Fallback — fetch published styles if variables unavailable ──

        let stylesResponse = null;
        if (!varsResult) {
          stylesResponse = await figmaClient.getFileStyles(dsFileKey).catch((err) => {
            warnings.push(`Styles API error: ${toUserMessage(err)}`);
            return null;
          });
        }

        // ── Step 3: Build lookup indexes ──

        const variables = varsResult?.meta?.variables ?? {};
        const resolver = new VariableResolver(variables);

        const tokensByValue = buildTokensByValue(variables);

        // Fallback 1: Load local token file (.designxcode/tokens.json)
        if (tokensByValue.size === 0) {
          const localCount = loadLocalTokens(tokensByValue);
          if (localCount > 0) {
            warnings.push(`Loaded ${localCount} color tokens from local .designxcode/tokens.json`);
          }
        }

        // Fallback 2: Extract from published styles if still empty
        if (tokensByValue.size === 0 && stylesResponse) {
          const styles = stylesResponse?.meta?.styles ?? [];
          const styleNodeIds = styles.map((s: { node_id: string }) => s.node_id).filter(Boolean);
          if (styleNodeIds.length > 0) {
            try {
              const styleNodes = await figmaClient.getNodes(dsFileKey, styleNodeIds);
              for (const style of styles) {
                const nodeData = styleNodes.nodes[style.node_id];
                if (!nodeData?.document) continue;
                const doc = nodeData.document as unknown as Record<string, unknown>;
                const styleName = (style as { name: string }).name;
                const styleType = (style as { style_type: string }).style_type;

                if (styleType === "FILL") {
                  const fills = (doc.fills as Array<{ type: string; color?: { r: number; g: number; b: number; a: number } }>) || [];
                  for (const fill of fills) {
                    if (fill.type === "SOLID" && fill.color) {
                      const { r, g, b, a } = fill.color;
                      const ri = Math.round(r * 255);
                      const gi = Math.round(g * 255);
                      const bi = Math.round(b * 255);
                      const hex = `#${ri.toString(16).padStart(2, "0")}${gi.toString(16).padStart(2, "0")}${bi.toString(16).padStart(2, "0")}`;
                      tokensByValue.set(hex, { name: styleName, path: styleName.split("/"), type: "COLOR" });
                    }
                  }
                }
              }
              warnings.push(`Loaded ${tokensByValue.size} color tokens from published styles (fallback).`);
            } catch (err) {
              warnings.push(`Failed to resolve style nodes: ${toUserMessage(err)}`);
            }
          }
        }

        const stylesBySignature = buildStylesBySignature(variables);

        const metaComponents = componentsResponse?.meta?.components ?? [];
        const componentsByName = buildComponentsByName(metaComponents);

        // ── Step 4: Parse frame into IR ──

        const parsedTree = parseNodeTree(rootNode, resolver);

        // ── Step 5: Token matching pass ──

        const { tree: tokenMappedTree, records: tokenRecords } = matchTokens(
          parsedTree,
          resolver,
          tokensByValue,
          stylesBySignature,
        );

        // ── Step 6: Component matching pass ──

        const { tree: finalTree, records: componentRecords } = matchComponents(
          tokenMappedTree,
          componentsByName,
          metaComponents,
        );

        // ── Step 7: Emit code ──

        const componentName = params.component_name
          ? toPascalCase(params.component_name)
          : toPascalCase(rootNode.name || "Component");

        // Build a minimal ComponentIR for the emitter
        const ir: ComponentIR = {
          name: componentName,
          figmaName: rootNode.name || "Component",
          nodeId,
          figmaUrl: `https://www.figma.com/design/${fileKey}?node-id=${encodeURIComponent(nodeId)}`,
          description: "",
          defaultTree: finalTree,
          stateOverrides: [],
          dimensionalVariants: [],
          props: [],
          dependencies: [],
          warnings,
        };

        const emitter = getEmitter(params.framework);
        const emitted = emitter(ir, "src/components");

        // Extract the main code file content
        const codeContent = emitted.files.length > 0
          ? emitted.files.map((f) => `// ${f.path}\n${f.content}`).join("\n\n")
          : `export default function ${componentName}() {\n  return <div />\n}`;

        // ── Step 8: Assemble mapping report ──

        const report = assembleMappingReport(tokenRecords, componentRecords, rules, warnings);

        // ── Step 9: Build output content blocks ──

        const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];

        // Block 1: Code
        content.push({
          type: "text" as const,
          text: `## Generated Code (${params.framework})\n\n\`\`\`tsx\n${codeContent}\n\`\`\``,
        });

        // Block 2: Mapping Report
        content.push({
          type: "text" as const,
          text: report,
        });

        // Block 3: Screenshot (if available)
        const screenshotUrl = imageResult?.images?.[nodeId];
        if (screenshotUrl) {
          content.push({
            type: "text" as const,
            text: `## Screenshot\n\n![Figma Frame](${screenshotUrl})`,
          });
        }

        return { content };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: toUserMessage(error) }],
        };
      }
    }
  );
}

// ─── Helpers ───

function getEmitter(
  framework: string
): (ir: ComponentIR, outputDir: string) => EmittedComponent {
  switch (framework) {
    case "react-tailwind": return emitReactTailwind;
    case "react-css": return emitReactCSS;
    case "react-native": return emitReactNative;
    case "html-css": return emitHTMLCSS;
    default: return emitReactCSS;
  }
}

function assembleMappingReport(
  tokenRecords: TokenMatchRecord[],
  componentRecords: ComponentMatchRecord[],
  rules: Array<{ rule: string; category?: string }>,
  warnings: string[],
): string {
  const lines: string[] = ["## Token Mapping Report", ""];

  // ── Colors ──
  const colorRecords = tokenRecords.filter((r) =>
    r.property === "background" || r.property === "color"
  );
  if (colorRecords.length > 0) {
    lines.push("### Colors");
    for (const rec of colorRecords) {
      if (rec.status === "matched") {
        lines.push(`- ✅ ${rec.figmaValue} → ${rec.tokenName} [${rec.matchType}]`);
      } else {
        const nearestInfo = rec.nearest
          ? `, nearest: ${rec.nearest.name} (${rec.nearest.value})`
          : "";
        lines.push(`- ⚠️ ${rec.figmaValue} → NO MATCH [raw value used${nearestInfo}]`);
      }
    }
    lines.push("");
  }

  // ── Typography ──
  const typoRecords = tokenRecords.filter((r) =>
    ["fontSize", "fontWeight", "lineHeight", "letterSpacing"].includes(r.property)
  );
  if (typoRecords.length > 0) {
    lines.push("### Typography");
    for (const rec of typoRecords) {
      if (rec.status === "matched") {
        lines.push(`- ✅ ${rec.property}: ${rec.figmaValue} → ${rec.tokenName} [${rec.matchType}]`);
      } else {
        const nearestInfo = rec.nearest
          ? `, nearest: ${rec.nearest.name} (${rec.nearest.value})`
          : "";
        lines.push(`- ⚠️ ${rec.property}: ${rec.figmaValue} → NO MATCH [raw value used${nearestInfo}]`);
      }
    }
    lines.push("");
  }

  // ── Spacing ──
  const spacingRecords = tokenRecords.filter((r) =>
    ["gap", "rowGap", "columnGap", "padding", "paddingTop", "paddingRight",
     "paddingBottom", "paddingLeft", "borderRadius"].includes(r.property)
  );
  if (spacingRecords.length > 0) {
    lines.push("### Spacing");
    for (const rec of spacingRecords) {
      if (rec.status === "matched") {
        lines.push(`- ✅ ${rec.property}: ${rec.figmaValue} → ${rec.tokenName} [${rec.matchType}]`);
      } else {
        const nearestInfo = rec.nearest
          ? `, nearest: ${rec.nearest.name} (${rec.nearest.value})`
          : "";
        lines.push(`- ⚠️ ${rec.property}: ${rec.figmaValue} → NO MATCH [raw value used${nearestInfo}]`);
      }
    }
    lines.push("");
  }

  // ── Shadows ──
  const shadowRecords = tokenRecords.filter((r) => r.property === "boxShadow");
  if (shadowRecords.length > 0) {
    lines.push("### Shadows");
    for (const rec of shadowRecords) {
      if (rec.status === "matched") {
        lines.push(`- ✅ ${rec.figmaValue} → ${rec.tokenName} [${rec.matchType}]`);
      } else {
        lines.push(`- ⚠️ ${rec.figmaValue} → NO MATCH [raw value used]`);
      }
    }
    lines.push("");
  }

  // ── Components ──
  if (componentRecords.length > 0) {
    lines.push("### Components");
    for (const rec of componentRecords) {
      if (rec.status === "matched") {
        const propsStr = Object.entries(rec.props)
          .map(([k, v]) => `${k}="${v}"`)
          .join(" ");
        lines.push(`- ✅ ${rec.figmaComponentName} → <${rec.codeComponentName} ${propsStr}/>`);
      } else {
        lines.push(`- ⚠️ ${rec.figmaComponentName} → NOT FOUND IN CODE [expanded to raw elements]`);
      }
    }
    lines.push("");
  }

  // ── Summary ──
  const matchedTokens = tokenRecords.filter((r) => r.status === "matched").length;
  const unmatchedTokens = tokenRecords.filter((r) => r.status === "unmatched").length;
  const matchedComponents = componentRecords.filter((r) => r.status === "matched").length;
  const unmatchedComponents = componentRecords.filter((r) => r.status === "not_found").length;

  lines.push("### Summary");
  lines.push(`- ${matchedTokens} values matched to tokens`);
  lines.push(`- ${unmatchedTokens} values unmatched (raw values used)`);
  lines.push(`- ${matchedComponents} components matched`);
  lines.push(`- ${unmatchedComponents} components missing in code`);
  lines.push("");

  // ── Rules Compliance ──
  if (rules.length > 0) {
    lines.push("### Rules Compliance");
    for (const rule of rules) {
      const { compliant, detail } = checkRuleCompliance(rule.rule, tokenRecords);
      if (compliant) {
        lines.push(`- ✅ "${rule.rule}" — ${detail}`);
      } else {
        lines.push(`- ⚠️ "${rule.rule}" — ${detail}`);
      }
    }
    lines.push("");
  }

  // ── Warnings ──
  if (warnings.length > 0) {
    lines.push("### Warnings");
    for (const w of warnings) {
      lines.push(`- ⚠️ ${w}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Simple keyword-based rule compliance check.
 * Extracts hex colors, font names, and CSS property names from the rule string
 * and checks against the collected match records.
 */
function checkRuleCompliance(
  rule: string,
  tokenRecords: TokenMatchRecord[],
): { compliant: boolean; detail: string } {
  const ruleLower = rule.toLowerCase();

  // Check for hex color references in the rule
  const hexMatch = rule.match(/#[0-9a-fA-F]{6,8}/g);
  if (hexMatch) {
    for (const hex of hexMatch) {
      const violations = tokenRecords.filter(
        (r) => r.property === "color" || r.property === "background"
      ).filter(
        (r) => r.figmaValue.toLowerCase() !== hex.toLowerCase() && r.status === "unmatched"
      );
      if (violations.length > 0) {
        return { compliant: false, detail: `${violations.length} nodes use non-matching colors` };
      }
    }
    return { compliant: true, detail: "all color values comply" };
  }

  // Check for font family references
  const fontFamilies = ["google sans", "inter", "roboto", "sf pro", "helvetica"];
  for (const font of fontFamilies) {
    if (ruleLower.includes(font)) {
      const fontRecords = tokenRecords.filter((r) => r.property === "fontFamily");
      if (fontRecords.length === 0) {
        return { compliant: true, detail: "no font contradictions found" };
      }
    }
  }

  // Default: no contradictions detected (best-effort)
  return { compliant: true, detail: "no contradictions detected" };
}

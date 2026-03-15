/**
 * Tool: generate_coded_components
 * Generates pixel-perfect, production-ready coded components from Figma.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FigmaClient } from "../clients/figma.js";
import type { FigmaDetailedNode } from "../types/figma.js";
import type {
  ComponentIR,
  VariantEntry,
  EmittedComponent,
  ComponentPropIR,
} from "../types/node-ir.js";
import { VariableResolver } from "../utils/variable-resolver.js";
import { parseNodeTree } from "../utils/node-parser.js";
import { diffVariants, extractPropsFromVariants, findDefaultVariant } from "../utils/state-differ.js";
import {
  buildComponentNameMap,
  resolveComponentRefs,
  extractDependencies,
  topologicalSort,
  extractTextProps,
} from "../utils/composition-resolver.js";
import { emitReactCSS } from "../utils/emitter-react-css.js";
import { emitHTMLCSS } from "../utils/emitter-html-css.js";
import { emitReactTailwind } from "../utils/emitter-react-tailwind.js";
import { emitReactNative } from "../utils/emitter-react-native.js";
import { sanitizeClassName } from "../utils/node-parser.js";
import { toPascalCase, generateStorybook, generateStorybookManifest } from "../utils/scaffold-templates.js";
import type { ComponentProp } from "../types/scaffold.js";
import { toUserMessage } from "../utils/errors.js";

const BATCH_SIZE = 50;

const InputSchema = z.object({
  figma_file_key: z.string().min(1)
    .describe("The Figma file key (from the URL: figma.com/design/{THIS_PART}/...)"),
  component_names: z.array(z.string()).optional()
    .describe("Specific component names to generate (default: all)"),
  framework: z.enum(["react-tailwind", "react-css", "react-native", "html-css"])
    .describe("Target framework for code generation"),
  output_dir: z.string().default("src/components")
    .describe("Output directory for generated components (default: 'src/components')"),
  state_prop_names: z.array(z.string()).default(["State", "Status", "Interaction"])
    .describe("Variant prop names that map to CSS pseudo-classes (default: ['State', 'Status', 'Interaction'])"),
  include_storybook: z.boolean().default(false)
    .describe("Generate Storybook story files (default: false)"),
}).strict();

type Input = z.infer<typeof InputSchema>;

export function registerGenerateCodedComponents(
  server: McpServer,
  figmaClient: FigmaClient
): void {
  server.registerTool(
    "generate_coded_components",
    {
      title: "Generate Coded Components",
      description: `Generate production-ready, pixel-perfect coded components from Figma.

Extracts layout, colors, typography, spacing, effects from Figma node trees,
resolves variable bindings to design tokens, diffs variants for state/dimensional
overrides, detects nested components, and emits framework-specific code.

Args:
  - figma_file_key (string): The Figma file key
  - component_names (string[], optional): Specific components (default: all)
  - framework ('react-tailwind' | 'react-css' | 'react-native' | 'html-css'): Target framework
  - output_dir (string): Output directory (default: 'src/components')
  - state_prop_names (string[]): Variant props that become CSS pseudo-classes
  - include_storybook (boolean): Generate Storybook files (default: false)

Returns:
  JSON with generated component files, props, dependencies, and summary.`,
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

        // 1. Fetch components metadata
        // The /files/:key/components endpoint returns an array of components
        // with component set info nested in containing_frame.containingComponentSet
        const componentsResponse = await figmaClient.getComponents(params.figma_file_key);
        const metaComponents = componentsResponse.meta.components;

        // Build component set info from the flat component list
        const componentSets = new Map<string, {
          name: string;
          nodeId: string;
          description: string;
          figmaUrl: string;
          variantNodeIds: VariantEntry[];
        }>();

        // Group components by their containing component set
        for (const comp of metaComponents) {
          const setInfo = comp.containing_frame?.containingComponentSet;

          if (setInfo) {
            // This component is a variant inside a component set
            const setNodeId = setInfo.nodeId;
            if (!componentSets.has(setNodeId)) {
              componentSets.set(setNodeId, {
                name: setInfo.name,
                nodeId: setNodeId,
                description: "",
                figmaUrl: `https://www.figma.com/design/${params.figma_file_key}?node-id=${encodeURIComponent(setNodeId)}`,
                variantNodeIds: [],
              });
            }
            const propValues = parseVariantName(comp.name);
            componentSets.get(setNodeId)!.variantNodeIds.push({
              nodeId: comp.node_id,
              name: comp.name,
              propValues,
            });
          } else {
            // Standalone component (no variants)
            componentSets.set(comp.node_id, {
              name: comp.name,
              nodeId: comp.node_id,
              description: comp.description,
              figmaUrl: `https://www.figma.com/design/${params.figma_file_key}?node-id=${encodeURIComponent(comp.node_id)}`,
              variantNodeIds: [{
                nodeId: comp.node_id,
                name: comp.name,
                propValues: {},
              }],
            });
          }
        }

        // Filter by component_names if specified
        let targetSets = Array.from(componentSets.values());
        if (params.component_names && params.component_names.length > 0) {
          const namesLower = new Set(params.component_names.map((n) => n.toLowerCase()));
          targetSets = targetSets.filter((s) =>
            namesLower.has(s.name.toLowerCase())
          );
          if (targetSets.length === 0) {
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  components: [],
                  summary: { total: 0, framework: params.framework, totalFiles: 0, outputDir: params.output_dir, generationOrder: [], warnings: ["No matching components found"] },
                }, null, 2),
              }],
            };
          }
        }

        // 2. Fetch variables for token resolution (graceful fallback for non-Enterprise plans)
        let resolver: VariableResolver;
        try {
          const varsResponse = await figmaClient.getLocalVariables(params.figma_file_key);
          resolver = new VariableResolver(varsResponse.meta.variables);
        } catch {
          warnings.push(
            "Variables API unavailable (requires Figma Enterprise/Organization plan). " +
            "Components will use hardcoded values instead of design token references."
          );
          resolver = new VariableResolver({});
        }

        // 3. Collect all variant node IDs
        const allNodeIds: string[] = [];
        for (const set of targetSets) {
          for (const variant of set.variantNodeIds) {
            allNodeIds.push(variant.nodeId);
          }
        }

        // 4. Fetch nodes in batches
        const allNodes: Record<string, FigmaDetailedNode> = {};
        for (let i = 0; i < allNodeIds.length; i += BATCH_SIZE) {
          const batch = allNodeIds.slice(i, i + BATCH_SIZE);
          const response = await figmaClient.getNodes(params.figma_file_key, batch);
          for (const [nodeId, nodeData] of Object.entries(response.nodes)) {
            if (nodeData) {
              allNodes[nodeId] = nodeData.document;
            }
          }
        }

        // 5. Build component name map for composition resolution
        const nameMap = buildComponentNameMap(
          targetSets.map((s) => ({ nodeId: s.nodeId, name: s.name }))
        );
        const knownComponentIds = new Set(targetSets.map((s) => s.nodeId));

        // 6. Process each component into IR
        const componentIRs: ComponentIR[] = [];

        for (const set of targetSets) {
          try {
            const componentName = toPascalCase(set.name);
            const rootClassName = sanitizeClassName(set.name);

            // Extract props from variants
            const variantProps = extractPropsFromVariants(
              set.variantNodeIds,
              params.state_prop_names
            );

            // Parse default variant tree (use same logic as state-differ)
            const defaultVariant = findDefaultVariant(set.variantNodeIds, params.state_prop_names) ?? set.variantNodeIds[0];
            const defaultNode = allNodes[defaultVariant.nodeId];
            if (!defaultNode) {
              warnings.push(`Component "${set.name}": node not found, skipping`);
              continue;
            }

            const defaultTree = parseNodeTree(defaultNode, resolver, knownComponentIds);

            // Resolve component refs
            resolveComponentRefs(defaultTree, nameMap);

            // Extract text props
            const textProps = extractTextProps(defaultTree, componentName);
            const textPropIRs: ComponentPropIR[] = textProps.map((tp) => ({
              name: tp.name,
              type: "string" as const,
              defaultValue: tp.defaultValue,
              source: "text-content" as const,
            }));

            // Diff variants
            const { stateOverrides, dimensionalVariants } = diffVariants(
              set.variantNodeIds,
              allNodes,
              resolver,
              params.state_prop_names,
              rootClassName
            );

            // Extract dependencies
            const dependencies = extractDependencies(defaultTree);

            const ir: ComponentIR = {
              name: componentName,
              figmaName: set.name,
              nodeId: set.nodeId,
              figmaUrl: set.figmaUrl,
              description: set.description,
              defaultTree,
              stateOverrides,
              dimensionalVariants,
              props: [...variantProps, ...textPropIRs],
              dependencies,
              warnings: defaultTree.warnings ?? [],
            };

            componentIRs.push(ir);
          } catch (error) {
            warnings.push(`Component "${set.name}": ${toUserMessage(error)}`);
          }
        }

        // 7. Topological sort
        const { sorted: generationOrder, warnings: sortWarnings } = topologicalSort(
          componentIRs.map((ir) => ({ name: ir.name, dependencies: ir.dependencies }))
        );
        warnings.push(...sortWarnings);

        // Sort IRs by generation order
        const sortedIRs = generationOrder
          .map((name) => componentIRs.find((ir) => ir.name === name))
          .filter((ir): ir is ComponentIR => ir !== undefined);

        // 8. Emit code per framework
        const emitter = getEmitter(params.framework);
        const emittedComponents: EmittedComponent[] = sortedIRs.map((ir) => {
          const emitted = emitter(ir, params.output_dir);

          // Generate Storybook story if requested
          if (params.include_storybook && params.framework !== "html-css") {
            const storyProps: ComponentProp[] = ir.props.map((p) => ({
              name: p.name,
              type: p.type,
              values: p.values,
              defaultValue: p.defaultValue,
            }));
            const storyContent = generateStorybook(ir.name, storyProps);
            emitted.files.push({
              path: `${params.output_dir}/${ir.name}/${ir.name}.stories.tsx`,
              content: storyContent,
              description: `Storybook story with controls for ${ir.name}`,
            });
          }

          return emitted;
        });

        // 9. Generate Storybook manifest for audit_system_health interop
        if (params.include_storybook && emittedComponents.length > 0) {
          const manifestContent = generateStorybookManifest(
            emittedComponents.map((c) => ({ name: c.componentName, outputDir: params.output_dir }))
          );
          // Attach as a top-level file (not per-component)
          emittedComponents[0].files.push({
            path: `${params.output_dir}/stories.json`,
            content: manifestContent,
            description: "Storybook manifest for design system health audits",
          });
        }

        // 10. Return output
        const output = {
          components: emittedComponents,
          summary: {
            total: emittedComponents.length,
            framework: params.framework,
            totalFiles: emittedComponents.reduce((sum, c) => sum + c.files.length, 0),
            outputDir: params.output_dir,
            generationOrder,
            warnings,
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

/**
 * Parse a Figma variant name string like "Size=Large, State=Hover"
 * into key-value pairs: { Size: "Large", State: "Hover" }
 */
function parseVariantName(name: string): Record<string, string> {
  const result: Record<string, string> = {};
  const parts = name.split(",").map((s) => s.trim());
  for (const part of parts) {
    const [key, value] = part.split("=").map((s) => s.trim());
    if (key && value) {
      result[key] = value;
    }
  }
  return result;
}

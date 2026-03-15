/**
 * Tool 8: generate_component_scaffold — Generate React + Storybook starter code
 * from Figma component data including variant props.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FigmaClient } from "../clients/figma.js";
import { toUserMessage } from "../utils/errors.js";
import {
  extractFigmaComponents,
  extractFigmaComponentsFromFile,
} from "../utils/component-parsers.js";
import { parseVariants, groupByComponentSet } from "../utils/variant-parser.js";
import {
  generateReactComponent,
  generateStorybook,
  generateIndexBarrel,
  toPascalCase,
} from "../utils/scaffold-templates.js";
import type { ScaffoldedComponent } from "../types/scaffold.js";

const InputSchema = z.object({
  figma_file_key: z.string()
    .min(1)
    .describe("The Figma file key (from the URL: figma.com/design/{THIS_PART}/...)"),
  component_names: z.array(z.string())
    .optional()
    .describe("Specific component names to scaffold. Omit to scaffold all."),
  include_storybook: z.boolean()
    .default(true)
    .describe("Generate Storybook stories alongside components (default: true)"),
  output_dir: z.string()
    .default("src/components")
    .describe("Target output directory for generated files (default: 'src/components')"),
  token_prefix: z.string()
    .optional()
    .describe("CSS variable prefix for token references (e.g. 'ds' → --ds-button-bg)"),
}).strict();

type Input = z.infer<typeof InputSchema>;

export function registerGenerateComponentScaffold(
  server: McpServer,
  figmaClient: FigmaClient
): void {
  server.registerTool(
    "generate_component_scaffold",
    {
      title: "Generate Component Scaffold",
      description: `Generate React + Storybook starter code from Figma component data.

Fetches components from a Figma file, parses variant properties (Size=Large, State=Hover),
and generates TypeScript React components with props interfaces and optional Storybook stories.
Returns generated file contents as JSON — does NOT write to disk.

Args:
  - figma_file_key (string): The Figma file key from the URL
  - component_names (string[], optional): Specific components to scaffold
  - include_storybook (boolean): Generate Storybook stories (default: true)
  - output_dir (string): Target directory path (default: 'src/components')
  - token_prefix (string, optional): CSS variable prefix for token references

Returns:
  JSON with scaffolded component code, props, and file contents ready for writing.

Examples:
  - "Scaffold all components from Figma" → generate_component_scaffold with just figma_file_key
  - "Generate Button and Card components" → generate_component_scaffold with component_names: ["Button", "Card"]
  - "Scaffold without stories" → generate_component_scaffold with include_storybook: false`,
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
        // 1. Fetch components (with fallback to file tree)
        let allComponents;
        try {
          const response = await figmaClient.getComponents(params.figma_file_key);
          allComponents = extractFigmaComponents(response, params.figma_file_key);

          // Enhance allComponents with variant data from the array response
          // Components inside a containingComponentSet are variants
          const variantSetNames = new Set<string>();
          for (const comp of response.meta.components) {
            const setInfo = comp.containing_frame?.containingComponentSet;
            if (setInfo) {
              variantSetNames.add(setInfo.name);
            }
          }
          for (const comp of allComponents) {
            if (variantSetNames.has(comp.name)) {
              comp.setName = comp.name;
            }
          }
        } catch {
          const fileResponse = await figmaClient.getFile(params.figma_file_key);
          allComponents = extractFigmaComponentsFromFile(fileResponse, params.figma_file_key);
        }

        // 2. Filter by component names if provided
        let targetComponents = allComponents;
        if (params.component_names && params.component_names.length > 0) {
          const nameSet = new Set(params.component_names.map((n) => n.toLowerCase()));
          targetComponents = allComponents.filter((c) =>
            nameSet.has(c.name.toLowerCase())
          );
        }

        if (targetComponents.length === 0) {
          const output = {
            components: [],
            summary: {
              total: 0,
              message: params.component_names
                ? `No components found matching: ${params.component_names.join(", ")}`
                : "No components found in the Figma file",
            },
          };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
          };
        }

        // 3. Group by component set and parse variants
        const groups = groupByComponentSet(targetComponents);
        const scaffolded: ScaffoldedComponent[] = [];

        // Also get variant components for parsing
        let variantsBySet: Map<string, Array<{ key: string; name: string; description: string }>>;
        try {
          const response = await figmaClient.getComponents(params.figma_file_key);
          variantsBySet = new Map();
          for (const comp of response.meta.components) {
            const setInfo = comp.containing_frame?.containingComponentSet;
            if (setInfo) {
              if (!variantsBySet.has(setInfo.name)) {
                variantsBySet.set(setInfo.name, []);
              }
              variantsBySet.get(setInfo.name)!.push({
                key: comp.key,
                name: comp.name,
                description: comp.description,
              });
            }
          }
        } catch {
          variantsBySet = new Map();
        }

        for (const [setName, members] of groups) {
          const pascalName = toPascalCase(setName);

          // Find variants for this component set
          const variants = variantsBySet.get(setName) ?? [];

          // Parse variant props
          const variantEntries = variants.length > 0
            ? variants.map((v) => ({
                name: v.name,
                key: v.key,
                description: v.description,
              }))
            : members;

          const props = parseVariants(variantEntries);

          // 4. Generate files
          const files: ScaffoldedComponent["files"] = [];
          const componentDir = `${params.output_dir}/${pascalName}`;

          // React component
          const componentCode = generateReactComponent(
            setName,
            props,
            params.token_prefix
          );
          files.push({
            path: `${componentDir}/${pascalName}.tsx`,
            content: componentCode,
            description: `React component with ${props.length} props`,
          });

          // Storybook story
          if (params.include_storybook) {
            const storyCode = generateStorybook(setName, props);
            files.push({
              path: `${componentDir}/${pascalName}.stories.tsx`,
              content: storyCode,
              description: `Storybook story with controls for ${props.length} props`,
            });
          }

          scaffolded.push({
            componentName: pascalName,
            figmaName: setName,
            files,
            props,
            variants: variants.length || members.length,
          });
        }

        // 5. Generate barrel export if multiple components
        if (scaffolded.length > 1) {
          const barrelCode = generateIndexBarrel(
            scaffolded.map((s) => s.figmaName)
          );
          scaffolded.push({
            componentName: "index",
            figmaName: "barrel-export",
            files: [{
              path: `${params.output_dir}/index.ts`,
              content: barrelCode,
              description: `Barrel export for ${scaffolded.length} components`,
            }],
            props: [],
            variants: 0,
          });
        }

        const output = {
          components: scaffolded,
          summary: {
            total: scaffolded.filter((s) => s.componentName !== "index").length,
            totalFiles: scaffolded.reduce((sum, s) => sum + s.files.length, 0),
            outputDir: params.output_dir,
            includesStorybook: params.include_storybook,
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

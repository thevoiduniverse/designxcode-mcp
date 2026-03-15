/**
 * MCP Prompt: use-design-system
 * A prompt template that instructs the AI to load and follow
 * the project's design system before generating UI code.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerUseDesignSystemPrompt(server: McpServer): void {
  server.registerPrompt(
    "use-design-system",
    {
      title: "Use Design System",
      description: "Load your Figma design system context for AI-assisted code generation. Ensures generated code uses correct tokens, components, and patterns.",
      argsSchema: {
        figma_file_key: z.string().describe("The Figma file key (from the URL: figma.com/design/{THIS_PART}/...)"),
      },
    },
    async (args) => {
      return {
        messages: [{
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `You are working on a project with an established design system.
Before generating any UI code, call the get_design_context tool with figma_file_key "${args.figma_file_key}" to load the design system tokens, components, and patterns. Follow the returned context strictly:
- Use token CSS variables instead of hardcoded values
- Reuse existing components instead of creating new ones
- Follow the documented patterns and rules
- When in doubt, prefer the design system's conventions over generic defaults
- NEVER invent, hardcode, or manually adjust design values (colors, spacing, backgrounds, typography, shadows, hover states, surface colors). Every visual value must come from the Figma file via the design system tools. If a value looks wrong, it is either a Figma issue or an extraction bug — do not "fix" it by making up a value.
- When using external UX research (Refero, design references, competitor analysis) for layout and interaction patterns: research informs STRUCTURE and LAYOUT only. ALL visual values (colors, fonts, spacing) MUST come from THIS design system. If a reference uses blue but the design system uses pink, USE PINK.
- If you need a value that doesn't exist in the design system, ASK the user — do not invent it.`,
          },
        }],
      };
    }
  );
}

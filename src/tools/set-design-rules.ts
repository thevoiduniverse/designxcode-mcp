/**
 * Tool: set_design_rules — Persist user-defined design rules to a local JSON file.
 * Rules are stored at {cwd}/.designxcode/rules-{fileKey}.json.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DesignSystemCache } from "../cache/design-system-cache.js";
import type { DesignRule } from "../utils/context-formatter.js";
import { toUserMessage } from "../utils/errors.js";
import * as fs from "node:fs";
import * as path from "node:path";

interface RulesFileContent {
  fileKey: string;
  rules: Array<{ rule: string; category?: string }>;
  updatedAt: string;
}

/** Get the path to the rules file for a given fileKey */
function rulesFilePath(fileKey: string): string {
  return path.join(process.cwd(), ".designxcode", `rules-${fileKey}.json`);
}

/** Read rules from the local JSON file (returns empty array if file doesn't exist) */
export function readRulesFile(fileKey: string): DesignRule[] {
  const filePath = rulesFilePath(fileKey);
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(content) as RulesFileContent;
    return parsed.rules.map((r) => ({ rule: r.rule, category: r.category }));
  } catch {
    return [];
  }
}

const InputSchema = z.object({
  figma_file_key: z.string()
    .min(1)
    .describe("The Figma file key"),
  rules: z.array(z.object({
    rule: z.string().describe("The design rule text"),
    category: z.enum(["spacing", "color", "typography", "composition", "general"])
      .optional()
      .describe("Optional category for the rule"),
  }))
    .min(1)
    .describe("Design rules to add or set"),
  mode: z.enum(["replace", "append"])
    .default("append")
    .describe("'replace' overwrites all rules, 'append' adds to existing (default: 'append')"),
}).strict();

type Input = z.infer<typeof InputSchema>;

export function registerSetDesignRules(
  server: McpServer,
  cache: DesignSystemCache
): void {
  server.registerTool(
    "set_design_rules",
    {
      title: "Set Design Rules",
      description: `Define explicit design rules that the AI should follow when generating code.

Rules supplement auto-inferred patterns and take precedence over them.
Stored locally and persist across sessions.

Args:
  - figma_file_key (string): The Figma file key to associate rules with
  - rules (array): Design rules with optional category
  - mode ('replace' | 'append'): Whether to replace all rules or append (default: 'append')

Returns:
  Confirmation with total rule count.

Examples:
  - "Always use 8px grid" -> set_design_rules with rules: [{ rule: "Always use 8px grid", category: "spacing" }]
  - "Reset all rules" -> set_design_rules with mode: "replace", rules: [{ rule: "New rule" }]`,
      inputSchema: InputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: Input) => {
      try {
        const filePath = rulesFilePath(params.figma_file_key);
        const dir = path.dirname(filePath);

        // Ensure directory exists
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

        let existingRules: Array<{ rule: string; category?: string }> = [];

        if (params.mode === "append") {
          // Read existing rules
          try {
            const content = fs.readFileSync(filePath, "utf-8");
            const parsed = JSON.parse(content) as RulesFileContent;
            existingRules = parsed.rules;
          } catch {
            // File doesn't exist, start fresh
          }

          // Deduplicate by exact string match
          const existingTexts = new Set(existingRules.map((r) => r.rule));
          for (const newRule of params.rules) {
            if (!existingTexts.has(newRule.rule)) {
              existingRules.push(newRule);
            }
          }
        } else {
          existingRules = params.rules;
        }

        // Write rules file
        const fileContent: RulesFileContent = {
          fileKey: params.figma_file_key,
          rules: existingRules,
          updatedAt: new Date().toISOString(),
        };

        fs.writeFileSync(filePath, JSON.stringify(fileContent, null, 2), "utf-8");

        // Invalidate cache
        cache.invalidate(params.figma_file_key, "rules");

        const output = {
          success: true,
          totalRules: existingRules.length,
          mode: params.mode,
          filePath,
          message: `${existingRules.length} design rule(s) saved.`,
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

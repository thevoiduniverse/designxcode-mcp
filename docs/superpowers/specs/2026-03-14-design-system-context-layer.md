# Design System Context Layer — Spec

## Problem

When developers vibecode with AI tools (Claude Code, Cursor), the generated UI code uses generic defaults — Tailwind's blue, system fonts, arbitrary spacing. The AI has no knowledge of the project's design system. Even with Figma MCP, the AI receives raw hex colors and pixel values, not token references or existing component names. This produces code that looks approximately right but is not production-ready: hardcoded values everywhere, components rebuilt from scratch instead of reusing existing ones, and no adherence to spacing/composition patterns.

## Solution

Add a **design system context layer** to the designxcode-mcp server. This layer extracts tokens, components, and usage patterns from a Figma file, caches them, and exposes them as MCP resources, a smart tool, and a prompt template. When the AI reads this context before generating code, it uses the correct tokens, reuses existing components, and follows established patterns.

## Target User

**Primary:** Solo vibecoder / indie hacker with a Figma file (own design or template) who wants AI-generated code to respect their brand.
**Secondary (future):** Design system teams wanting consistent AI output across developers.

## Architecture

### Three Layers

**1. Resources (data layer)** — Four MCP resources scoped to a Figma file key, backed by an in-memory cache:

| Resource URI | Content | Cache TTL |
|---|---|---|
| `designsystem://tokens/{fileKey}` | Design tokens as CSS variable mappings | 5 min |
| `designsystem://components/{fileKey}` | Component inventory with props, variants, usage hints | 5 min |
| `designsystem://patterns/{fileKey}` | Auto-inferred usage patterns from Figma layouts | 10 min |
| `designsystem://rules/{fileKey}` | User-defined design rules and overrides | No TTL (local file) |

**2. Tools (action layer)** — Two new tools:

| Tool | Purpose |
|---|---|
| `get_design_context` | Reads cached resources, optionally filters by task relevance, returns compressed context document |
| `set_design_rules` | Stores user-authored design rules to local JSON file |

**3. Prompt (trigger layer)** — One MCP prompt:

| Prompt | Purpose |
|---|---|
| `use-design-system` | Instructs the AI to call `get_design_context` and follow the design system for all code generation |

### Trigger Modes

- **On-demand:** User invokes the `use-design-system` prompt or explicitly asks the AI to "use my design system."
- **Smart detection (future):** AI calls `get_design_context` automatically when it detects a UI/frontend task.

### Data Flow

```
Developer: "Build me a settings page"
    │
    ▼
AI detects UI task → Calls get_design_context(fileKey, task: "settings page")
    │
    ▼
get_design_context reads from cache (or Figma API on miss):
    ├── tokens resource   → CSS variable mappings
    ├── components resource → component inventory
    ├── patterns resource  → inferred layout patterns
    └── rules resource     → user-defined rules
    │
    ▼
Compresses context for task relevance → Returns markdown document
    │
    ▼
AI generates code using:
    - var(--color-primary) instead of #6366F1
    - <Button variant="primary"> instead of <button className="bg-indigo-500...">
    - 24px card padding (--spacing-6) matching the pattern
```

---

## Resource Specifications

### `designsystem://tokens/{fileKey}`

**Source:** Reuses `figmaVariablesToW3C()` + `mergeTokenSets()` from `w3c-tokens.ts`, and `extract_styles` for non-variable styles.

**Output format:** Markdown with tokens grouped by category, formatted as CSS custom property declarations.

```markdown
## Design Tokens

### Colors
--color-primary: #6366F1
--color-primary-hover: #4F46E5
--color-surface: #FFFFFF
--color-text: #111827
--color-text-muted: #6B7280

### Spacing
--spacing-1: 4px
--spacing-2: 8px
--spacing-4: 16px

### Typography
--font-family-body: "Inter"
--font-size-sm: 14px
--font-size-base: 16px

### Shadows
--shadow-sm: 0 1px 2px rgba(0,0,0,0.05)
```

**Token name derivation:** The pipeline is: Figma variable name `"colors/primary/500"` → `sanitizeTokenName()` converts `/` to `.` and lowercases → W3C nested structure → a new `flattenW3CTokens()` utility joins path segments with `-` and prepends `--` → `--colors-primary-500`. This is similar to `flattenSD()` in `style-dictionary.ts` but operates on the W3C format directly. The new `flattenW3CTokens()` function will be implemented in `context-formatter.ts`.

### `designsystem://components/{fileKey}`

**Source:** Reuses `extractFigmaComponents()` + `extractFigmaComponentsFromFile()` from `component-parsers.ts`, and `parseVariants()` from `variant-parser.ts`.

**Variant extraction pipeline:** `extractFigmaComponents()` deliberately skips variant children (components with `componentSetId`). To get variant prop data for `parseVariants()`, the components resource must:
1. Call `figmaClient.getComponents(fileKey)` to get the raw response
2. For each component set, collect its variant children from `response.meta.components` where `componentSetId` matches the set
3. Pass these variant children (whose names contain `"Size=Large, State=Hover"` syntax) to `parseVariants()`
4. Use `extractFigmaComponents()` only for the top-level component list (sets + standalone components)

This is the same approach used in `generate-component-scaffold.ts` (lines 147-154), which already solves this problem.

**Output format:** Markdown with one entry per component.

```markdown
## Available Components

### Button
Props: variant (primary | secondary | ghost), size (sm | md | lg), disabled (boolean)
Variants: 6
Usage: <Button variant="primary" size="md">Label</Button>

### Card
Props: elevation (flat | raised | floating)
Variants: 3
Usage: <Card elevation="raised">content</Card>
```

**Usage line synthesis:** Generated from prop names and default values. Format: `<PascalName propName="defaultValue">` with children if no content prop exists.

### `designsystem://patterns/{fileKey}`

**Source:** New pattern inference engine (see Pattern Inference section).

**Output format:** Markdown grouped by pattern category.

```markdown
## Usage Patterns

### Spacing
- Cards use 24px internal padding (--spacing-6)
- Section gaps are 32px (--spacing-8)
- Form fields spaced 16px apart (--spacing-4)

### Composition
- Cards always have --shadow-sm and --radius-lg
- Buttons in card footers are right-aligned

### Color Pairing
- Primary actions use --color-primary on --color-surface
- Muted text always uses --color-text-muted, never raw gray
```

### `designsystem://rules/{fileKey}`

**Source:** Local file at `{process.cwd()}/.designxcode/rules-{fileKey}.json`. The `.designxcode/` directory is created automatically on first `set_design_rules` call. The server's working directory is the process cwd (typically the project root when launched via Claude Code MCP config).

**Output format:** Markdown bulleted list.

```markdown
## Design Rules
- Always use 8px grid for spacing
- Primary buttons only for main CTAs, one per screen
- Never use raw hex colors — always reference token variables
```

**Storage format (JSON):**
```json
{
  "fileKey": "abc123",
  "rules": [
    { "rule": "Always use 8px grid for spacing", "category": "spacing" },
    { "rule": "Primary buttons only for main CTAs, one per screen", "category": "composition" }
  ],
  "updatedAt": "2026-03-14T10:00:00Z"
}
```

---

## Pattern Inference Engine

### Pipeline

1. **Sample frames** — Fetch page/frame structure via `getFile(fileKey, 2)` (depth=2 returns pages and their direct children, avoiding downloading the full tree). Select up to 15 representative frames from across pages.

2. **Fetch detailed nodes** — Call `getNodes(fileKey, frameIds)` to get full properties (fills, effects, spacing, typography) for sampled frames. This means a cache-miss scenario requires **up to 5 API calls**: `getLocalVariables` + `getFileStyles` + `getComponents` + `getFile(depth=2)` + `getNodes`. Rate limiting is handled by the existing exponential backoff in `FigmaClient.request()`.

3. **Collect observations** — Walk each frame's node tree and record:
   - **Spacing:** `padding`, `itemSpacing`, `counterAxisSpacing` values per node type
   - **Color usage:** Fill colors mapped to node types (text, background, icon)
   - **Typography:** Font family + size + weight combinations on text nodes
   - **Component composition:** Which components appear inside which containers, with what spacing
   - **Effects:** Shadow/blur usage per component type

4. **Aggregate** — Group observations by value. Apply frequency threshold: a pattern must appear **3+ times across 2+ distinct frames** to qualify.

5. **Map to tokens** — Match observed raw values to the closest extracted token:
   - Colors: exact hex match
   - Spacing: exact px match (Figma Variables are precise)
   - Typography: match font family + size combination

6. **Generate pattern descriptions** — Convert aggregated observations into human-readable pattern statements. Format: `"{component/context} uses {token-name} ({raw-value}) for {property}"`.

7. **Merge with user rules** — User-defined rules from `set_design_rules` override conflicting inferred patterns.

### Figma Node Properties Used

From `FigmaDetailedNode` (already defined in types):
- `fills` — background and text colors
- `effects` — shadows, blurs
- `style` (FigmaTypeStyle) — typography
- `layoutGrids` — grid patterns

Additionally, auto-layout properties to be added to `FigmaDetailedNode` (all optional — only present on auto-layout frames):
- `layoutMode?` — `"HORIZONTAL" | "VERTICAL" | "NONE"`
- `paddingLeft?`, `paddingRight?`, `paddingTop?`, `paddingBottom?` — `number`
- `itemSpacing?` — `number` (gap between auto-layout children)
- `counterAxisSpacing?` — `number` (cross-axis gap for wrapping layouts; added in Figma API v1, May 2023 — may be absent on older files, treat as optional)
- `primaryAxisAlignItems?` — `"MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN"` (main axis alignment)
- `counterAxisAlignItems?` — `"MIN" | "CENTER" | "MAX" | "BASELINE"` (cross axis alignment)

### Small File Fallback

If fewer than 2 frames are available, or no patterns meet the frequency threshold (3+ across 2+ frames), the engine lowers the threshold to 2+ occurrences in 1+ frame. If still no patterns are found, the patterns resource returns an empty section with a note: `"No recurring patterns detected — design may be too small or inconsistent to infer patterns. Consider adding explicit rules via set_design_rules."`

### Limitations

- Samples at most 15 frames — large files with 50+ pages won't be fully analyzed
- Does not infer layout systems (flexbox vs grid) — too ambiguous
- Does not detect animation/transition patterns
- Pattern quality depends on design consistency — messy Figma files produce noisy patterns

---

## Tool Specifications

### `get_design_context`

**Input schema (Zod):**
```typescript
z.object({
  figma_file_key: z.string().min(1)
    .describe("The Figma file key"),
  task_description: z.string().optional()
    .describe("Optional task context for relevance filtering, e.g. 'build a login form'"),
  sections: z.array(z.enum(["tokens", "components", "patterns", "rules"]))
    .optional()
    .describe("Specific sections to include. Omit to include all sections."),
  refresh: z.boolean().default(false)
    .describe("Force cache invalidation and re-fetch from Figma API"),
}).strict()
```

When `sections` is omitted (the default), all four sections are included.

**Behavior:**

1. Check cache for each requested section. On miss (or `refresh: true`), fetch from Figma API and populate cache.
2. If `task_description` provided, apply relevance filtering:
   - Extract keywords from description
   - Filter components by name/description keyword match
   - Filter tokens by category relevance (e.g., "form" → prioritize spacing, color, typography; skip motion/breakpoints)
   - Include all patterns and rules (these are always relevant)
3. If total context exceeds ~4000 LLM tokens (estimated as `chars / 4`; configurable via `MAX_CONTEXT_TOKENS` constant), progressively compress:
   - Drop individual variant details (keep prop names only)
   - Drop pattern examples (keep rule statement only)
   - Drop less-used token categories
4. Return markdown document with instruction header.

**Output:** Single markdown document:

```markdown
# Design System Context
Use these tokens, components, and patterns when generating code.
DO NOT use hardcoded colors, font sizes, or spacing values.
DO NOT create new components when an existing one matches.

## Tokens
[token list]

## Available Components
[component inventory]

## Patterns
[usage patterns]

## Rules
[user-defined rules]
```

**Annotations:** `readOnlyHint: true, idempotentHint: true`

### `set_design_rules`

**Input schema:**
```
figma_file_key: string (required)
rules: Array<{ rule: string, category?: "spacing"|"color"|"typography"|"composition"|"general" }>
mode: "replace" | "append" (default: "append")
```

**Behavior:**

1. Read existing rules from `.designxcode/rules-{fileKey}.json` (create if absent)
2. If `mode === "replace"`, overwrite all rules
3. If `mode === "append"`, add new rules (deduplicate by exact string match)
4. Write updated rules to file
5. Invalidate rules cache for this fileKey
6. Return confirmation with rule count

**Annotations:** `readOnlyHint: false, idempotentHint: true`

---

## Prompt Specification

### `use-design-system`

**Registration:**
```typescript
server.registerPrompt("use-design-system", {
  title: "Use Design System",
  description: "Load your Figma design system context for AI-assisted code generation",
  argsSchema: {
    figma_file_key: z.string().describe("Figma file key")
  }
}, async (args) => {
  return {
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `You are working on a project with an established design system.
Before generating any UI code, call the get_design_context tool with figma_file_key "${args.figma_file_key}" to load the design system tokens, components, and patterns. Follow the returned context strictly:
- Use token CSS variables instead of hardcoded values
- Reuse existing components instead of creating new ones
- Follow the documented patterns and rules
- When in doubt, prefer the design system's conventions over generic defaults`
      }
    }]
  };
});
```

---

## Cache Design

### Structure

```typescript
interface DesignSystemCache {
  entries: Map<string, CacheEntry>;  // keyed by "{fileKey}:{section}"
}

interface CacheEntry {
  data: string;       // pre-formatted markdown
  fetchedAt: number;  // Date.now()
  ttlMs: number;      // TTL in milliseconds
}
```

### TTLs

| Section | TTL | Rationale |
|---|---|---|
| tokens | 5 min | Variables change during active design work |
| components | 5 min | New components added frequently |
| patterns | 10 min | Patterns are derived, change less often |
| rules | No expiry | Local file, invalidated on write |

### Invalidation

- **TTL expiry:** Checked on read. If expired, re-fetch from Figma API.
- **Manual refresh:** `get_design_context` with `refresh: true` clears all cached sections for that fileKey.
- **Write invalidation:** `set_design_rules` clears the rules cache entry.

### Cache Persistence

The cache is **in-memory only** and is lost on server restart. MCP servers in Claude Code are typically short-lived (spawned per session), so the first `get_design_context` call in each session incurs a cold-cache penalty (5+ API calls). This is an acceptable trade-off for v1 — file-based caching can be added later if needed.

---

## Error Handling

The context layer degrades gracefully when parts of the Figma file are incomplete:

| Scenario | Behavior |
|---|---|
| File has no variables (only styles) | Tokens resource returns styles only (colors, typography from `extract_styles` logic). No error. |
| File has no components | Components section is empty with note: "No components found." Context still includes tokens/patterns/rules. |
| File has no styles AND no variables | Tokens section is empty with note. Patterns section likely empty too. Rules still returned. |
| API call fails partway (e.g., tokens succeed, components 429) | Return partial results with a warning at the top: "⚠ Component data unavailable (rate limited). Partial context below." |
| `getFile` times out on very large file | Pattern inference is skipped. Return tokens + components + rules without patterns. Warning added. |
| Rules file doesn't exist | Rules section is empty (not an error — rules are optional). |

All errors follow the existing `McpToolError` + `toUserMessage()` pattern. Partial results are preferred over full failure.

---

## New Files

| File | Purpose |
|---|---|
| `src/cache/design-system-cache.ts` | In-memory cache with TTL management |
| `src/utils/pattern-inference.ts` | Pattern inference engine — frame sampling, observation collection, aggregation |
| `src/utils/context-formatter.ts` | Formats tokens/components/patterns/rules into LLM-optimized markdown |
| `src/utils/context-compressor.ts` | Task-relevant filtering and size-capped compression |
| `src/resources/design-system-resources.ts` | Registers 4 MCP resources using ResourceTemplate |
| `src/tools/get-design-context.ts` | Main context tool — reads resources, compresses, returns |
| `src/tools/set-design-rules.ts` | Rule management tool — reads/writes local JSON |
| `src/prompts/use-design-system.ts` | Prompt template registration |

## Modified Files

| File | Changes |
|---|---|
| `src/types/figma.ts` | Add auto-layout properties to `FigmaDetailedNode` (`layoutMode`, `paddingLeft/Right/Top/Bottom`, `itemSpacing`, `counterAxisSpacing`) |
| `src/index.ts` | Register resources, new tools, and prompt |

## Reuse Map

| Existing Code | Reused By |
|---|---|
| `figmaVariablesToW3C()` + `mergeTokenSets()` (w3c-tokens.ts) | tokens resource |
| `extractFigmaComponents()` + `extractFigmaComponentsFromFile()` (component-parsers.ts) | components resource |
| `parseVariants()` (variant-parser.ts) | components resource |
| `parseNodeFills()`, `parseNodeTextStyle()`, etc. (style-parsers.ts) | tokens resource — extracts non-variable style values. These are shared utility functions, no refactoring of `extract-styles.ts` needed. |
| `figmaClient.getNodes()` (figma.ts) | pattern inference |
| `figmaClient.getFile()` (figma.ts) | pattern inference — frame sampling |
| `McpToolError` + `toUserMessage()` (errors.ts) | both new tools |

---

## Verification

1. **Build:** `npm run build` — zero errors
2. **MCP Inspector:** `npm run inspect` — verify resources, tools, and prompt appear
3. **Tokens resource:** Read `designsystem://tokens/fSXBK7qFUUyCtZVbO6qAoI` — should return formatted token list
4. **Components resource:** Read `designsystem://components/fSXBK7qFUUyCtZVbO6qAoI` — should return component inventory
5. **get_design_context:** Call with `figma_file_key` — should return full context document
6. **get_design_context with task:** Call with `task_description: "login form"` — should return filtered context
7. **set_design_rules:** Add rules, verify they appear in rules resource
8. **Cache test:** Call get_design_context twice — second call should be near-instant
9. **use-design-system prompt:** Invoke prompt, verify it returns instruction text

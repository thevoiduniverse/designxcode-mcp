# DesignxCode — Complete Walkthrough

A step-by-step guide for anyone to understand, set up, and use DesignxCode. Written in plain English.

---

## What is DesignxCode?

DesignxCode is a tool that connects your **Figma designs** to your **code**. It reads your design system from Figma (colors, fonts, shadows, components) and turns it into actual working code — automatically.

Think of it like this:
- You design a Button in Figma with specific colors, sizes, and states
- DesignxCode reads that Button, understands all its variants, and writes the React code for you
- If someone changes the design in Figma, DesignxCode detects the drift and can re-sync

**The problem it solves:** Designers design in Figma. Developers code in VS Code. These two worlds drift apart over time. Colors change, fonts get updated, new components get added — but the code doesn't know. DesignxCode bridges this gap.

---

## How It Works (Big Picture)

```
Figma (your designs)
    ↓
DesignxCode MCP Server (the engine)
    ↓
Your Code (React components, CSS tokens, theme configs)
```

The MCP server is the brain. It has 12 tools that each do one job:

| Tool | What it does | When you'd use it |
|------|-------------|-------------------|
| `get_design_context` | Loads your full design system | Before writing any UI code |
| `extract_tokens` | Pulls all design tokens (colors, fonts, shadows) | When you need token values |
| `extract_styles` | Gets typography and effect styles | When checking font scales |
| `generate_coded_components` | Writes full React components from Figma | When you need a new component |
| `generate_theme_config` | Creates light/dark theme CSS | When setting up themes |
| `sync_tokens_to_code` | Generates CSS/SCSS/Tailwind/Swift/Kotlin files | When syncing tokens to code |
| `audit_component_parity` | Compares Figma vs code components | When checking coverage |
| `audit_system_health` | Gives a health score for your design system | Weekly health checks |
| `detect_unused_tokens` | Finds tokens not used in your codebase | When cleaning up |
| `export_assets` | Exports SVG/PNG from Figma components | When you need icons/images |
| `generate_sync_pr` | Creates a GitHub PR with updates | When pushing changes |
| `set_design_rules` | Saves custom rules for your system | When adding constraints |

---

## Setup (Step by Step)

### Step 1: Get your Figma token

1. Go to [figma.com](https://figma.com) → click your profile → **Settings**
2. Scroll to **Personal access tokens**
3. Click **Generate new token** → give it a name like "designxcode"
4. Copy the token (starts with `figd_`)

### Step 2: Get the DesignxCode MCP server

```bash
# Clone the repo
git clone https://github.com/thevoiduniverse/designxcode-workspace.git

# Go into the MCP server folder
cd designxcode-workspace/designxcode-mcp

# Install dependencies
npm install

# Build it
npm run build
```

### Step 3: Add your Figma token

Create a file called `.env` in the `designxcode-mcp` folder:

```
FIGMA_ACCESS_TOKEN=figd_your_token_here
```

Optional — if you want GitHub features (sync PRs, unused token detection):
```
FIGMA_ACCESS_TOKEN=figd_your_token_here
GITHUB_TOKEN=ghp_your_github_token_here
```

### Step 4: Connect to Claude Code

Add this to your Claude Code MCP config (`~/.claude.json` or project settings):

```json
{
  "mcpServers": {
    "designxcode-mcp": {
      "command": "node",
      "args": ["/path/to/designxcode-mcp/dist/index.js"]
    }
  }
}
```

Replace `/path/to/` with the actual path to where you cloned the repo.

### Step 5: Verify it works

In Claude Code, type:
```
/mcp
```
You should see `designxcode-mcp` listed as connected.

### Step 6: Get your Figma file key

Open your Figma file in the browser. The URL looks like:
```
https://www.figma.com/design/uXQvmtNAQukeywIMiieDdy/My-Design-System
                              ^^^^^^^^^^^^^^^^^^^^^^^^
                              This is your file key
```

Copy that file key — you'll use it in every tool call.

---

## Using It (Common Workflows)

### "I want to see my design system"

Ask Claude:
> "Load my design system from Figma file key `YOUR_FILE_KEY`"

Claude will call `get_design_context` and show you:
- All your design tokens (colors, fonts, shadows)
- Available components (Button, Card, etc.)
- Detected patterns (common fonts, colors, spacing)
- Any custom rules you've set

### "I want to generate a Button component from Figma"

Ask Claude:
> "Generate the Button component from my Figma file `YOUR_FILE_KEY` as React + Tailwind"

Claude will call `generate_coded_components` and produce:
- A complete `.tsx` file with all variants (Primary, Outline, Ghost)
- Style maps for each variant (not inline class mess)
- Proper TypeScript types
- All values from your Figma design — no invented colors

### "I want light and dark theme CSS"

Ask Claude:
> "Generate theme config from Figma file `YOUR_FILE_KEY`"

Claude will call `generate_theme_config` and produce:
- CSS custom properties for light and dark modes
- Automatically detects which mode is light vs dark
- Works even without Figma Enterprise (uses mode inference)

### "I want to check if my code matches Figma"

Ask Claude:
> "Audit component parity for Figma file `YOUR_FILE_KEY` against repo `your-org/your-repo`"

Claude will call `audit_component_parity` and show:
- Which Figma components have matching code
- Which are missing in code
- Which are missing in Figma
- Coverage percentage

### "I want to export tokens as CSS"

Ask Claude:
> "Sync tokens to CSS from Figma file `YOUR_FILE_KEY`"

Claude will call `sync_tokens_to_code` and generate a `tokens.css` file with all your design tokens as CSS custom properties.

---

## What Problems Aren't Solved Yet

These are real issues that need fixing. If you're looking to contribute or build your portfolio, these are great places to start:

### 1. The Differ Can't Detect Property Removals
**What:** When a Figma component variant removes a property (e.g., Ghost button has no background), the differ doesn't detect it. The old value stays in the generated code.

**Why it matters:** Ghost buttons end up with the Primary button's background color because the differ only catches changes, not removals.

**Where to fix:** `src/utils/state-differ.ts` — the `diffStyles` function (line ~248). It skips properties where `vv === undefined`. Need to emit a reset value (like `background: transparent`) when a property exists in the default but not in the variant.

### 2. Node Parser Emits Redundant Padding
**What:** The parser outputs both `padding: "12px 24px"` AND `paddingTop: "12px"`, `paddingRight: "24px"`, etc. This creates duplicate Tailwind classes.

**Where to fix:** `src/utils/node-parser.ts` — the layout extraction. Should emit EITHER shorthand or individual, not both.

### 3. Child Node State Class Bloat
**What:** When a component has many state variants (hover, active, disabled) across multiple dimensional axes, child nodes (like the text inside a button) get duplicate state classes.

**Where to fix:** `src/utils/emitter-react-tailwind.ts` — the `stateOverridesToTailwind` function. Needs deduplication of modifier classes.

### 4. Theme Token Naming Without Enterprise
**What:** On Figma Professional plan, we can detect variable modes (light/dark) but can't get variable NAMES from the API. Token names come from node names instead, which are often ugly (like `statedefault-sizemd-typeprimary`).

**Where to fix:** `src/utils/mode-inference.ts` — the `buildTokenNamer` function. Could be improved with better heuristics, or by cross-referencing with published style names more aggressively.

### 5. Multi-Axis Variant Differ
**What:** When a component has 3+ dimensional axes (Size × Type × State), the differ can't cleanly separate which properties belong to which axis. It uses pure-variant selection as a workaround.

**Where to fix:** `src/utils/state-differ.ts` — the `diffVariants` function. A proper solution would decompose multi-axis diffs into per-axis deltas.

### 6. Mac App (Tauri + React)
**What:** The mockup exists as an HTML file, but the actual Mac app hasn't been built yet. Need to scaffold a Tauri + React project and wire it to the MCP server.

**Where to start:** `docs/app-screens-spec.md` has the full spec (70 frames across 9 pages). The HTML mockup is at `.superpowers/brainstorm/`. Tech stack: Tauri + React + TypeScript.

### 7. Design System Tests
**What:** The MCP server has zero automated tests. Everything is tested manually via MCP tool calls.

**Where to start:** Add Vitest, write unit tests for `state-differ.ts`, `mode-inference.ts`, `token-inference.ts`, and `emitter-react-tailwind.ts`.

---

## How to Build a Portfolio Piece From This

Here's how an 18-year-old could turn this into a strong portfolio project:

### Option A: Fix a Bug → Write About It
1. Pick one of the unsolved problems above (start with #2 — redundant padding, it's the easiest)
2. Read the code, understand the bug
3. Write a failing test
4. Fix it
5. Write a blog post: "How I fixed a code generation bug in an open-source design system tool"
6. Push to GitHub, link the PR

### Option B: Build the Mac App
1. Read `docs/app-screens-spec.md`
2. Scaffold a Tauri + React project
3. Build one page at a time (start with Overview)
4. Wire it to the MCP server
5. Portfolio piece: "I built a native Mac app for design system management"

### Option C: Add a New Tool
1. Think of something the MCP server doesn't do yet (e.g., accessibility checker, animation token extractor, icon library manager)
2. Look at how existing tools are structured in `src/tools/`
3. Build it following the same pattern
4. Portfolio piece: "I added a new capability to an MCP server"

### Option D: Build the India News Project
1. Completely separate project at `Documents/Claude/GroundNewsIndia`
2. Research Ground News features
3. Adapt for Indian media landscape (50+ outlets, 7+ languages)
4. Portfolio piece: "I built a media bias detection platform for India"

---

## Project Structure

```
designxcode-mcp/
├── src/
│   ├── clients/          # Figma + GitHub API clients
│   ├── tools/            # All 12 MCP tool implementations
│   ├── utils/            # Core logic
│   │   ├── state-differ.ts        # Variant diffing
│   │   ├── node-parser.ts         # Figma node → CSS properties
│   │   ├── emitter-react-tailwind.ts  # Code generation
│   │   ├── mode-inference.ts      # Light/dark detection
│   │   ├── token-inference.ts     # Style-based token extraction
│   │   ├── pattern-inference.ts   # Usage pattern detection
│   │   ├── context-formatter.ts   # Design context assembly
│   │   └── theme-formatters.ts    # CSS/Tailwind/ThemeProvider output
│   ├── types/            # TypeScript types
│   ├── transforms/       # Style Dictionary transforms
│   ├── cache/            # Design system cache
│   ├── prompts/          # MCP prompts
│   └── index.ts          # Server entry point
├── design-system/        # Generated components + preview
├── docs/                 # Specs and this walkthrough
├── .env                  # Your tokens (never commit this!)
└── dist/                 # Compiled JavaScript
```

---

## Key Concepts

**MCP (Model Context Protocol):** A standard that lets AI tools (like Claude) talk to external services. DesignxCode is an MCP server — Claude connects to it and calls its tools.

**Design tokens:** The atomic values of a design system — colors (#d51e8c), font sizes (16px), shadows (0 1px 3px), spacing (8px). They're the building blocks everything is built from.

**Variants:** Different states of a component. A Button has variants: Primary/Outline/Ghost (type), Small/Medium (size), Default/Hover/Active/Disabled (state).

**Mode inference:** Our technique for detecting light/dark themes without Figma Enterprise. We walk the file tree, find the same variable resolving to different colors in different frames, and cluster by luminance. Nobody else does this.

**Style maps:** Instead of generating `className="bg-[#d51e8c] text-[#fafbfc] hover:bg-[#b8187a] ..."` (a wall of inline classes), we generate clean lookup tables:
```tsx
const typeStyles = {
  primary: { base: "bg-[#d51e8c]", hover: "hover:bg-[#b8187a]" },
  ghost: { base: "text-[#6b7280]", hover: "hover:bg-[#f3f6fa]" },
};
```

---

## Questions?

Open an issue at [github.com/thevoiduniverse/designxcode-workspace](https://github.com/thevoiduniverse/designxcode-workspace) or just ask Claude with the MCP connected.

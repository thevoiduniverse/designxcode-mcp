<div align="center">
  <img src="https://raw.githubusercontent.com/thevoiduniverse/designxcode-mcp/main/assets/icon.png" alt="DesignxCode" width="80" />
  <br />
  <img src="https://raw.githubusercontent.com/thevoiduniverse/designxcode-mcp/main/assets/logo.png" alt="DesignxCode" width="320" />
  <h1>DesignxCode MCP</h1>
  <p><strong>Keep your Figma design system and codebase perfectly in sync.</strong></p>
  <p>An MCP server for Claude that extracts tokens, audits drift, generates code, and creates PRs - no manual work required.</p>

  [![npm version](https://img.shields.io/npm/v/designxcode-mcp-server?style=flat-square)](https://www.npmjs.com/package/designxcode-mcp-server)
  [![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
  [![Downloads](https://img.shields.io/npm/dm/designxcode-mcp-server?style=flat-square)](https://www.npmjs.com/package/designxcode-mcp-server)
  [![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen?style=flat-square)]()
  [![MCP](https://img.shields.io/badge/MCP-compatible-8B5CF6?style=flat-square)]()
</div>

---

> **Without DesignxCode:** Manual token audits, stale code values, design-code drift discovered in production, hours spent copying values from Figma.
>
> **With DesignxCode:** One prompt to Claude and you get a sync score, drift report, generated code files, and a PR ready to merge.

---

## Quick Start

### npx (zero install)

```bash
npx designxcode-mcp-server
```

### Claude Code

```bash
claude mcp add designxcode -e FIGMA_ACCESS_TOKEN=your-token -e GITHUB_TOKEN=your-token -- npx designxcode-mcp-server
```

<details>
<summary><strong>Claude Desktop / Cursor / Windsurf (JSON config)</strong></summary>

Add to your MCP config file:

```json
{
  "mcpServers": {
    "designxcode": {
      "command": "npx",
      "args": ["designxcode-mcp-server"],
      "env": {
        "FIGMA_ACCESS_TOKEN": "your-figma-token",
        "GITHUB_TOKEN": "your-github-token"
      }
    }
  }
}
```

| Client | Config location |
|--------|----------------|
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Cursor | Settings > MCP Servers |
| Windsurf | `~/.windsurf/mcp.json` |

</details>

<details>
<summary><strong>Install from source</strong></summary>

```bash
git clone https://github.com/thevoiduniverse/designxcode-mcp.git
cd designxcode-mcp
npm install
npm run build
node dist/index.js
```

</details>

## What You Can Ask Claude

```
"How in sync is our design system?"
"Extract all tokens from our Figma file"
"Which components are missing in code?"
"Generate CSS and Tailwind tokens from Figma"
"Create a PR to fix the drifted tokens"
"Show me unused tokens in our codebase"
"Implement this Figma frame as a React component"
```

## Tools

### Token Tools
- **extract_tokens** - Extract design tokens (variables) from Figma in W3C, Style Dictionary, or raw format
- **sync_tokens_to_code** - Generate platform-specific token files (CSS, SCSS, Tailwind, JSON, Swift, Kotlin)
- **detect_unused_tokens** - Find tokens defined in Figma that aren't used in your codebase
- **extract_styles** - Extract legacy Figma styles (colors, text, effects, grids)

### Audit Tools
- **audit_system_health** - Comprehensive 0-100 sync score combining token drift + component parity
- **audit_component_parity** - Compare Figma components against code components via Storybook or file tree

### Code Generation
- **generate_coded_components** - Generate production React components from Figma frames
- **implement_design** - Convert a Figma frame into design-system-aware code
- **generate_theme_config** - Create theme configuration files from Figma variables
- **generate_component_scaffold** - Scaffold component file structure from Figma components

### Workflow Tools
- **generate_sync_pr** - Create a GitHub PR with token updates (supports dry run)
- **generate_design_doc** - Generate design documentation from Figma components
- **get_design_context** - Get full design context for a Figma node (styles, tokens, structure)
- **set_design_rules** - Define rules for how design tokens map to code patterns
- **export_assets** - Export icons and images from Figma as optimized assets

## Prerequisites

| Requirement | Details |
|-------------|---------|
| **Node.js** | >= 18 |
| **Figma token** | [Generate here](https://www.figma.com/developers/api#access-tokens) |
| **GitHub token** | Optional. Required for PRs and component parity via file tree |

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `FIGMA_ACCESS_TOKEN` | Yes | Figma personal access token with file read access |
| `GITHUB_TOKEN` | No | GitHub PAT with `repo` scope for PR generation and code scanning |

> [!IMPORTANT]
> The Figma Variables API (`extract_tokens`, `sync_tokens_to_code`) requires a Figma **Enterprise or Organization** plan. On Professional plans, a local fallback is used automatically.

## How It Works

```
Figma Design System
        |
        v
  DesignxCode MCP  ──────> Claude analyzes your tokens,
        |                   components, and code
        v
  Your Codebase    <──────  Generates files, creates PRs,
                            reports drift
```

1. You ask Claude a question about your design system
2. Claude calls the right DesignxCode tool via MCP
3. The tool reads from Figma API and/or your GitHub repo
4. Results come back to Claude who explains them and takes action

## Figma File Key

Extract from any Figma URL:

```
https://www.figma.com/design/ABC123xyz/My-Design-File
                              ^^^^^^^^^
                              This is your fileKey
```

<details>
<summary>Branch URLs</summary>

```
https://www.figma.com/design/ABC123xyz/branch/DEF456/My-File
                                              ^^^^^^
                                              Use this as fileKey
```

</details>

## Architecture

```
src/
├── index.ts              # Server entry, tool registration
├── tools/                # 15 MCP tool implementations
│   ├── extract-tokens    # Figma variables → W3C/SD format
│   ├── sync-tokens       # Tokens → CSS/SCSS/Tailwind/Swift/Kotlin
│   ├── audit-*           # Health score, component parity
│   ├── generate-*        # Components, PRs, docs, themes
│   └── implement-design  # Figma frame → production code
├── clients/              # Figma & GitHub API adapters
├── transforms/           # Style Dictionary platform transforms
├── utils/                # Diffing, inference, formatting
└── types/                # TypeScript definitions
```

## Development

```bash
npm run dev          # Watch mode with tsx
npm run build        # TypeScript compilation
npm run inspect      # Test with MCP Inspector
npm run clean        # Clean dist/
```

## Troubleshooting

<details>
<summary><strong>403 Forbidden from Figma Variables API</strong></summary>

The Variables REST API requires a Figma **Enterprise** or **Organization** plan. On free/Professional plans, the API returns 403. The server automatically falls back to local token files when available.

</details>

<details>
<summary><strong>401 Unauthorized from Figma</strong></summary>

Your access token is invalid or expired. Generate a new one at **Figma > Settings > Personal access tokens**.

</details>

<details>
<summary><strong>401 or 404 from GitHub</strong></summary>

Your `GITHUB_TOKEN` may be expired or lack the required scopes. Ensure it has `repo` scope (and `read:org` for private org repos).

</details>

<details>
<summary><strong>Rate limiting (429)</strong></summary>

Figma's API has rate limits. If you hit `429 Too Many Requests`, wait a minute before retrying. The server surfaces rate-limit errors clearly - no silent failures.

</details>

<details>
<summary><strong>Build errors</strong></summary>

```bash
npm run clean && npm run build
```

Ensure Node >= 18 and run `npm install` to refresh dependencies.

</details>

## Token Scopes

<details>
<summary><strong>Figma Access Token</strong></summary>

Generate at **Figma > Settings > Personal access tokens**. Needs read access to target files. For the Variables API, your workspace must be on an Enterprise or Organization plan.

</details>

<details>
<summary><strong>GitHub Token</strong></summary>

Required for `audit_component_parity` (file-tree source), `audit_system_health`, and `generate_sync_pr`.

| Scope | Purpose |
|-------|---------|
| `repo` | Create branches, commits, and pull requests |
| `read:org` | Access private repositories in an organization |

Generate at **GitHub > Settings > Developer settings > Fine-grained tokens**.

</details>

## Contributing

Contributions are welcome! Please open an issue first to discuss what you'd like to change.

## License

[MIT](LICENSE)

---

<div align="center">
  <p>Built for teams that care about design-code consistency.</p>
  <a href="https://www.npmjs.com/package/designxcode-mcp-server">npm</a> · <a href="https://github.com/thevoiduniverse/designxcode-mcp/issues">Issues</a>
</div>

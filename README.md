# DesignxCode MCP Server

A stateless MCP server that keeps Figma design systems and code in sync — auditing token drift, comparing component parity, transforming tokens into multi-platform code, and auto-generating GitHub PRs to fix drifts.

## Install

### From npm (recommended)

```bash
npx designxcode-mcp-server
```

Or install globally:

```bash
npm install -g designxcode-mcp-server
```

### From source

```bash
git clone https://github.com/designxcode/designxcode-mcp.git
cd designxcode-mcp
npm install
npm run build
```

## Setup

### Prerequisites

- Node.js >= 18
- Figma access token
- GitHub personal access token (optional, for GitHub-dependent tools)

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `FIGMA_ACCESS_TOKEN` | Yes | Figma personal access token. Generate at https://www.figma.com/developers/api#access-tokens |
| `GITHUB_TOKEN` | No | GitHub PAT with `repo` scope. Required for component parity, health audit, and PR generation. |

### Register with Claude Code

Add to your Claude Code MCP config (`~/.claude/claude_code_config.json`):

```json
{
  "mcpServers": {
    "designxcode": {
      "command": "node",
      "args": ["/path/to/designxcode-mcp/dist/index.js"],
      "env": {
        "FIGMA_ACCESS_TOKEN": "your-figma-token",
        "GITHUB_TOKEN": "your-github-token"
      }
    }
  }
}
```

## Tools

### `extract_tokens`
Extract design tokens (variables) from a Figma file and convert to W3C, Style Dictionary, or raw format.

**Example prompts:**
- "Extract all design tokens from our Figma file"
- "Get the color tokens from Figma in W3C format"

### `sync_tokens_to_code`
Generate platform-specific token files (CSS, SCSS, Tailwind, Swift, Kotlin, JSON) from Figma variables.

**Example prompts:**
- "Generate CSS and SCSS tokens from our Figma file"
- "Create mobile token files for iOS and Android"

### `audit_component_parity`
Compare Figma components against code components (via Storybook manifest or mapping file).

**Example prompts:**
- "How many of our Figma components have been implemented?"
- "Show me which components are missing from code"

### `audit_system_health`
Run a comprehensive health check combining token drift + component parity into a 0-100 sync score.

**Example prompts:**
- "How in sync is our design system?"
- "Give me a health report"

### `generate_sync_pr`
Create a GitHub PR with design token updates. Supports `dry_run` mode.

**Example prompts:**
- "Create a PR to sync our tokens"
- "Preview what the sync PR would look like"

## Development

```bash
npm run dev          # Watch mode with tsx
npm run build        # TypeScript compilation
npm run inspect      # Test with MCP Inspector
```

## Architecture

```
src/
├── index.ts                    # Server entry, tool registration
├── tools/                      # MCP tool implementations
├── clients/                    # Figma & GitHub API clients
├── transforms/                 # Style Dictionary platform transforms
├── utils/                      # Diffing, W3C conversion, errors
└── types/                      # TypeScript type definitions
```

## Figma File Key

Extract the `fileKey` from any Figma URL:

```
https://www.figma.com/design/ABC123xyz/My-Design-File?node-id=0-1
                              ^^^^^^^^^
                              This is your fileKey
```

For branch URLs, use the branch key:

```
https://www.figma.com/design/ABC123xyz/branch/DEF456/My-File
                                              ^^^^^^
                                              Use this as fileKey
```

## Token Scopes

### Figma Access Token

Generate at **Figma → Settings → Personal access tokens**. The token needs read access to the files you want to sync. For the Variables API (`extract_tokens`, `sync_tokens_to_code`), your Figma workspace must be on an **Enterprise or Organization** plan.

### GitHub Token

Required only for `audit_component_parity` (file-tree source), `audit_system_health`, and `generate_sync_pr`.

| Scope | Purpose |
|-------|---------|
| `repo` | Create branches, commits, and pull requests |
| `read:org` | Access private repositories in an organization |

Generate at **GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens**.

## Troubleshooting

### `403 Forbidden` from Figma Variables API

The Variables REST API requires a Figma **Enterprise** or **Organization** plan. On free/Professional plans, the API returns 403. Verify your plan at **Figma → Settings → Plan**.

### `401 Unauthorized` from Figma

Your access token is invalid or expired. Generate a new one at **Figma → Settings → Personal access tokens**.

### `401` or `404` from GitHub

Your `GITHUB_TOKEN` may be expired or lack the required scopes. Ensure it has `repo` scope (and `read:org` for private org repos).

### Rate limiting

Figma's API has rate limits. If you hit `429 Too Many Requests`, wait a minute before retrying. The server surfaces rate-limit errors with a clear message — no silent failures.

### Build errors

```bash
npm run clean && npm run build
```

If TypeScript errors persist, ensure you're on Node >= 18 and run `npm install` to refresh dependencies.

## License

[MIT](LICENSE)

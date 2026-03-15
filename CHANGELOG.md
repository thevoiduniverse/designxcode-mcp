# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-03-12

### Added

- **`extract_tokens`** — Extract design tokens (variables) from a Figma file and convert to W3C DTCG, Style Dictionary, or raw JSON format.
- **`sync_tokens_to_code`** — Generate platform-specific token files (CSS custom properties, SCSS variables, Tailwind theme, Swift UIColor, Kotlin Compose, JSON) from Figma variables.
- **`audit_component_parity`** — Compare Figma components against code components via Storybook manifest, mapping file, or GitHub file tree to surface missing, extra, and matched components.
- **`audit_system_health`** — Run a comprehensive health check combining token drift and component parity into a 0–100 sync score with actionable recommendations.
- **`generate_sync_pr`** — Create a GitHub pull request with design token updates, including full diff preview and `dry_run` mode.
- Strict TypeScript with Zod validation on all tool inputs.
- Custom MCP error codes for Figma API failures, GitHub API failures, and validation errors.
- Style Dictionary transforms for 6 platforms (CSS, SCSS, Tailwind, Swift, Kotlin, JSON).
- W3C Design Token Community Group (DTCG) format conversion.

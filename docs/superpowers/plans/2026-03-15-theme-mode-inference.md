# Theme Mode Inference Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable `generate_theme_config` to work on Professional plan by inferring variable modes from resolved values across the file tree — no Variables API required.

**Architecture:** Walk the file tree, collect all `boundVariables` with their resolved fill/stroke/effect values, group by variable ID, detect multi-mode variables by finding 2+ distinct resolved values, classify into modes by frequency, then feed into existing `ClassifiedTokens` → formatter pipeline.

**Tech Stack:** TypeScript, existing FigmaClient, existing theme-formatters

---

### Task 1: Create mode inference utility

**Files:**
- Create: `src/utils/mode-inference.ts`

- [ ] **Step 1: Create `inferModesFromFileTree` function**

The core algorithm:
1. Walk file tree recursively
2. For each node with `boundVariables`, extract variable IDs + resolved values from fills/strokes/effects
3. Group: `Map<variableId, Map<resolvedValue, count>>`
4. Variables with 2+ distinct values are multi-mode
5. Most frequent value = default mode, other = alternate
6. Infer mode names from color luminance (light vs dark)
7. Return `ClassifiedTokens` compatible with existing formatters

```typescript
interface InferredMode {
  name: string;           // "light" or "dark" (or "mode-1", "mode-2")
  tokens: FlatToken[];    // token name + value for this mode
}

interface ModeInferenceResult {
  modes: InferredMode[];
  defaultMode: string;
  variableCount: number;
}
```

- [ ] **Step 2: Implement variable-value extraction from nodes**

Walk nodes, extract from:
- `fills[].color` + `fills[].boundVariables.color`
- `strokes[].color` + `strokes[].boundVariables.color`
- `effects[].color` + `effects[].boundVariables.color`
- `boundVariables` top-level (padding, cornerRadius, etc.)

For each: record `{ variableId, resolvedValue, cssProperty }`.

- [ ] **Step 3: Implement mode clustering + naming**

Group by variableId → find distinct resolved values → cluster.
Name inference: compute average luminance of color values per cluster.
Lighter cluster = "light", darker = "dark".

- [ ] **Step 4: Implement token naming from published styles**

Cross-reference: fetch published styles via `getFileStyles`, match style nodes'
`boundVariables` to our variable IDs. Style name becomes token name.
Fallback: CSS property + color hex (e.g., `fill-d51e8c`).

- [ ] **Step 5: Build `ClassifiedTokens` output**

Convert `ModeInferenceResult` into the existing `ClassifiedTokens` shape
so the formatters (CSS, Tailwind, ThemeProvider) work unchanged.

- [ ] **Step 6: Compile**

Run: `npm run build`
Expected: Clean compile

- [ ] **Step 7: Commit**

```bash
git add src/utils/mode-inference.ts
git commit -m "feat: add mode inference utility for Professional plan theme extraction"
```

### Task 2: Update generate_theme_config to use mode inference

**Files:**
- Modify: `src/tools/generate-theme-config.ts`

- [ ] **Step 8: Add fallback logic**

When `getLocalVariables` throws a 403 (Enterprise required), catch it and
fall back to `inferModesFromFileTree` using `getFile` data instead.

No new parameters needed — it's transparent to the user.

- [ ] **Step 9: Compile**

Run: `npm run build`
Expected: Clean compile

- [ ] **Step 10: Commit**

```bash
git add src/tools/generate-theme-config.ts
git commit -m "feat: fallback to mode inference when Variables API unavailable"
```

### Task 3: Test with Figma file

- [ ] **Step 11: Restart MCP and run generate_theme_config**

Call `generate_theme_config` on file key `uXQvmtNAQukeywIMiieDdy`.
Verify it detects light/dark modes from the ButtonMatrix frame.

- [ ] **Step 12: Verify output**

Check that the CSS output has correct light/dark custom properties
with values matching the Figma design.

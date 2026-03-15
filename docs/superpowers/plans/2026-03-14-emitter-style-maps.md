# Emitter Style Maps Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `emitter-react-tailwind.ts` to produce clean lookup-table variant maps instead of inline className conditionals.

**Architecture:** Build style maps from the existing `ComponentIR` (dimensional variants + state overrides), emit them as `const` objects at the top of the generated component, and reference them in JSX via prop-driven lookups. No IR or differ changes needed — this is purely an emitter refactor.

**Tech Stack:** TypeScript, existing `ComponentIR` types

---

## Context: How the IR carries variant data

The state differ (`state-differ.ts`) produces three categories:

1. **Global state overrides** — when only state props changed (e.g., Default→Hover with same Type). These contain the *default variant's* hover/active/disabled style diffs.
2. **Dimensional variants** — when only dim props changed (e.g., Primary→Ghost at Default state). These contain the variant's base style diffs.
3. **Scoped state overrides** — when BOTH changed (e.g., Ghost+Hover). Named `"{dimValue}-{stateName}"`. These contain that specific variant's state-specific diffs.

To build lookup tables, the emitter must merge these: each dimensional value gets `{ base, hover, active, ... }` by combining its dimensional variant (base) with its scoped state overrides (state keys), then falling back to global state overrides for any state not scoped.

## Target output

For a Button with `Type=[Primary,Outline,Ghost]` × `Size=[MD,SM]` × `State=[Default,Hover,Pressed,Disabled]`:

```tsx
const typeStyles = {
  primary: {
    base: "bg-[#d51e8b] text-[#fafbfc] shadow-[0_1px_2px_rgba(0,0,0,0.1)]",
    hover: "hover:bg-[#b8187a]",
    active: "active:bg-[#d51e8b]",
    disabled: "disabled:opacity-25",
  },
  ghost: {
    base: "text-[#6b7280] bg-transparent",
    hover: "hover:bg-[#f3f6fa] hover:text-[#0a0d14]",
    active: "active:bg-[#e5e7eb]",
    disabled: "disabled:opacity-25",
  },
} as const;

const sizeStyles = {
  md: "px-6 py-3 text-base",
  sm: "px-4 py-2 text-sm",
} as const;
```

Axes WITH scoped state overrides → object values `{ base, hover, ... }`.
Axes WITHOUT state interactions → plain string values.

JSX references them cleanly:
```tsx
<button className={[
  "inline-flex items-center justify-center rounded-full transition-colors",
  "focus:outline-none disabled:pointer-events-none",
  sizeStyles[size],
  typeStyles[type].base,
  typeStyles[type].hover,
  typeStyles[type].active,
  typeStyles[type].disabled,
  className,
].filter(Boolean).join(" ")} {...props}>
```

---

## Chunk 1: Implementation

### Task 1: Add `buildStyleMaps` helper

**Files:**
- Modify: `src/utils/emitter-react-tailwind.ts`

This function takes a `ComponentIR` and produces structured style maps per dimensional axis.

- [ ] **Step 1: Add types and `buildStyleMaps` function**

```typescript
interface StyleMapEntry {
  base: string;
  [stateKey: string]: string; // hover, active, disabled, etc.
}

interface StyleMap {
  propName: string;           // e.g., "type"
  constName: string;          // e.g., "typeStyles"
  hasStateInteractions: boolean;
  entries: Record<string, string | StyleMapEntry>;
}

function buildStyleMaps(ir: ComponentIR): StyleMap[]
```

Logic:
1. Group `ir.dimensionalVariants` by `propName` → `Map<propName, DimensionalVariant[]>`
2. Parse scoped state overrides: split `stateName` on `-` to extract `dimValue` and `stateKey`
3. For each propName group:
   - Check if any scoped state overrides exist for this axis → `hasStateInteractions`
   - For each variant value:
     - `base` = Tailwind classes from `variant.overrides` (for the root className)
     - State keys = Tailwind classes from matching scoped overrides, with Tailwind modifier prefixes (hover:, active:, etc.)
   - If no state interactions, entries are plain strings (just base)
   - If state interactions exist, entries are `StyleMapEntry` objects
4. Also include global state overrides as fallback for the default variant value (which has no dimensional variant entry since it IS the default)

- [ ] **Step 2: Compile and verify no type errors**

Run: `npm run build`
Expected: Clean compile

### Task 2: Add `emitStyleMapConsts` function

**Files:**
- Modify: `src/utils/emitter-react-tailwind.ts`

- [ ] **Step 3: Write function to emit style map const declarations**

```typescript
function emitStyleMapConsts(styleMaps: StyleMap[]): string[]
```

Produces lines like:
```typescript
const typeStyles = {
  primary: {
    base: "bg-[#d51e8b] text-[#fafbfc]",
    hover: "hover:bg-[#b8187a]",
  },
  ghost: { ... },
} as const;
```

For maps without state interactions:
```typescript
const sizeStyles = {
  md: "px-6 py-3 text-base",
  sm: "px-4 py-2 text-sm",
} as const;
```

- [ ] **Step 4: Compile**

Run: `npm run build`
Expected: Clean compile

### Task 3: Refactor `generateTSX` to use style maps

**Files:**
- Modify: `src/utils/emitter-react-tailwind.ts`

- [ ] **Step 5: Refactor `generateTSX`**

Changes:
1. Call `buildStyleMaps(ir)` at the top
2. Emit style map consts between imports and the component function
3. Generate type aliases from style maps (e.g., `type ButtonType = keyof typeof typeStyles`)
4. Update props interface to use union types from style maps
5. Pass style maps to `emitTailwindJSX` instead of the old inline approach

- [ ] **Step 6: Refactor `emitTailwindJSX` for root node**

Replace the inline conditional block (lines 254-279) with:
1. Base classes from `stylesToTailwind(node.styles)` (unchanged)
2. Global state override classes from `stateOverridesToTailwind` — but ONLY for states not captured in any style map
3. For each style map: reference via prop lookup

For a map WITH state interactions:
```
${constName}[${propName}].base,
${constName}[${propName}].hover,
// etc for each state key
```

For a map WITHOUT state interactions:
```
${constName}[${propName}],
```

- [ ] **Step 7: Compile**

Run: `npm run build`
Expected: Clean compile

- [ ] **Step 8: Commit**

```bash
git add src/utils/emitter-react-tailwind.ts
git commit -m "refactor: emit variant lookup tables instead of inline conditionals"
```

### Task 4: Test via MCP

- [ ] **Step 9: Restart MCP and run generate_coded_components**

Call `generate_coded_components` on the Figma file to generate Button.
Inspect the output TSX — it should produce clean style maps matching the target output pattern.

- [ ] **Step 10: Compare with hand-crafted Button**

Compare generated `Button.tsx` against the hand-crafted version in `design-system/Button/Button.tsx`.
Key checks:
- Style maps are structured correctly
- No inline conditionals in className
- State modifiers (hover:, active:, etc.) appear in the right places
- Props interface uses clean union types

- [ ] **Step 11: Final commit if adjustments needed**

```bash
git add src/utils/emitter-react-tailwind.ts
git commit -m "fix: style map emitter adjustments after testing"
```

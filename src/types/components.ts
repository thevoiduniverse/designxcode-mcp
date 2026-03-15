/**
 * Component mapping and diff result types for design-code parity audits.
 */

/** A mapping entry between a Figma component and a code component */
export interface ComponentMapping {
  figmaName: string;
  codeName: string;
  storyName?: string;
  figmaKey?: string;
  filePath?: string;
}

/** A component found in Figma */
export interface FigmaComponentEntry {
  name: string;
  key: string;
  description: string;
  nodeId?: string;
  setName?: string;
  pageName?: string;
  figmaUrl?: string;
}

/** A component found in code (Storybook manifest or file system) */
export interface CodeComponentEntry {
  name: string;
  filePath?: string;
  storyId?: string;
  hasStory: boolean;
}

/** Result of comparing Figma components vs code components */
export interface ComponentDiffResult {
  /** Components in Figma but missing in code */
  missingInCode: FigmaComponentEntry[];
  /** Components in code but missing in Figma */
  missingInFigma: CodeComponentEntry[];
  /** Components that exist in both with matching names */
  matched: Array<{
    figma: FigmaComponentEntry;
    code: CodeComponentEntry;
  }>;
  /** Summary statistics */
  summary: {
    totalFigma: number;
    totalCode: number;
    matched: number;
    missingInCode: number;
    missingInFigma: number;
    coveragePercent: number;
  };
}

/** Token drift entry */
export interface TokenDrift {
  tokenName: string;
  tokenPath: string[];
  figmaValue: string | number | boolean;
  codeValue: string | number | boolean;
  type: string;
  collection?: string;
  mode?: string;
}

/** Result of comparing Figma tokens vs code tokens */
export interface TokenDiffResult {
  /** Tokens in Figma but missing in code */
  added: Array<{
    name: string;
    path: string[];
    value: string | number | boolean;
    type: string;
    collection?: string;
  }>;
  /** Tokens in code but missing in Figma */
  removed: Array<{
    name: string;
    path: string[];
    value: string | number | boolean;
    type: string;
  }>;
  /** Tokens that exist in both but have different values */
  changed: TokenDrift[];
  /** Summary statistics */
  summary: {
    totalFigma: number;
    totalCode: number;
    added: number;
    removed: number;
    changed: number;
    unchanged: number;
  };
}

/** Overall system health score */
export interface SystemHealthReport {
  score: number;
  tokenDrift: TokenDiffResult | null;
  componentParity: ComponentDiffResult | null;
  timestamp: string;
  figmaFileKey: string;
  githubRepo: string;
}

// ─── Unused token detection types ───

/** A single unused token entry */
export interface UnusedTokenEntry {
  name: string;
  type: string;
  value: string | number | boolean;
  collection?: string;
  cssVarName: string;
  scssVarName: string;
}

/** A token usage entry with reference count */
export interface TokenUsageEntry {
  tokenName: string;
  references: number;
  files: string[];
}

/** Result of unused token detection */
export interface UnusedTokenResult {
  totalTokens: number;
  usedTokens: number;
  unusedTokens: UnusedTokenEntry[];
  usageMap: TokenUsageEntry[];
  summary: string;
}

/** Storybook stories.json manifest shape */
export interface StorybookManifest {
  v: number;
  stories: Record<string, {
    id: string;
    title: string;
    name: string;
    importPath: string;
    kind?: string;
  }>;
}

/**
 * Utilities for deriving search patterns from token names
 * and batching GitHub code search queries.
 */

import type { GitHubClient } from "../clients/github.js";
import type { TokenUsageEntry } from "../types/components.js";

/** Search pattern variations for a token */
export interface TokenSearchPatterns {
  tokenName: string;
  cssVar: string;
  scssVar: string;
  raw: string;
}

/** Derive CSS/SCSS/raw search patterns from a token name and path */
export function deriveSearchPatterns(
  tokenName: string,
  tokenPath: string[]
): TokenSearchPatterns {
  // Convert path to kebab-case variable name: ["colors", "primary", "500"] → "colors-primary-500"
  const kebab = tokenPath.join("-").toLowerCase().replace(/\s+/g, "-");

  return {
    tokenName,
    cssVar: `--${kebab}`,
    scssVar: `$${kebab}`,
    raw: kebab,
  };
}

/** Batch search queries to stay within GitHub's ~256 char query limit */
export function batchSearchQueries(
  patterns: TokenSearchPatterns[],
  searchTypes: string[]
): string[] {
  const queries: string[] = [];

  for (const pattern of patterns) {
    const searchTerms: string[] = [];

    if (searchTypes.includes("css") || searchTypes.includes("all")) {
      searchTerms.push(pattern.cssVar);
    }
    if (searchTypes.includes("scss") || searchTypes.includes("all")) {
      searchTerms.push(pattern.scssVar);
    }
    if (searchTypes.includes("tailwind") || searchTypes.includes("all")) {
      searchTerms.push(pattern.raw);
    }

    // Each term becomes its own query to avoid false negatives from OR semantics
    for (const term of searchTerms) {
      queries.push(term);
    }
  }

  return queries;
}

/**
 * Search for token usage in a GitHub repo.
 * Returns usage entries with reference counts and file lists.
 * Handles rate limits gracefully by returning partial results.
 */
export async function searchTokenUsage(
  githubClient: GitHubClient,
  repo: string,
  patterns: TokenSearchPatterns[],
  searchTypes: string[],
  fileExtensions?: string[]
): Promise<{ usage: TokenUsageEntry[]; warnings: string[] }> {
  const usageMap = new Map<string, TokenUsageEntry>();
  const warnings: string[] = [];

  // Initialize all tokens as unused
  for (const pattern of patterns) {
    usageMap.set(pattern.tokenName, {
      tokenName: pattern.tokenName,
      references: 0,
      files: [],
    });
  }

  for (const pattern of patterns) {
    const searchTerms: string[] = [];

    if (searchTypes.includes("css") || searchTypes.includes("all")) {
      searchTerms.push(pattern.cssVar);
    }
    if (searchTypes.includes("scss") || searchTypes.includes("all")) {
      searchTerms.push(pattern.scssVar);
    }
    if (searchTypes.includes("tailwind") || searchTypes.includes("all")) {
      searchTerms.push(pattern.raw);
    }

    for (const term of searchTerms) {
      try {
        // Add file extension filter if specified
        let query = `"${term}"`;
        if (fileExtensions && fileExtensions.length > 0) {
          // GitHub search supports extension: qualifier
          const extFilters = fileExtensions.map((ext) => `extension:${ext}`).join(" ");
          query = `"${term}" ${extFilters}`;
        }

        const results = await githubClient.searchCode(repo, query);

        const entry = usageMap.get(pattern.tokenName)!;
        entry.references += results.length;
        for (const result of results) {
          if (!entry.files.includes(result.path)) {
            entry.files.push(result.path);
          }
        }
      } catch (error: unknown) {
        // Handle rate limits gracefully
        if (
          error instanceof Error &&
          (error.message.includes("403") || error.message.includes("429"))
        ) {
          warnings.push(
            `Rate limited while searching for "${term}". Some results may be incomplete.`
          );
          // Continue with remaining searches
        } else {
          throw error;
        }
      }
    }
  }

  return {
    usage: Array.from(usageMap.values()),
    warnings,
  };
}

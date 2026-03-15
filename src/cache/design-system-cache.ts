/**
 * In-memory cache with TTL for design system context data.
 * Keyed by "{fileKey}:{section}" — lost on server restart (acceptable for v1).
 */

export type CacheSection = "tokens" | "components" | "patterns" | "patterns-json" | "rules";

interface CacheEntry {
  data: string;
  fetchedAt: number;
  ttlMs: number;
}

/** TTL values in milliseconds */
const SECTION_TTLS: Record<CacheSection, number> = {
  tokens: 5 * 60 * 1000,       // 5 minutes
  components: 5 * 60 * 1000,   // 5 minutes
  patterns: 10 * 60 * 1000,          // 10 minutes
  "patterns-json": 10 * 60 * 1000,  // 10 minutes (structured format)
  rules: Infinity,                    // No TTL — invalidated on write
};

export class DesignSystemCache {
  private entries = new Map<string, CacheEntry>();

  private key(fileKey: string, section: CacheSection): string {
    return `${fileKey}:${section}`;
  }

  /** Get cached data if it exists and hasn't expired */
  get(fileKey: string, section: CacheSection): string | null {
    const entry = this.entries.get(this.key(fileKey, section));
    if (!entry) return null;

    const age = Date.now() - entry.fetchedAt;
    if (age > entry.ttlMs) {
      this.entries.delete(this.key(fileKey, section));
      return null;
    }

    return entry.data;
  }

  /** Store data in cache with section-appropriate TTL */
  set(fileKey: string, section: CacheSection, data: string): void {
    this.entries.set(this.key(fileKey, section), {
      data,
      fetchedAt: Date.now(),
      ttlMs: SECTION_TTLS[section],
    });
  }

  /** Invalidate a specific section for a file */
  invalidate(fileKey: string, section: CacheSection): void {
    this.entries.delete(this.key(fileKey, section));
  }

  /** Invalidate all sections for a file */
  invalidateAll(fileKey: string): void {
    for (const section of Object.keys(SECTION_TTLS) as CacheSection[]) {
      this.entries.delete(this.key(fileKey, section));
    }
  }
}

/**
 * Figma REST API client with exponential backoff for rate limits.
 */

import type {
  FigmaLocalVariablesResponse,
  FigmaPublishedVariablesResponse,
  FigmaFileComponentsResponse,
  FigmaFileStylesResponse,
  FigmaFileResponse,
  FigmaFileNodesResponse,
  FigmaImagesResponse,
} from "../types/figma.js";
import {
  McpToolError,
  figmaAuthError,
  figmaScopeError,
  figmaFileNotFound,
  figmaRateLimited,
} from "../utils/errors.js";

const FIGMA_API_BASE = "https://api.figma.com/v1";
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

export class FigmaClient {
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  private async request<T>(path: string): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(`${FIGMA_API_BASE}${path}`, {
          headers: {
            "X-Figma-Token": this.token,
          },
        });

        if (response.status === 401) {
          throw figmaAuthError();
        }

        if (response.status === 403) {
          // 403 on /variables/ endpoints means Enterprise/Org plan required
          if (path.includes("/variables/")) {
            throw figmaScopeError("Variables API");
          }
          throw figmaAuthError();
        }

        if (response.status === 404) {
          const fileKeyMatch = path.match(/\/files\/([^/]+)/);
          throw figmaFileNotFound(fileKeyMatch?.[1] ?? "unknown");
        }

        if (response.status === 429) {
          const retryAfter = response.headers.get("retry-after");
          const backoffMs = retryAfter
            ? parseInt(retryAfter, 10) * 1000
            : INITIAL_BACKOFF_MS * Math.pow(2, attempt);

          if (attempt === MAX_RETRIES) {
            throw figmaRateLimited(backoffMs);
          }

          await sleep(backoffMs);
          continue;
        }

        if (!response.ok) {
          const body = await response.text();
          throw new Error(`Figma API error (${response.status}): ${body}`);
        }

        return (await response.json()) as T;
      } catch (error) {
        lastError = error;
        // Don't retry non-retriable errors
        if (error instanceof McpToolError) {
          throw error;
        }
        if (attempt === MAX_RETRIES) {
          throw error;
        }
        await sleep(INITIAL_BACKOFF_MS * Math.pow(2, attempt));
      }
    }

    throw lastError;
  }

  /** Get local variables and collections from a Figma file */
  async getLocalVariables(fileKey: string): Promise<FigmaLocalVariablesResponse> {
    return this.request<FigmaLocalVariablesResponse>(`/files/${fileKey}/variables/local`);
  }

  /** Get published variables from a Figma file */
  async getPublishedVariables(fileKey: string): Promise<FigmaPublishedVariablesResponse> {
    return this.request<FigmaPublishedVariablesResponse>(`/files/${fileKey}/variables/published`);
  }

  /** Get components and component sets from a Figma file */
  async getComponents(fileKey: string): Promise<FigmaFileComponentsResponse> {
    return this.request<FigmaFileComponentsResponse>(`/files/${fileKey}/components`);
  }

  /** Get styles from a Figma file */
  async getFileStyles(fileKey: string): Promise<FigmaFileStylesResponse> {
    return this.request<FigmaFileStylesResponse>(`/files/${fileKey}/styles`);
  }

  /** Get the full file (for discovering unpublished components via the document tree) */
  async getFile(fileKey: string, depth?: number): Promise<FigmaFileResponse> {
    const depthParam = depth !== undefined ? `?depth=${depth}` : "";
    return this.request<FigmaFileResponse>(`/files/${fileKey}${depthParam}`);
  }

  /** Get specific nodes with full properties (fills, effects, styles, etc.) */
  async getNodes(fileKey: string, nodeIds: string[]): Promise<FigmaFileNodesResponse> {
    const ids = nodeIds.map((id) => encodeURIComponent(id)).join(",");
    return this.request<FigmaFileNodesResponse>(`/files/${fileKey}/nodes?ids=${ids}`);
  }

  /** Get rendered images for specific nodes */
  async getImages(
    fileKey: string,
    nodeIds: string[],
    format: "svg" | "png" | "jpg" | "pdf" = "svg",
    scale?: number
  ): Promise<FigmaImagesResponse> {
    const ids = nodeIds.map((id) => encodeURIComponent(id)).join(",");
    let path = `/images/${fileKey}?ids=${ids}&format=${format}`;
    if (scale !== undefined && format !== "svg") {
      path += `&scale=${scale}`;
    }
    return this.request<FigmaImagesResponse>(path);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

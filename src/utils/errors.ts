/**
 * Custom error classes with actionable messages for MCP tool errors.
 */

export class McpToolError extends Error {
  public readonly code: string;
  public readonly suggestion: string;

  constructor(message: string, code: string, suggestion: string) {
    super(message);
    this.name = "McpToolError";
    this.code = code;
    this.suggestion = suggestion;
  }

  toUserMessage(): string {
    return `${this.message}\n\nSuggestion: ${this.suggestion}`;
  }
}

export function figmaAuthError(): McpToolError {
  return new McpToolError(
    "Figma authentication failed. Your FIGMA_ACCESS_TOKEN is invalid or expired.",
    "FIGMA_AUTH_ERROR",
    "Generate a new personal access token at https://www.figma.com/developers/api#access-tokens"
  );
}

export function figmaScopeError(endpoint: string): McpToolError {
  return new McpToolError(
    `Figma API returned 403 for ${endpoint}. Your token is valid but lacks the required scope.`,
    "FIGMA_SCOPE_ERROR",
    "The Variables API requires a Figma Enterprise or Organization plan. " +
    "If you have the right plan, ensure your token has the 'file_variables:read' scope. " +
    "See: https://www.figma.com/developers/api#variables"
  );
}

export function figmaFileNotFound(fileKey: string): McpToolError {
  return new McpToolError(
    `Figma file not found: ${fileKey}`,
    "FIGMA_FILE_NOT_FOUND",
    "Verify the file key from your Figma URL: figma.com/design/{THIS_PART}/..."
  );
}

export function figmaNoVariables(fileKey: string): McpToolError {
  return new McpToolError(
    `No variables found in Figma file: ${fileKey}`,
    "FIGMA_NO_VARIABLES",
    "This tool works with Figma Variables (not legacy styles). Ensure your file uses the Variables feature."
  );
}

export function figmaRateLimited(retryAfterMs: number): McpToolError {
  const seconds = Math.ceil(retryAfterMs / 1000);
  return new McpToolError(
    `Figma API rate limit exceeded.`,
    "FIGMA_RATE_LIMITED",
    `Please wait ~${seconds} seconds before retrying. The server uses exponential backoff automatically.`
  );
}

export function figmaNoStyles(fileKey: string): McpToolError {
  return new McpToolError(
    `No styles found in Figma file: ${fileKey}`,
    "FIGMA_NO_STYLES",
    "This tool works with Figma Styles (fill, text, effect, grid). Ensure your file has published styles."
  );
}

export function githubAuthError(): McpToolError {
  return new McpToolError(
    "GitHub authentication failed. Your GITHUB_TOKEN is invalid or lacks required permissions.",
    "GITHUB_AUTH_ERROR",
    "Ensure GITHUB_TOKEN has 'repo' scope. Generate one at https://github.com/settings/tokens"
  );
}

export function githubRepoNotFound(repo: string): McpToolError {
  return new McpToolError(
    `GitHub repository not found: ${repo}`,
    "GITHUB_REPO_NOT_FOUND",
    "Verify the repo format is 'owner/repo' (e.g. 'acme/design-system')."
  );
}

export function githubFileNotFound(repo: string, path: string): McpToolError {
  return new McpToolError(
    `File not found in ${repo}: ${path}`,
    "GITHUB_FILE_NOT_FOUND",
    `Check the file path exists in the repository. Use the default branch if no branch is specified.`
  );
}

export function envVarMissing(varName: string, purpose: string, helpUrl?: string): McpToolError {
  const suggestion = helpUrl
    ? `Set ${varName} in your environment. ${purpose}. See: ${helpUrl}`
    : `Set ${varName} in your environment. ${purpose}.`;
  return new McpToolError(
    `Required environment variable ${varName} is not set.`,
    "ENV_VAR_MISSING",
    suggestion
  );
}

/** Convert any error to an MCP-friendly user message */
export function toUserMessage(error: unknown): string {
  if (error instanceof McpToolError) {
    return error.toUserMessage();
  }
  if (error instanceof Error) {
    return `Error: ${error.message}`;
  }
  return `Error: ${String(error)}`;
}

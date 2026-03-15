/**
 * GitHub API client using Octokit for repo operations.
 */

import { Octokit } from "@octokit/rest";
import { githubAuthError, githubRepoNotFound, githubFileNotFound } from "../utils/errors.js";

export interface FileToCommit {
  path: string;
  content: string;
}

function parseRepo(repo: string): { owner: string; repo: string } {
  const [owner, name] = repo.split("/");
  if (!owner || !name) {
    throw new Error(`Invalid repo format: '${repo}'. Expected 'owner/repo'.`);
  }
  return { owner, repo: name };
}

export class GitHubClient {
  private octokit: Octokit;

  constructor(token: string) {
    this.octokit = new Octokit({ auth: token });
  }

  /** Get the content of a file from a repository */
  async getFileContent(repo: string, path: string, ref?: string): Promise<string> {
    const { owner, repo: repoName } = parseRepo(repo);
    try {
      const response = await this.octokit.repos.getContent({
        owner,
        repo: repoName,
        path,
        ...(ref ? { ref } : {}),
      });

      const data = response.data;
      if (Array.isArray(data) || data.type !== "file" || !("content" in data)) {
        throw new Error(`Path '${path}' is not a file.`);
      }

      return Buffer.from(data.content, "base64").toString("utf-8");
    } catch (error: unknown) {
      if (isOctokitError(error)) {
        if (error.status === 401 || error.status === 403) throw githubAuthError();
        if (error.status === 404) {
          // Distinguish repo not found vs file not found
          try {
            await this.octokit.repos.get({ owner, repo: repoName });
            throw githubFileNotFound(repo, path);
          } catch {
            throw githubRepoNotFound(repo);
          }
        }
      }
      throw error;
    }
  }

  /** Get the default branch of a repository */
  async getDefaultBranch(repo: string): Promise<string> {
    const { owner, repo: repoName } = parseRepo(repo);
    try {
      const { data } = await this.octokit.repos.get({ owner, repo: repoName });
      return data.default_branch;
    } catch (error: unknown) {
      if (isOctokitError(error)) {
        if (error.status === 401 || error.status === 403) throw githubAuthError();
        if (error.status === 404) throw githubRepoNotFound(repo);
      }
      throw error;
    }
  }

  /** Create a new branch from a base ref */
  async createBranch(repo: string, baseBranch: string, newBranch: string): Promise<void> {
    const { owner, repo: repoName } = parseRepo(repo);

    // Get the SHA of the base branch
    const { data: ref } = await this.octokit.git.getRef({
      owner,
      repo: repoName,
      ref: `heads/${baseBranch}`,
    });

    // Create new branch
    await this.octokit.git.createRef({
      owner,
      repo: repoName,
      ref: `refs/heads/${newBranch}`,
      sha: ref.object.sha,
    });
  }

  /** Commit multiple files to a branch using the Git Trees API */
  async commitFiles(
    repo: string,
    branch: string,
    files: FileToCommit[],
    message: string
  ): Promise<string> {
    const { owner, repo: repoName } = parseRepo(repo);

    // Get the current commit SHA for the branch
    const { data: refData } = await this.octokit.git.getRef({
      owner,
      repo: repoName,
      ref: `heads/${branch}`,
    });
    const baseSha = refData.object.sha;

    // Get the base tree
    const { data: commitData } = await this.octokit.git.getCommit({
      owner,
      repo: repoName,
      commit_sha: baseSha,
    });
    const baseTreeSha = commitData.tree.sha;

    // Create blobs for each file
    const treeItems = await Promise.all(
      files.map(async (file) => {
        const { data: blob } = await this.octokit.git.createBlob({
          owner,
          repo: repoName,
          content: Buffer.from(file.content).toString("base64"),
          encoding: "base64",
        });
        return {
          path: file.path,
          mode: "100644" as const,
          type: "blob" as const,
          sha: blob.sha,
        };
      })
    );

    // Create tree
    const { data: tree } = await this.octokit.git.createTree({
      owner,
      repo: repoName,
      base_tree: baseTreeSha,
      tree: treeItems,
    });

    // Create commit
    const { data: newCommit } = await this.octokit.git.createCommit({
      owner,
      repo: repoName,
      message,
      tree: tree.sha,
      parents: [baseSha],
    });

    // Update branch ref
    await this.octokit.git.updateRef({
      owner,
      repo: repoName,
      ref: `heads/${branch}`,
      sha: newCommit.sha,
    });

    return newCommit.sha;
  }

  /** Create a pull request */
  async createPR(
    repo: string,
    branch: string,
    baseBranch: string,
    title: string,
    body: string
  ): Promise<{ number: number; url: string }> {
    const { owner, repo: repoName } = parseRepo(repo);

    const { data: pr } = await this.octokit.pulls.create({
      owner,
      repo: repoName,
      title,
      body,
      head: branch,
      base: baseBranch,
    });

    return { number: pr.number, url: pr.html_url };
  }

  /** Search for code in a repository */
  async searchCode(
    repo: string,
    query: string
  ): Promise<Array<{ name: string; path: string; html_url: string }>> {
    const { owner, repo: repoName } = parseRepo(repo);
    try {
      const { data } = await this.octokit.search.code({
        q: `${query}+repo:${owner}/${repoName}`,
        per_page: 100,
      });
      return data.items.map((item) => ({
        name: item.name,
        path: item.path,
        html_url: item.html_url,
      }));
    } catch (error: unknown) {
      if (isOctokitError(error)) {
        if (error.status === 401) throw githubAuthError();
        if (error.status === 403) {
          // 403 from search API is usually secondary rate limiting, not auth
          const msg = "message" in error ? String(error.message) : "";
          if (msg.includes("rate limit") || msg.includes("abuse")) {
            throw new Error(`GitHub search rate limited. Try again in a few seconds. (${msg})`);
          }
          throw githubAuthError();
        }
        if (error.status === 404) throw githubRepoNotFound(repo);
        if (error.status === 422) {
          // 422 = validation error (e.g., query too long, repo not indexed)
          const msg = "message" in error ? String(error.message) : "Search validation error";
          throw new Error(`GitHub search error: ${msg}`);
        }
      }
      throw error;
    }
  }
}

function isOctokitError(error: unknown): error is { status: number; message: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof (error as Record<string, unknown>).status === "number"
  );
}

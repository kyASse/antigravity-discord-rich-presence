import { execFile } from "node:child_process";
import path from "node:path";
import { sanitizeGitUrl } from "./sanitizer.js";

export interface GitInfo {
    branch?: string;
    repoName?: string;
    remoteUrl?: string;
}

const DEFAULT_GIT_TIMEOUT_MS = 500;

function execGit(args: string[], cwd: string, timeoutMs: number = DEFAULT_GIT_TIMEOUT_MS): Promise<string | undefined> {
    return new Promise((resolve) => {
        try {
            execFile(
                "git",
                args,
                {
                    cwd,
                    timeout: timeoutMs,
                    windowsHide: true,
                    encoding: "utf-8",
                    maxBuffer: 1024 * 64
                },
                (error, stdout) => {
                    if (error || !stdout) {
                        resolve(undefined);
                        return;
                    }
                    const trimmed = stdout.trim();
                    resolve(trimmed.length > 0 ? trimmed : undefined);
                }
            );
        } catch {
            resolve(undefined);
        }
    });
}

function extractRepoNameFromUrl(urlStr: string): string | undefined {
    try {
        const parsed = new URL(urlStr);
        const segments = parsed.pathname.split("/").filter(Boolean);
        if (segments.length > 0) {
            const last = segments[segments.length - 1].replace(/\.git$/i, "");
            return last.length > 0 ? last : undefined;
        }
    } catch {
        // Fallback for non-standard URLs
    }
    return undefined;
}

/**
 * Safely inspects a directory for Git branch, repository name, and remote URL.
 * Runs non-blocking git commands with a short timeout (500ms).
 * Sanitizes any remote URLs to remove credentials.
 * Never throws; returns empty object on non-git directories or errors.
 */
export async function getGitInfo(dirPath: string): Promise<GitInfo> {
    if (!dirPath || typeof dirPath !== "string") {
        return {};
    }

    try {
        const [branchRaw, remoteRaw, topLevelRaw] = await Promise.all([
            execGit(["rev-parse", "--abbrev-ref", "HEAD"], dirPath),
            execGit(["config", "--get", "remote.origin.url"], dirPath),
            execGit(["rev-parse", "--show-toplevel"], dirPath)
        ]);

        const info: GitInfo = {};

        if (branchRaw) {
            info.branch = branchRaw;
        }

        if (remoteRaw) {
            const sanitized = sanitizeGitUrl(remoteRaw);
            if (sanitized) {
                info.remoteUrl = sanitized;
            }
        }

        // Determine repoName: prefer extracted name from remoteUrl, then fallback to git top-level directory
        if (info.remoteUrl) {
            const nameFromRemote = extractRepoNameFromUrl(info.remoteUrl);
            if (nameFromRemote) {
                info.repoName = nameFromRemote;
            }
        }

        if (!info.repoName && topLevelRaw) {
            const normalized = topLevelRaw.replace(/\\/g, "/");
            const base = path.basename(normalized);
            if (base) {
                info.repoName = base;
            }
        }

        return info;
    } catch {
        return {};
    }
}

import path from "node:path";
import {
    PresenceStatus,
    DEFAULT_CONFIG,
    DEFAULT_SUBAGENT_TTL_MS,
    type HookPayload,
    type PresenceActivity,
    type PluginConfig
} from "./types.js";
import { mapToolToAction, truncateRpcText, validateRpcButtonUrl } from "./sanitizer.js";
import { getGitInfo, type GitInfo } from "./git.js";

export const DEFAULT_WORKSPACE_KEY = "__default__";

export function normalizeWorkspaceKey(cwd: string): string {
    const resolved = path.resolve(cwd);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export interface PresenceStateMachineOptions {
    subagentTtlMs?: number;
    now?: () => number;
}

interface SessionState {
    conversationId: string;
    workspaceKey: string;
    isSubagent: boolean;
    status: PresenceStatus;
    toolName?: string;
    toolArgs?: Record<string, unknown>;
    updatedAt: number;
}

interface WorkspaceContext {
    key: string;
    cwd: string;
    gitInfo?: GitInfo;
    lastGitFetchTime: number;
    startTimestamp?: number;
    peakActiveAgents: number;
    updatedAt: number;
}

const STATUS_PRIORITY: Record<PresenceStatus, number> = {
    [PresenceStatus.EXECUTING_TOOL]: 4,
    [PresenceStatus.THINKING]: 3,
    [PresenceStatus.WAITING_REVIEW]: 2,
    [PresenceStatus.IDLE]: 1,
    [PresenceStatus.STOPPED]: 0
};

/**
 * Manages agent lifecycle presence states, workspace isolation, subagent arbitration,
 * idle timeouts, and Discord Rich Presence formatting.
 */
export class PresenceStateMachine {
    public readonly config: PluginConfig;
    private readonly subagentTtlMs: number;
    private readonly now: () => number;
    private readonly sessions = new Map<string, SessionState>();
    private readonly workspaces = new Map<string, WorkspaceContext>();

    private readonly largeImageKey = "antigravity";
    private readonly largeImageText = "Antigravity";

    constructor(config: PluginConfig = DEFAULT_CONFIG, options: PresenceStateMachineOptions = {}) {
        this.config = config;
        this.subagentTtlMs = options.subagentTtlMs ?? DEFAULT_SUBAGENT_TTL_MS;
        this.now = options.now ?? (() => Date.now());
    }

    private getWorkspaceStatus(workspaceKey: string): PresenceStatus {
        let bestStatus = PresenceStatus.STOPPED;
        let bestPriority = STATUS_PRIORITY[PresenceStatus.STOPPED];

        for (const session of this.sessions.values()) {
            if (session.workspaceKey !== workspaceKey) continue;
            const priority = STATUS_PRIORITY[session.status];
            if (priority > bestPriority) {
                bestPriority = priority;
                bestStatus = session.status;
            }
        }

        return bestStatus;
    }

    /**
     * Selects the active workspace with highest status precedence,
     * tie-broken by most recent workspace update timestamp.
     */
    private getWinningWorkspace(): { workspace: WorkspaceContext; status: PresenceStatus } | null {
        let bestWorkspace: WorkspaceContext | null = null;
        let bestStatus = PresenceStatus.STOPPED;
        let bestPriority = STATUS_PRIORITY[PresenceStatus.STOPPED];
        let bestUpdatedAt = -1;

        for (const workspace of this.workspaces.values()) {
            const status = this.getWorkspaceStatus(workspace.key);
            if (status === PresenceStatus.STOPPED) continue;

            const priority = STATUS_PRIORITY[status];
            if (
                priority > bestPriority ||
                (priority === bestPriority && workspace.updatedAt >= bestUpdatedAt)
            ) {
                bestWorkspace = workspace;
                bestStatus = status;
                bestPriority = priority;
                bestUpdatedAt = workspace.updatedAt;
            }
        }

        if (!bestWorkspace) {
            return null;
        }

        return { workspace: bestWorkspace, status: bestStatus };
    }

    /**
     * Prunes orphaned subagent sessions whose last activity exceeded subagentTtlMs.
     * Resets workspace timer/peak metrics if pruning leaves a workspace STOPPED.
     */
    public pruneStaleSubagents(now: number = this.now()): number {
        let prunedCount = 0;
        const affectedWorkspaces = new Set<string>();

        for (const [id, session] of this.sessions.entries()) {
            if (session.isSubagent && now - session.updatedAt >= this.subagentTtlMs) {
                this.sessions.delete(id);
                affectedWorkspaces.add(session.workspaceKey);
                prunedCount++;
            }
        }

        for (const workspaceKey of affectedWorkspaces) {
            const ws = this.workspaces.get(workspaceKey);
            if (ws && this.getWorkspaceStatus(workspaceKey) === PresenceStatus.STOPPED) {
                ws.startTimestamp = undefined;
                ws.peakActiveAgents = 0;
            }
        }

        return prunedCount;
    }

    /**
     * Returns milliseconds until the next active subagent expires, or null if none exist.
     */
    public getNextSubagentExpiryMs(now: number = this.now()): number | null {
        let minRemaining: number | null = null;

        for (const session of this.sessions.values()) {
            if (!session.isSubagent) continue;
            const remaining = Math.max(1, this.subagentTtlMs - (now - session.updatedAt));
            if (minRemaining === null || remaining < minRemaining) {
                minRemaining = remaining;
            }
        }

        return minRemaining;
    }

    /**
     * Determines the overall presence status across all tracked workspaces based on precedence:
     * EXECUTING_TOOL > THINKING > WAITING_REVIEW > IDLE > STOPPED
     */
    public getCurrentStatus(): PresenceStatus {
        this.pruneStaleSubagents(this.now());
        return this.getWinningWorkspace()?.status ?? PresenceStatus.STOPPED;
    }

    /**
     * Returns the count of currently active subagents (actively thinking or running tools).
     * When workspaceKey is provided, scopes to that workspace (plus unassigned default subagents).
     */
    public getActiveSubagentsCount(workspaceKey?: string): number {
        this.pruneStaleSubagents(this.now());
        let count = 0;
        for (const session of this.sessions.values()) {
            if (
                session.isSubagent &&
                (session.status === PresenceStatus.THINKING ||
                    session.status === PresenceStatus.EXECUTING_TOOL)
            ) {
                if (
                    workspaceKey === undefined ||
                    session.workspaceKey === workspaceKey ||
                    (workspaceKey !== DEFAULT_WORKSPACE_KEY &&
                        session.workspaceKey === DEFAULT_WORKSPACE_KEY)
                ) {
                    count++;
                }
            }
        }
        return count;
    }

    /**
     * Handles incoming Antigravity lifecycle hooks, updates workspace and session registries,
     * performs workspace and subagent arbitration, and generates updated presence activity.
     */
    public async handleHook(payload: HookPayload): Promise<PresenceActivity | null> {
        const convId = payload.conversationId || "default";
        const now = this.now();
        this.pruneStaleSubagents(now);

        let session = this.sessions.get(convId);
        const trimmedCwd = payload.cwd?.trim();
        let resolvedCwd: string | undefined;
        let targetWorkspaceKey: string;

        if (trimmedCwd) {
            resolvedCwd = path.resolve(trimmedCwd);
            targetWorkspaceKey = normalizeWorkspaceKey(resolvedCwd);
        } else if (session) {
            targetWorkspaceKey = session.workspaceKey;
        } else {
            targetWorkspaceKey = DEFAULT_WORKSPACE_KEY;
        }

        let workspace = this.workspaces.get(targetWorkspaceKey);
        if (!workspace) {
            workspace = {
                key: targetWorkspaceKey,
                cwd: resolvedCwd ?? process.cwd(),
                lastGitFetchTime: 0,
                peakActiveAgents: 0,
                updatedAt: now
            };
            this.workspaces.set(targetWorkspaceKey, workspace);
        } else {
            if (resolvedCwd) {
                workspace.cwd = resolvedCwd;
            }
            workspace.updatedAt = now;
        }

        // Cache git metadata for 5 seconds per workspace independently
        if (!workspace.gitInfo || now - workspace.lastGitFetchTime > 5000) {
            try {
                workspace.gitInfo = await getGitInfo(workspace.cwd);
            } catch {
                workspace.gitInfo = {};
            }
            workspace.lastGitFetchTime = now;
        }

        if (!session) {
            session = {
                conversationId: convId,
                workspaceKey: targetWorkspaceKey,
                isSubagent: payload.isSubagent ?? false,
                status: PresenceStatus.STOPPED,
                updatedAt: now
            };
            this.sessions.set(convId, session);
        } else {
            session.workspaceKey = targetWorkspaceKey;
            if (payload.isSubagent !== undefined) {
                session.isSubagent = payload.isSubagent;
            }
        }
        session.updatedAt = now;

        switch (payload.event) {
            case "SessionStart":
            case "PreInvocation": {
                session.status = PresenceStatus.THINKING;
                session.toolName = undefined;
                session.toolArgs = undefined;
                if (!workspace.startTimestamp) {
                    workspace.startTimestamp = now;
                }
                break;
            }

            case "PreToolUse": {
                session.status = PresenceStatus.EXECUTING_TOOL;
                session.toolName = payload.toolName;
                session.toolArgs = payload.toolArgs;
                if (!workspace.startTimestamp) {
                    workspace.startTimestamp = now;
                }
                break;
            }

            case "PostToolUse": {
                session.status = PresenceStatus.THINKING;
                session.toolName = undefined;
                session.toolArgs = undefined;
                break;
            }

            case "PostInvocation": {
                if (session.status !== PresenceStatus.EXECUTING_TOOL) {
                    if (session.isSubagent) {
                        session.status = PresenceStatus.STOPPED;
                    } else {
                        session.status = PresenceStatus.WAITING_REVIEW;
                    }
                }
                break;
            }

            case "Stop": {
                if (payload.terminationReason === "NO_TOOL_CALL") {
                    if (session.isSubagent) {
                        // Subagent completes its autonomous turn
                        session.status = PresenceStatus.STOPPED;
                    } else {
                        // Normal primary agent turn end -> waiting for user review
                        session.status = PresenceStatus.WAITING_REVIEW;
                    }
                } else {
                    // Explicit cancellation or abnormal session termination scoped to workspace
                    if (!session.isSubagent) {
                        for (const s of this.sessions.values()) {
                            if (s.workspaceKey === targetWorkspaceKey) {
                                s.status = PresenceStatus.STOPPED;
                            }
                        }
                    } else {
                        session.status = PresenceStatus.STOPPED;
                    }
                }
                break;
            }

            case "SessionEnd": {
                for (const s of this.sessions.values()) {
                    if (s.workspaceKey === targetWorkspaceKey) {
                        s.status = PresenceStatus.STOPPED;
                    }
                }
                break;
            }

            default:
                break;
        }

        const isTerminated = payload.event === "SessionEnd" || session.status === PresenceStatus.STOPPED;
        if ((payload.isSubagent || session.isSubagent) && (payload.event === "Stop" || isTerminated)) {
            this.sessions.delete(convId);
        }

        if (
            payload.event === "SessionEnd" ||
            (payload.event === "Stop" && payload.terminationReason !== "NO_TOOL_CALL" && !session.isSubagent)
        ) {
            for (const [id, s] of this.sessions.entries()) {
                if (
                    s.workspaceKey === targetWorkspaceKey &&
                    s.isSubagent &&
                    s.status === PresenceStatus.STOPPED
                ) {
                    this.sessions.delete(id);
                }
            }
        }

        for (const ws of this.workspaces.values()) {
            if (this.getWorkspaceStatus(ws.key) === PresenceStatus.STOPPED) {
                ws.startTimestamp = undefined;
                ws.peakActiveAgents = 0;
            }
        }

        return this.buildActivity();
    }

    /**
     * Handles 5-minute inactivity timeout, transitioning WAITING_REVIEW sessions to IDLE.
     */
    public handleIdleTimeout(): PresenceActivity | null {
        const now = this.now();
        this.pruneStaleSubagents(now);
        const current = this.getCurrentStatus();
        if (current === PresenceStatus.WAITING_REVIEW) {
            for (const session of this.sessions.values()) {
                if (session.status === PresenceStatus.WAITING_REVIEW) {
                    session.status = PresenceStatus.IDLE;
                }
            }
            return this.buildActivity();
        }

        if (current === PresenceStatus.IDLE) {
            return this.buildActivity();
        }

        if (current === PresenceStatus.STOPPED) {
            return null;
        }

        // Active tool execution or thinking does not transition to IDLE
        return this.buildActivity();
    }

    /**
     * Finds the session currently executing a tool in the given workspace, preferring the most recent.
     */
    private getExecutingSession(workspaceKey: string): SessionState | undefined {
        let latest: SessionState | undefined;
        for (const session of this.sessions.values()) {
            if (
                session.workspaceKey === workspaceKey &&
                session.status === PresenceStatus.EXECUTING_TOOL
            ) {
                if (!latest || session.updatedAt >= latest.updatedAt) {
                    latest = session;
                }
            }
        }
        return latest;
    }

    /**
     * Returns the currently active PresenceActivity payload, or null if stopped.
     */
    public getCurrentActivity(): PresenceActivity | null {
        this.pruneStaleSubagents(this.now());
        return this.buildActivity();
    }

    /**
     * Formats repository action buttons for Discord Rich Presence.
     * Enforces valid HTTP/HTTPS URL, max 512 URL length, max 32 label length, max 2 buttons.
     */
    private getButtons(workspace: WorkspaceContext): Array<{ label: string; url: string }> | undefined {
        if (this.config.showRepoButton && !this.config.privacyMode && workspace.gitInfo?.remoteUrl) {
            const validUrl = validateRpcButtonUrl(workspace.gitInfo.remoteUrl);
            const validLabel = truncateRpcText("View Repository", 32);
            if (validUrl && validLabel) {
                const buttons = [{ label: validLabel, url: validUrl }];
                return buttons.slice(0, 2);
            }
        }
        return undefined;
    }

    /**
     * Formats the Discord state string showing project and branch info for the winning workspace.
     * Truncates output to Discord's 128 character limit.
     */
    private formatState(workspace: WorkspaceContext, status: PresenceStatus): string | undefined {
        const repoName = workspace.gitInfo?.repoName || (workspace.cwd ? path.basename(workspace.cwd) : undefined);
        const branch = workspace.gitInfo?.branch;

        let rawState: string | undefined;

        if (status === PresenceStatus.IDLE) {
            if (repoName) {
                rawState = `Project: ${repoName}`;
            }
        } else if (repoName && branch) {
            rawState = `Project: ${repoName} (${branch})`;
        } else if (repoName) {
            rawState = `Project: ${repoName}`;
        } else if (branch) {
            rawState = `Branch: ${branch}`;
        }

        return truncateRpcText(rawState, 128);
    }

    /**
     * Constructs the full PresenceActivity payload for the winning workspace.
     */
    private buildActivity(): PresenceActivity | null {
        const winning = this.getWinningWorkspace();
        if (!winning) {
            return null;
        }

        const { workspace, status } = winning;
        if (!workspace.startTimestamp) {
            workspace.startTimestamp = this.now();
        }

        let details: string | undefined;
        let smallImageKey: string;
        let smallImageText: string;

        const subCount = this.getActiveSubagentsCount(workspace.key);

        switch (status) {
            case PresenceStatus.THINKING: {
                const subSuffix = subCount > 0 ? ` (${subCount} subagent${subCount > 1 ? "s" : ""} active)` : "";
                details = `Agent is thinking...${subSuffix}`;
                smallImageKey = "brain";
                smallImageText = "Thinking";
                break;
            }

            case PresenceStatus.EXECUTING_TOOL: {
                const activeSession = this.getExecutingSession(workspace.key);
                const action = mapToolToAction(
                    activeSession?.toolName || "",
                    activeSession?.toolArgs,
                    this.config.privacyMode
                );
                const isExecutingSubagent = activeSession?.isSubagent ?? false;
                const subSuffix =
                    (!isExecutingSubagent && subCount > 0) || (isExecutingSubagent && subCount > 1)
                        ? ` (${subCount} subagent${subCount > 1 ? "s" : ""} active)`
                        : "";
                const maxActionLen = Math.max(2, 128 - subSuffix.length);
                const truncatedAction = truncateRpcText(action, maxActionLen) || action;
                details = truncateRpcText(`${truncatedAction}${subSuffix}`, 128);
                smallImageKey = "gear";
                smallImageText = "Executing tool";
                break;
            }

            case PresenceStatus.WAITING_REVIEW: {
                details = "Waiting for user review";
                smallImageKey = "hourglass";
                smallImageText = "Waiting for review";
                break;
            }

            case PresenceStatus.IDLE: {
                details = "Idling in workspace";
                smallImageKey = "zzz";
                smallImageText = "Idle";
                break;
            }

            default:
                return null;
        }

        return {
            details: truncateRpcText(details, 128),
            state: this.formatState(workspace, status),
            startTimestamp: workspace.startTimestamp,
            largeImageKey: this.largeImageKey,
            largeImageText: truncateRpcText(this.largeImageText, 128),
            smallImageKey,
            smallImageText: truncateRpcText(smallImageText, 128),
            buttons: this.getButtons(workspace)
        };
    }
}

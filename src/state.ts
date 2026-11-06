import path from "node:path";
import {
    PresenceStatus,
    DEFAULT_CONFIG,
    type HookPayload,
    type PresenceActivity,
    type PluginConfig
} from "./types.js";
import { mapToolToAction } from "./sanitizer.js";
import { getGitInfo, type GitInfo } from "./git.js";

interface SessionState {
    conversationId: string;
    isSubagent: boolean;
    status: PresenceStatus;
    toolName?: string;
    toolArgs?: Record<string, unknown>;
    updatedAt: number;
}

/**
 * Manages agent lifecycle presence states, subagent arbitration,
 * idle timeouts, and Discord Rich Presence formatting.
 */
export class PresenceStateMachine {
    public readonly config: PluginConfig;
    private readonly sessions = new Map<string, SessionState>();
    private startTimestamp?: number;
    private cwd?: string;
    private gitInfo?: GitInfo;
    private lastGitCwd?: string;
    private lastGitFetchTime: number = 0;

    private readonly largeImageKey = "antigravity";
    private readonly largeImageText = "Antigravity";

    constructor(config: PluginConfig = DEFAULT_CONFIG) {
        this.config = config;
    }

    /**
     * Determines the overall presence status across all tracked sessions based on precedence:
     * EXECUTING_TOOL > THINKING > WAITING_REVIEW > IDLE > STOPPED
     * Stale sessions (>2 minutes inactive without updates) in THINKING/EXECUTING_TOOL
     * are demoted to WAITING_REVIEW so they do not block state progression.
     */
    public getCurrentStatus(now: number = Date.now()): PresenceStatus {
        let hasExecutingTool = false;
        let hasThinking = false;
        let hasWaitingReview = false;
        let hasIdle = false;

        const STALE_THRESHOLD_MS = 120_000; // 2 minutes

        for (const session of this.sessions.values()) {
            if (
                (session.status === PresenceStatus.EXECUTING_TOOL || session.status === PresenceStatus.THINKING) &&
                now - session.updatedAt > STALE_THRESHOLD_MS
            ) {
                session.status = PresenceStatus.WAITING_REVIEW;
            }

            switch (session.status) {
                case PresenceStatus.EXECUTING_TOOL:
                    hasExecutingTool = true;
                    break;
                case PresenceStatus.THINKING:
                    hasThinking = true;
                    break;
                case PresenceStatus.WAITING_REVIEW:
                    hasWaitingReview = true;
                    break;
                case PresenceStatus.IDLE:
                    hasIdle = true;
                    break;
            }
        }

        if (hasExecutingTool) return PresenceStatus.EXECUTING_TOOL;
        if (hasThinking) return PresenceStatus.THINKING;
        if (hasWaitingReview) return PresenceStatus.WAITING_REVIEW;
        if (hasIdle) return PresenceStatus.IDLE;
        return PresenceStatus.STOPPED;
    }

    /**
     * Returns the count of currently active subagents (actively thinking or running tools).
     */
    public getActiveSubagentsCount(now: number = Date.now()): number {
        let count = 0;
        const STALE_THRESHOLD_MS = 120_000;
        for (const session of this.sessions.values()) {
            if (
                session.isSubagent &&
                now - session.updatedAt <= STALE_THRESHOLD_MS &&
                (session.status === PresenceStatus.THINKING ||
                    session.status === PresenceStatus.EXECUTING_TOOL)
            ) {
                count++;
            }
        }
        return count;
    }

    /**
     * Handles incoming Antigravity lifecycle hooks, updates session registry,
     * performs subagent arbitration, and generates updated presence activity.
     */
    public async handleHook(payload: HookPayload): Promise<PresenceActivity | null> {
        const convId = payload.conversationId || "default";
        const now = Date.now();

        if (payload.cwd) {
            this.cwd = payload.cwd;
        }
        if (!this.cwd) {
            this.cwd = process.cwd();
        }

        // Cache git metadata for 5 seconds per working directory
        if (!this.gitInfo || this.cwd !== this.lastGitCwd || now - this.lastGitFetchTime > 5000) {
            try {
                this.gitInfo = await getGitInfo(this.cwd);
            } catch {
                this.gitInfo = {};
            }
            this.lastGitCwd = this.cwd;
            this.lastGitFetchTime = now;
        }

        let session = this.sessions.get(convId);
        if (!session) {
            session = {
                conversationId: convId,
                isSubagent: payload.isSubagent ?? false,
                status: PresenceStatus.STOPPED,
                updatedAt: now
            };
            this.sessions.set(convId, session);
        } else {
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
                if (!this.startTimestamp) {
                    this.startTimestamp = now;
                }
                break;
            }

            case "PreToolUse": {
                session.status = PresenceStatus.EXECUTING_TOOL;
                session.toolName = payload.toolName;
                session.toolArgs = payload.toolArgs;
                if (!this.startTimestamp) {
                    this.startTimestamp = now;
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
                if (payload.terminationReason === "USER_CANCELED") {
                    // Explicit user cancellation or termination -> clear presence
                    if (!session.isSubagent) {
                        for (const s of this.sessions.values()) {
                            s.status = PresenceStatus.STOPPED;
                        }
                    } else {
                        session.status = PresenceStatus.STOPPED;
                    }
                } else {
                    // Normal completion (NO_TOOL_CALL, omitted reason, MAX_INVOCATIONS, etc.)
                    if (session.isSubagent) {
                        // Subagent completes its autonomous turn
                        session.status = PresenceStatus.STOPPED;
                    } else {
                        // Normal primary agent turn end -> waiting for user review
                        session.status = PresenceStatus.WAITING_REVIEW;
                    }
                }
                break;
            }

            case "SessionEnd": {
                for (const s of this.sessions.values()) {
                    s.status = PresenceStatus.STOPPED;
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

        const currentStatus = this.getCurrentStatus();
        if (currentStatus === PresenceStatus.STOPPED) {
            this.startTimestamp = undefined;
            return null;
        }

        return this.buildActivity(currentStatus);
    }

    /**
     * Handles 5-minute inactivity timeout, transitioning WAITING_REVIEW sessions to IDLE.
     */
    public handleIdleTimeout(): PresenceActivity | null {
        const current = this.getCurrentStatus();
        if (current === PresenceStatus.WAITING_REVIEW) {
            for (const session of this.sessions.values()) {
                if (session.status === PresenceStatus.WAITING_REVIEW) {
                    session.status = PresenceStatus.IDLE;
                }
            }
            return this.buildActivity(PresenceStatus.IDLE);
        }

        if (current === PresenceStatus.IDLE) {
            return this.buildActivity(PresenceStatus.IDLE);
        }

        if (current === PresenceStatus.STOPPED) {
            return null;
        }

        // Active tool execution or thinking does not transition to IDLE
        return this.buildActivity(current);
    }

    /**
     * Finds the session currently executing a tool, preferring the most recent.
     */
    private getExecutingSession(): SessionState | undefined {
        let latest: SessionState | undefined;
        for (const session of this.sessions.values()) {
            if (session.status === PresenceStatus.EXECUTING_TOOL) {
                if (!latest || session.updatedAt >= latest.updatedAt) {
                    latest = session;
                }
            }
        }
        return latest;
    }

    /**
     * Formats repository action buttons for Discord Rich Presence.
     */
    private getButtons(): Array<{ label: string; url: string }> | undefined {
        if (this.config.showRepoButton && !this.config.privacyMode && this.gitInfo?.remoteUrl) {
            return [{ label: "View Repository", url: this.gitInfo.remoteUrl }];
        }
        return undefined;
    }

    /**
     * Formats the Discord state string showing project and branch info.
     */
    private formatState(status: PresenceStatus): string | undefined {
        const repoName = this.gitInfo?.repoName || (this.cwd ? path.basename(this.cwd) : undefined);
        const branch = this.gitInfo?.branch;

        if (status === PresenceStatus.IDLE) {
            if (repoName) {
                return `Project: ${repoName}`;
            }
            return undefined;
        }

        if (repoName && branch) {
            return `Project: ${repoName} (${branch})`;
        }
        if (repoName) {
            return `Project: ${repoName}`;
        }
        if (branch) {
            return `Branch: ${branch}`;
        }
        return undefined;
    }

    /**
     * Constructs the full PresenceActivity payload based on current status and active sessions.
     */
    private buildActivity(status: PresenceStatus): PresenceActivity | null {
        if (status === PresenceStatus.STOPPED) {
            return null;
        }

        if (!this.startTimestamp) {
            this.startTimestamp = Date.now();
        }

        let details: string;
        let smallImageKey: string;
        let smallImageText: string;

        const subCount = this.getActiveSubagentsCount();

        switch (status) {
            case PresenceStatus.THINKING: {
                const subSuffix = subCount > 0 ? ` (${subCount} subagent${subCount > 1 ? "s" : ""} active)` : "";
                details = `Agent is thinking...${subSuffix}`;
                smallImageKey = "brain";
                smallImageText = "Thinking";
                break;
            }

            case PresenceStatus.EXECUTING_TOOL: {
                const activeSession = this.getExecutingSession();
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
                details = `${action}${subSuffix}`;
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
            details,
            state: this.formatState(status),
            startTimestamp: this.startTimestamp,
            largeImageKey: this.largeImageKey,
            largeImageText: this.largeImageText,
            smallImageKey,
            smallImageText,
            buttons: this.getButtons()
        };
    }
}

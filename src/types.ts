export interface HookPayload {
    event: string;
    conversationId?: string;
    isSubagent?: boolean;
    toolName?: string;
    toolArgs?: Record<string, unknown>;
    terminationReason?: string;
    cwd?: string;
}

export enum PresenceStatus {
    THINKING = "THINKING",
    EXECUTING_TOOL = "EXECUTING_TOOL",
    WAITING_REVIEW = "WAITING_REVIEW",
    IDLE = "IDLE",
    STOPPED = "STOPPED"
}

export interface PresenceActivity {
    details?: string;
    state?: string;
    startTimestamp?: number;
    largeImageKey?: string;
    largeImageText?: string;
    smallImageKey?: string;
    smallImageText?: string;
    buttons?: Array<{ label: string; url: string }>;
}

export interface PluginConfig {
    clientId: string;
    privacyMode: boolean;
    idleTimeoutSeconds: number;
    showRepoButton: boolean;
}

export const DEFAULT_CONFIG: PluginConfig = {
    clientId: "1441771215290372156",
    privacyMode: false,
    idleTimeoutSeconds: 300,
    showRepoButton: true
};

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
    if (raw === undefined) {
        return fallback;
    }
    const trimmed = raw.trim().toLowerCase();
    if (trimmed === "true" || trimmed === "1") {
        return true;
    }
    if (trimmed === "false" || trimmed === "0") {
        return false;
    }
    return fallback;
}

/**
 * Loads PluginConfig from environment variables (AGY_DISCORD_*), safely falling back
 * to DEFAULT_CONFIG values when variables are unset, empty, or invalid.
 */
export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PluginConfig {
    let clientId = DEFAULT_CONFIG.clientId;
    if (env.AGY_DISCORD_CLIENT_ID) {
        const trimmed = env.AGY_DISCORD_CLIENT_ID.trim();
        if (trimmed.length > 0) {
            clientId = trimmed;
        }
    }

    let idleTimeoutSeconds = DEFAULT_CONFIG.idleTimeoutSeconds;
    if (env.AGY_DISCORD_IDLE_TIMEOUT) {
        const parsed = Number.parseInt(env.AGY_DISCORD_IDLE_TIMEOUT.trim(), 10);
        if (Number.isFinite(parsed) && parsed > 0) {
            idleTimeoutSeconds = parsed;
        }
    }

    return {
        clientId,
        privacyMode: parseBoolean(env.AGY_DISCORD_PRIVACY_MODE, DEFAULT_CONFIG.privacyMode),
        idleTimeoutSeconds,
        showRepoButton: parseBoolean(env.AGY_DISCORD_SHOW_REPO_BUTTON, DEFAULT_CONFIG.showRepoButton)
    };
}

/**
 * Loads watchdog timeout in milliseconds from AGY_DISCORD_WATCHDOG_TIMEOUT (specified in seconds).
 * Defaults to 1,800,000 ms (30 minutes).
 */
export function loadWatchdogTimeoutMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
    const raw = env.AGY_DISCORD_WATCHDOG_TIMEOUT?.trim();
    if (raw) {
        const parsed = Number.parseInt(raw, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
            return parsed * 1000;
        }
    }
    return 1_800_000;
}

/**
 * Encodes an initial HookPayload into a base64-encoded JSON string for safe transmission via env vars.
 */
export function encodeInitialPayload(payload: HookPayload): string {
    return Buffer.from(JSON.stringify(payload), "utf-8").toString("base64");
}

/**
 * Defensively decodes a base64-encoded initial HookPayload string.
 * Returns null if raw is undefined, invalid base64/JSON, or missing required 'event' string property.
 */
export function decodeInitialPayload(raw: string | undefined): HookPayload | null {
    if (!raw || typeof raw !== "string") {
        return null;
    }
    try {
        const decoded = Buffer.from(raw, "base64").toString("utf-8");
        const parsed = JSON.parse(decoded);
        if (parsed && typeof parsed === "object" && typeof parsed.event === "string") {
            return parsed as HookPayload;
        }
        return null;
    } catch {
        return null;
    }
}


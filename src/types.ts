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
    party?: { id: string; size: [number, number] };
}

export type PrivacyProfile = "stealth" | "balanced" | "showcase";

export interface PluginConfig {
    clientId: string;
    privacyMode: boolean;
    privacyProfile: PrivacyProfile;
    idleTimeoutSeconds: number;
    showRepoButton: boolean;
}

export const DEFAULT_CONFIG: PluginConfig = {
    clientId: "1441771215290372156",
    privacyMode: false,
    privacyProfile: "balanced",
    idleTimeoutSeconds: 300,
    showRepoButton: true
};

/**
 * Parses a raw privacy profile string into a canonical PrivacyProfile, or undefined if invalid.
 */
export function parsePrivacyProfile(raw: string | undefined): PrivacyProfile | undefined {
    if (!raw || typeof raw !== "string") {
        return undefined;
    }
    const normalized = raw.trim().toLowerCase();
    if (normalized === "stealth" || normalized === "balanced" || normalized === "showcase") {
        return normalized;
    }
    return undefined;
}

/**
 * Resolves the effective PrivacyProfile from a PluginConfig, preserving backward compatibility
 * where legacy `privacyMode: true` maps to `"stealth"`.
 */
export function resolveEffectivePrivacyProfile(
    config: Pick<PluginConfig, "privacyMode" | "privacyProfile">
): PrivacyProfile {
    if (config.privacyMode === true) {
        return "stealth";
    }
    return parsePrivacyProfile(config.privacyProfile) ?? DEFAULT_CONFIG.privacyProfile;
}

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

    const explicitProfile = parsePrivacyProfile(env.AGY_DISCORD_PRIVACY_PROFILE);
    let privacyMode: boolean;
    let privacyProfile: PrivacyProfile;

    if (explicitProfile) {
        privacyProfile = explicitProfile;
        privacyMode = explicitProfile === "stealth";
    } else {
        privacyMode = parseBoolean(env.AGY_DISCORD_PRIVACY_MODE, DEFAULT_CONFIG.privacyMode);
        privacyProfile = privacyMode ? "stealth" : DEFAULT_CONFIG.privacyProfile;
    }

    return {
        clientId,
        privacyMode,
        privacyProfile,
        idleTimeoutSeconds,
        showRepoButton: parseBoolean(env.AGY_DISCORD_SHOW_REPO_BUTTON, DEFAULT_CONFIG.showRepoButton)
    };
}

export const DEFAULT_SUBAGENT_TTL_MS = 600_000;

function parsePositiveSecondsMs(raw: string | undefined, fallbackMs: number): number {
    const trimmed = raw?.trim();
    if (trimmed && /^\d+$/.test(trimmed)) {
        const parsed = Number.parseInt(trimmed, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
            return parsed * 1000;
        }
    }
    return fallbackMs;
}

/**
 * Loads watchdog timeout in milliseconds from AGY_DISCORD_WATCHDOG_TIMEOUT (specified in seconds).
 * Defaults to 1,800,000 ms (30 minutes).
 */
export function loadWatchdogTimeoutMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
    return parsePositiveSecondsMs(env.AGY_DISCORD_WATCHDOG_TIMEOUT, 1_800_000);
}

/**
 * Loads subagent TTL in milliseconds from AGY_DISCORD_SUBAGENT_TTL (specified in seconds).
 * Defaults to DEFAULT_SUBAGENT_TTL_MS (600,000 ms / 10 minutes).
 */
export function loadSubagentTtlMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
    return parsePositiveSecondsMs(env.AGY_DISCORD_SUBAGENT_TTL, DEFAULT_SUBAGENT_TTL_MS);
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


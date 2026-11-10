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
    clientId: "1568484776703299726",
    privacyMode: false,
    idleTimeoutSeconds: 300,
    showRepoButton: true
};

export function resolveConfig(
    customConfig?: Partial<PluginConfig>,
    env: NodeJS.ProcessEnv = process.env
): PluginConfig {
    return {
        clientId: env.AGY_DISCORD_CLIENT_ID || customConfig?.clientId || DEFAULT_CONFIG.clientId,
        privacyMode:
            env.AGY_DISCORD_PRIVACY_MODE !== undefined
                ? env.AGY_DISCORD_PRIVACY_MODE === "true" || env.AGY_DISCORD_PRIVACY_MODE === "1"
                : (customConfig?.privacyMode ?? DEFAULT_CONFIG.privacyMode),
        idleTimeoutSeconds:
            env.AGY_DISCORD_IDLE_TIMEOUT && !Number.isNaN(Number(env.AGY_DISCORD_IDLE_TIMEOUT))
                ? Number(env.AGY_DISCORD_IDLE_TIMEOUT)
                : (customConfig?.idleTimeoutSeconds ?? DEFAULT_CONFIG.idleTimeoutSeconds),
        showRepoButton:
            env.AGY_DISCORD_SHOW_REPO_BUTTON !== undefined
                ? env.AGY_DISCORD_SHOW_REPO_BUTTON === "true" || env.AGY_DISCORD_SHOW_REPO_BUTTON === "1"
                : (customConfig?.showRepoButton ?? DEFAULT_CONFIG.showRepoButton)
    };
}

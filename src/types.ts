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

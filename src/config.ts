import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    DEFAULT_CONFIG,
    DEFAULT_SUBAGENT_TTL_MS,
    parsePrivacyProfile,
    type PluginConfig
} from "./types.js";

const DEFAULT_WATCHDOG_TIMEOUT_MS = 1_800_000;

export interface ConfigOverrides extends Partial<PluginConfig> {
    watchdogTimeoutSeconds?: number;
    subagentTtlSeconds?: number;
}

export interface LoadedDaemonConfig {
    config: PluginConfig;
    globalConfig: Partial<PluginConfig>;
    envOverrides: Partial<PluginConfig>;
    watchdogMs: number;
    subagentTtlMs: number;
}

/**
 * Returns the global user configuration file path (~/.gemini/antigravity-discord-rpc.json).
 */
export function getGlobalConfigPath(homedir: string = os.homedir()): string {
    return path.join(homedir, ".gemini", "antigravity-discord-rpc.json");
}

/**
 * Returns the workspace-scoped configuration file path (<cwd>/.agents/discord-rpc.json).
 */
export function getWorkspaceConfigPath(cwd: string): string {
    return path.join(path.resolve(cwd), ".agents", "discord-rpc.json");
}

function normalizePrivacyLayer(
    target: ConfigOverrides,
    rawProfile: unknown,
    rawPrivacyMode: unknown
): void {
    const profile = typeof rawProfile === "string" ? parsePrivacyProfile(rawProfile) : undefined;
    if (profile) {
        target.privacyProfile = profile;
        target.privacyMode = profile === "stealth";
        return;
    }

    if (typeof rawPrivacyMode === "boolean") {
        target.privacyMode = rawPrivacyMode;
        target.privacyProfile = rawPrivacyMode ? "stealth" : "balanced";
    }
}

function parseOptionalBoolean(raw: string | undefined): boolean | undefined {
    if (raw === undefined) {
        return undefined;
    }
    const trimmed = raw.trim().toLowerCase();
    if (trimmed === "true" || trimmed === "1") {
        return true;
    }
    if (trimmed === "false" || trimmed === "0") {
        return false;
    }
    return undefined;
}

function parseOptionalPositiveInt(raw: string | undefined): number | undefined {
    const trimmed = raw?.trim();
    if (trimmed && /^\d+$/.test(trimmed)) {
        const parsed = Number.parseInt(trimmed, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
            return parsed;
        }
    }
    return undefined;
}

/**
 * Reads and validates an optional JSON config file.
 * Returns {} safely if the file does not exist, is unreadable, or contains invalid JSON.
 */
export function loadConfigFile(filePath: string): ConfigOverrides {
    try {
        const raw = fs.readFileSync(filePath, "utf-8");
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return {};
        }

        const data = parsed as Record<string, unknown>;
        const overrides: ConfigOverrides = {};

        if (typeof data.clientId === "string" && data.clientId.trim().length > 0) {
            overrides.clientId = data.clientId.trim();
        }

        normalizePrivacyLayer(overrides, data.privacyProfile, data.privacyMode);

        if (
            typeof data.idleTimeoutSeconds === "number" &&
            Number.isFinite(data.idleTimeoutSeconds) &&
            data.idleTimeoutSeconds > 0
        ) {
            overrides.idleTimeoutSeconds = data.idleTimeoutSeconds;
        }

        if (typeof data.showRepoButton === "boolean") {
            overrides.showRepoButton = data.showRepoButton;
        }

        if (
            typeof data.watchdogTimeoutSeconds === "number" &&
            Number.isInteger(data.watchdogTimeoutSeconds) &&
            data.watchdogTimeoutSeconds > 0
        ) {
            overrides.watchdogTimeoutSeconds = data.watchdogTimeoutSeconds;
        }

        if (
            typeof data.subagentTtlSeconds === "number" &&
            Number.isInteger(data.subagentTtlSeconds) &&
            data.subagentTtlSeconds > 0
        ) {
            overrides.subagentTtlSeconds = data.subagentTtlSeconds;
        }

        return overrides;
    } catch {
        return {};
    }
}

/**
 * Extracts only explicitly and validly configured AGY_DISCORD_* overrides from an environment map.
 */
export function parseConfigOverridesFromEnv(env: NodeJS.ProcessEnv = process.env): ConfigOverrides {
    const overrides: ConfigOverrides = {};

    if (env.AGY_DISCORD_CLIENT_ID) {
        const trimmed = env.AGY_DISCORD_CLIENT_ID.trim();
        if (trimmed.length > 0) {
            overrides.clientId = trimmed;
        }
    }

    const privacyMode = parseOptionalBoolean(env.AGY_DISCORD_PRIVACY_MODE);
    normalizePrivacyLayer(overrides, env.AGY_DISCORD_PRIVACY_PROFILE, privacyMode);

    const idleTimeoutSeconds = parseOptionalPositiveInt(env.AGY_DISCORD_IDLE_TIMEOUT);
    if (idleTimeoutSeconds !== undefined) {
        overrides.idleTimeoutSeconds = idleTimeoutSeconds;
    }

    const showRepoButton = parseOptionalBoolean(env.AGY_DISCORD_SHOW_REPO_BUTTON);
    if (showRepoButton !== undefined) {
        overrides.showRepoButton = showRepoButton;
    }

    const watchdogTimeoutSeconds = parseOptionalPositiveInt(env.AGY_DISCORD_WATCHDOG_TIMEOUT);
    if (watchdogTimeoutSeconds !== undefined) {
        overrides.watchdogTimeoutSeconds = watchdogTimeoutSeconds;
    }

    const subagentTtlSeconds = parseOptionalPositiveInt(env.AGY_DISCORD_SUBAGENT_TTL);
    if (subagentTtlSeconds !== undefined) {
        overrides.subagentTtlSeconds = subagentTtlSeconds;
    }

    return overrides;
}

/**
 * Filters config overrides to fields allowed at the workspace (.agents/discord-rpc.json) scope.
 */
export function toWorkspaceOverrides(overrides: ConfigOverrides): Partial<PluginConfig> {
    const result: Partial<PluginConfig> = {};
    if (overrides.privacyProfile !== undefined) {
        result.privacyProfile = overrides.privacyProfile;
    }
    if (overrides.privacyMode !== undefined) {
        result.privacyMode = overrides.privacyMode;
    }
    if (overrides.idleTimeoutSeconds !== undefined) {
        result.idleTimeoutSeconds = overrides.idleTimeoutSeconds;
    }
    if (overrides.showRepoButton !== undefined) {
        result.showRepoButton = overrides.showRepoButton;
    }
    return result;
}

function toPluginOverrides(overrides: ConfigOverrides): Partial<PluginConfig> {
    const result = toWorkspaceOverrides(overrides);
    if (overrides.clientId !== undefined) {
        result.clientId = overrides.clientId;
    }
    return result;
}

/**
 * Loads daemon-level configuration by merging Env Vars > Global Config > DEFAULT_CONFIG.
 */
export function loadDaemonConfig(
    options: { env?: NodeJS.ProcessEnv; globalConfigPath?: string } = {}
): LoadedDaemonConfig {
    const env = options.env ?? process.env;
    const globalPath = options.globalConfigPath ?? getGlobalConfigPath();

    const globalRaw = loadConfigFile(globalPath);
    const envRaw = parseConfigOverridesFromEnv(env);

    const globalConfig = toPluginOverrides(globalRaw);
    const envOverrides = toPluginOverrides(envRaw);

    const config: PluginConfig = {
        ...DEFAULT_CONFIG,
        ...globalConfig,
        ...envOverrides
    };

    const watchdogSeconds = envRaw.watchdogTimeoutSeconds ?? globalRaw.watchdogTimeoutSeconds;
    const subagentTtlSeconds = envRaw.subagentTtlSeconds ?? globalRaw.subagentTtlSeconds;

    return {
        config,
        globalConfig,
        envOverrides,
        watchdogMs: watchdogSeconds !== undefined ? watchdogSeconds * 1000 : DEFAULT_WATCHDOG_TIMEOUT_MS,
        subagentTtlMs: subagentTtlSeconds !== undefined ? subagentTtlSeconds * 1000 : DEFAULT_SUBAGENT_TTL_MS
    };
}

/**
 * Resolves effective PluginConfig for a specific workspace cwd using:
 * Env Overrides > Workspace Config > Base (Global/Default) Config.
 */
export function resolveWorkspaceConfig(params: {
    baseConfig: PluginConfig;
    cwd?: string;
    envOverrides?: Partial<PluginConfig>;
    enableWorkspaceConfig?: boolean;
}): PluginConfig {
    const { baseConfig, cwd, envOverrides, enableWorkspaceConfig = true } = params;
    const workspaceRaw =
        enableWorkspaceConfig && cwd ? loadConfigFile(getWorkspaceConfigPath(cwd)) : {};
    const workspaceOverrides = toWorkspaceOverrides(workspaceRaw);

    return {
        ...baseConfig,
        ...workspaceOverrides,
        ...(envOverrides ?? {})
    };
}

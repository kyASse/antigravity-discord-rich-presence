import fs from "node:fs";
import { Client } from "@xhayper/discord-rpc";
import { PresenceStateMachine } from "./state.js";
import { IpcServer } from "./ipc.js";
import {
    DEFAULT_CONFIG,
    PresenceStatus,
    resolveConfig,
    type HookPayload,
    type PresenceActivity,
    type PluginConfig
} from "./types.js";

export interface DaemonOptions {
    ipcPath?: string;
    throttleMs?: number;
    rpcClient?: Client;
}

/**
 * Background daemon that orchestrates:
 * 1. The local IPC server listening for Antigravity hook events.
 * 2. The Discord RPC client (@xhayper/discord-rpc) connection with auto-reconnection.
 * 3. The PresenceStateMachine for subagent arbitration and status mapping.
 * 4. Presence update rate limiting (2000ms throttle per Discord guidelines).
 * 5. Inactivity idle countdown timer (default 5 minutes).
 */
export class RpcDaemon {
    public readonly config: PluginConfig;
    public readonly stateMachine: PresenceStateMachine;
    public readonly ipcServer: IpcServer;
    private readonly throttleMs: number;
    private readonly isCustomClient: boolean;
    private rpcClient: Client;
    private _isConnected = false;
    private isConnecting = false;
    private isStopping = false;

    private lastUpdateTime = 0;
    private throttleTimer: NodeJS.Timeout | null = null;
    private pendingActivity: PresenceActivity | null | undefined = undefined;
    private lastSentActivity: PresenceActivity | null = null;

    private idleTimer: NodeJS.Timeout | null = null;
    private reconnectTimer: NodeJS.Timeout | null = null;

    constructor(config: PluginConfig = DEFAULT_CONFIG, options: DaemonOptions = {}) {
        this.config = config;
        this.stateMachine = new PresenceStateMachine(this.config);
        this.ipcServer = new IpcServer(options.ipcPath);
        this.throttleMs = options.throttleMs ?? 2000;
        this.isCustomClient = Boolean(options.rpcClient);
        this.rpcClient = options.rpcClient ?? new Client({ clientId: this.config.clientId });

        this.setupRpcClientEvents();
    }

    public get isConnected(): boolean {
        return this._isConnected;
    }

    private setupRpcClientEvents(): void {
        if (!this.rpcClient) return;

        if (typeof (this.rpcClient as any).on === "function") {
            (this.rpcClient as any).on("ready", () => {
                this._isConnected = true;
            });
            (this.rpcClient as any).on("connected", () => {
                this._isConnected = true;
            });
            (this.rpcClient as any).on("disconnected", () => {
                this._isConnected = false;
            });
            (this.rpcClient as any).on("error", () => {
                this._isConnected = false;
            });
        }

        // Catch low-level transport errors to prevent unhandled node exceptions
        if (this.rpcClient.transport && typeof (this.rpcClient.transport as any).on === "function") {
            (this.rpcClient.transport as any).on("error", () => {
                this._isConnected = false;
            });
            (this.rpcClient.transport as any).on("close", () => {
                this._isConnected = false;
            });
        }
    }

    /**
     * Connects to local Discord RPC socket defensively.
     * Recreates the client instance if disconnected to avoid stale/destroyed sockets in @xhayper/discord-rpc.
     */
    private async connectDiscord(): Promise<void> {
        if (this._isConnected || this.isConnecting || this.isStopping) return;
        this.isConnecting = true;
        try {
            if (!this.isCustomClient) {
                if (this.rpcClient) {
                    try {
                        await this.rpcClient.destroy();
                    } catch {
                        // ignore
                    }
                }
                this.rpcClient = new Client({ clientId: this.config.clientId });
                this.setupRpcClientEvents();
            }
            await this.rpcClient.login();
            this._isConnected = true;
        } catch {
            this._isConnected = false;
        } finally {
            this.isConnecting = false;
        }
    }

    /**
     * Starts the IPC server, connects to Discord RPC, and activates auto-reconnection loop.
     */
    public async start(): Promise<void> {
        this.isStopping = false;
        this.ipcServer.onMessage = async (payload: HookPayload) => {
            await this.handlePayload(payload);
        };

        await this.ipcServer.start();
        await this.connectDiscord();
        this.startReconnectLoop();
    }

    /**
     * Gracefully stops the daemon, clears Discord Rich Presence, and shuts down IPC.
     */
    public async stop(): Promise<void> {
        this.isStopping = true;
        this.stopReconnectLoop();
        this.clearIdleTimer();
        this.clearThrottleTimer();

        if (this._isConnected && this.rpcClient.user?.clearActivity) {
            try {
                await this.rpcClient.user.clearActivity();
            } catch {
                // ignore
            }
        }

        if (this.rpcClient.destroy) {
            try {
                await this.rpcClient.destroy();
            } catch {
                // ignore
            }
        }
        this._isConnected = false;

        await this.ipcServer.stop();
    }

    /**
     * Processes an incoming Antigravity lifecycle hook event.
     */
    public async handlePayload(payload: HookPayload): Promise<void> {
        // Clear idle countdown if active work has resumed
        if (payload.event === "PreInvocation" || payload.event === "PreToolUse") {
            this.clearIdleTimer();
        }

        const activity = await this.stateMachine.handleHook(payload);

        const currentStatus = this.stateMachine.getCurrentStatus();

        if (currentStatus === PresenceStatus.WAITING_REVIEW) {
            this.resetIdleTimer();
        } else if (currentStatus === PresenceStatus.STOPPED) {
            this.clearIdleTimer();
        }

        this.schedulePresenceUpdate(activity);
    }

    /**
     * Schedules a throttled presence update to Discord to adhere to the 2-second rate limit.
     * Transitions to WAITING_REVIEW, IDLE, or STOPPED are treated as priority and flush immediately.
     */
    private schedulePresenceUpdate(activity: PresenceActivity | null): void {
        const now = Date.now();
        const elapsed = now - this.lastUpdateTime;

        const isPriorityState = activity === null ||
            activity.smallImageKey === "hourglass" ||
            activity.smallImageKey === "zzz";

        if (this.throttleMs === 0 || isPriorityState || (elapsed >= this.throttleMs && !this.throttleTimer)) {
            if (this.throttleTimer) {
                clearTimeout(this.throttleTimer);
                this.throttleTimer = null;
            }
            this.pendingActivity = undefined;
            this.lastUpdateTime = now;
            this.sendPresenceToDiscord(activity).catch(() => {});
            return;
        }

        this.pendingActivity = activity;
        if (!this.throttleTimer) {
            const delay = Math.max(0, this.throttleMs - elapsed);
            this.throttleTimer = setTimeout(() => {
                this.throttleTimer = null;
                if (this.pendingActivity !== undefined) {
                    const act = this.pendingActivity;
                    this.pendingActivity = undefined;
                    this.lastUpdateTime = Date.now();
                    this.sendPresenceToDiscord(act).catch(() => {});
                }
            }, delay);
        }
    }

    /**
     * Sends the formatted presence payload to Discord RPC client.
     */
    private async sendPresenceToDiscord(activity: PresenceActivity | null): Promise<void> {
        if (!this._isConnected) {
            await this.connectDiscord();
            if (!this._isConnected) return;
        }

        try {
            if (activity === null) {
                this.lastSentActivity = null;
                if (this.rpcClient.user?.clearActivity) {
                    await this.rpcClient.user.clearActivity();
                }
            } else if (this.rpcClient.user?.setActivity) {
                const presencePayload: any = {
                    details: activity.details,
                    state: activity.state,
                    startTimestamp: activity.startTimestamp,
                    largeImageKey: activity.largeImageKey,
                    largeImageText: activity.largeImageText,
                    smallImageKey: activity.smallImageKey,
                    smallImageText: activity.smallImageText
                };

                if (activity.buttons && activity.buttons.length > 0) {
                    presencePayload.buttons = activity.buttons;
                }

                await this.rpcClient.user.setActivity(presencePayload);
                this.lastSentActivity = activity;
            }
        } catch {
            this._isConnected = false;
        }
    }

    /**
     * Background reconnect loop periodically checks Discord availability if disconnected.
     */
    private startReconnectLoop(): void {
        this.stopReconnectLoop();
        this.reconnectTimer = setInterval(async () => {
            if (this.isStopping) return;
            if (!this._isConnected) {
                await this.connectDiscord();
                if (this._isConnected) {
                    const activityToRestore = this.lastSentActivity ?? this.pendingActivity;
                    if (activityToRestore) {
                        await this.sendPresenceToDiscord(activityToRestore);
                    }
                }
            }
        }, 5000);

        if (this.reconnectTimer && typeof this.reconnectTimer.unref === "function") {
            this.reconnectTimer.unref();
        }
    }

    private stopReconnectLoop(): void {
        if (this.reconnectTimer) {
            clearInterval(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    private resetIdleTimer(): void {
        this.clearIdleTimer();
        const ms = Math.max(10, (this.config.idleTimeoutSeconds ?? 300) * 1000);
        this.idleTimer = setTimeout(() => {
            try {
                const idleActivity = this.stateMachine.handleIdleTimeout();
                if (idleActivity) {
                    this.schedulePresenceUpdate(idleActivity);
                }
            } catch {
                // ignore
            }
        }, ms);
    }

    private clearIdleTimer(): void {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
    }

    private clearThrottleTimer(): void {
        if (this.throttleTimer) {
            clearTimeout(this.throttleTimer);
            this.throttleTimer = null;
        }
        this.pendingActivity = undefined;
    }
}

// Standalone entry execution support when launched directly
const isDirectRun = Boolean(
    process.argv[1] &&
    (process.argv[1].endsWith("daemon.js") || process.argv[1].endsWith("daemon.ts")) &&
    !process.argv[1].includes("test")
);

if (isDirectRun) {
    const config = resolveConfig();
    const daemon = new RpcDaemon(config);
    daemon.start().catch((err) => {
        console.error("Failed to start RPC daemon:", err);
        process.exit(1);
    });

    let isShuttingDown = false;
    const shutdown = async () => {
        if (isShuttingDown) return;
        isShuttingDown = true;
        await daemon.stop();
        process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

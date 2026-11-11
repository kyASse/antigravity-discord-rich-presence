import { Client } from "@xhayper/discord-rpc";
import { PresenceStateMachine } from "./state.js";
import { IpcServer } from "./ipc.js";
import {
    DEFAULT_CONFIG,
    loadConfigFromEnv,
    loadWatchdogTimeoutMsFromEnv,
    PresenceStatus,
    decodeInitialPayload,
    type HookPayload,
    type PresenceActivity,
    type PluginConfig
} from "./types.js";

export interface DaemonOptions {
    ipcPath?: string;
    throttleMs?: number;
    rpcClient?: Client;
    clientFactory?: () => Client;
    reconnectBaseMs?: number;
    reconnectMaxMs?: number;
    watchdogMs?: number;
    activeWatchdogMs?: number;
    onWatchdogExit?: () => void;
}

/**
 * Background daemon that orchestrates:
 * 1. The local IPC server listening for Antigravity hook events.
 * 2. The Discord RPC client (@xhayper/discord-rpc) connection with auto-reconnection.
 * 3. The PresenceStateMachine for subagent arbitration and status mapping.
 * 4. Presence update rate limiting (2000ms throttle per Discord guidelines).
 * 5. Inactivity idle countdown timer (default 5 minutes).
 * 6. 2-tier inactivity watchdog auto-shutdown.
 */
export class RpcDaemon {
    public readonly config: PluginConfig;
    public readonly stateMachine: PresenceStateMachine;
    public readonly ipcServer: IpcServer;
    private readonly throttleMs: number;
    private readonly reconnectBaseMs: number;
    private readonly reconnectMaxMs: number;
    private readonly watchdogMs: number;
    private readonly activeWatchdogMs: number;
    private readonly onWatchdogExit?: () => void;
    private readonly clientFactory?: () => Client;
    private readonly hasCustomClient: boolean;

    private rpcClient: Client;
    private _isConnected = false;
    private isConnecting = false;
    private isStopping = false;

    private lastUpdateTime = 0;
    private throttleTimer: NodeJS.Timeout | null = null;
    private pendingActivity: PresenceActivity | null | undefined = undefined;

    private idleTimer: NodeJS.Timeout | null = null;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private reconnectAttempt = 0;

    private watchdogTimer: NodeJS.Timeout | null = null;
    private lastSentSignature: string | undefined = undefined;

    constructor(config: PluginConfig = DEFAULT_CONFIG, options: DaemonOptions = {}) {
        this.config = config;
        this.stateMachine = new PresenceStateMachine(this.config);
        this.ipcServer = new IpcServer(options.ipcPath);
        this.throttleMs = options.throttleMs ?? 2000;
        this.reconnectBaseMs = options.reconnectBaseMs ?? 2000;
        this.reconnectMaxMs = options.reconnectMaxMs ?? 30_000;
        this.watchdogMs = options.watchdogMs ?? 1_800_000;
        this.activeWatchdogMs = options.activeWatchdogMs ?? 14_400_000;
        this.onWatchdogExit = options.onWatchdogExit;
        this.clientFactory = options.clientFactory;
        this.hasCustomClient = Boolean(options.rpcClient);
        this.rpcClient = options.rpcClient ?? this.createNewClient();

        this.setupRpcClientEvents();
    }

    public get isConnected(): boolean {
        return this._isConnected;
    }

    private createNewClient(): Client {
        if (this.clientFactory) {
            return this.clientFactory();
        }
        return new Client({ clientId: this.config.clientId });
    }

    private detachRpcClientEvents(client?: Client): void {
        if (!client) return;

        try {
            if (typeof (client as any).removeAllListeners === "function") {
                (client as any).removeAllListeners();
            }
            if (typeof (client as any).on === "function") {
                (client as any).on("error", () => {});
            }
        } catch {
            // ignore
        }

        try {
            if (client.transport) {
                if (typeof (client.transport as any).removeAllListeners === "function") {
                    (client.transport as any).removeAllListeners();
                }
                if (typeof (client.transport as any).on === "function") {
                    (client.transport as any).on("error", () => {});
                }
            }
        } catch {
            // ignore
        }
    }

    private setupRpcClientEvents(): void {
        if (!this.rpcClient) return;

        const client = this.rpcClient;

        const onConnect = () => {
            if (this.rpcClient !== client) return;
            this._isConnected = true;
            this.reconnectAttempt = 0;
            this.clearReconnectTimer();
        };

        const onDisconnect = () => {
            if (this.rpcClient !== client) return;
            this._isConnected = false;
            this.lastSentSignature = undefined;
            if (!this.isStopping) {
                this.scheduleReconnect();
            }
        };

        if (typeof (client as any).on === "function") {
            (client as any).on("ready", onConnect);
            (client as any).on("connected", onConnect);
            (client as any).on("disconnected", onDisconnect);
            (client as any).on("error", onDisconnect);
        }

        // Catch low-level transport errors to prevent unhandled node exceptions
        if (client.transport && typeof (client.transport as any).on === "function") {
            (client.transport as any).on("error", onDisconnect);
            (client.transport as any).on("close", onDisconnect);
        }
    }

    /**
     * Connects to local Discord RPC socket defensively.
     */
    private async connectDiscord(): Promise<void> {
        if (this._isConnected || this.isConnecting || this.isStopping) return;
        this.isConnecting = true;
        this.clearReconnectTimer();

        try {
            if (!this.hasCustomClient && this.reconnectAttempt > 0) {
                this.detachRpcClientEvents(this.rpcClient);
                try {
                    if (this.rpcClient?.destroy) {
                        await this.rpcClient.destroy();
                    }
                } catch {
                    // ignore
                }
                this.rpcClient = this.createNewClient();
                this.setupRpcClientEvents();
            }

            await this.rpcClient.login();
            this._isConnected = true;
            this.reconnectAttempt = 0;
            this.clearReconnectTimer();
        } catch {
            this._isConnected = false;
            this.scheduleReconnect();
        } finally {
            this.isConnecting = false;
        }
    }

    private scheduleReconnect(): void {
        if (this.isStopping || this._isConnected || this.reconnectTimer) return;

        const delay = Math.min(
            this.reconnectMaxMs,
            this.reconnectBaseMs * Math.pow(2, this.reconnectAttempt)
        );
        this.reconnectAttempt++;

        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;
            if (this.isStopping || this._isConnected) return;
            await this.connectDiscord();
            if (this._isConnected) {
                await this.reSyncPresence();
            }
        }, delay);
        this.reconnectTimer.unref();
    }

    private clearReconnectTimer(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    private async reSyncPresence(): Promise<void> {
        if (this.isStopping || !this._isConnected) return;
        const currentStatus = this.stateMachine.getCurrentStatus();
        if (currentStatus !== PresenceStatus.STOPPED) {
            const currentActivity = this.stateMachine.getCurrentActivity();
            await this.sendPresenceToDiscord(currentActivity);
        }
    }

    /**
     * Starts the IPC server and connects to Discord RPC.
     */
    public async start(): Promise<void> {
        this.isStopping = false;

        const rawInitialPayload = process.env.AGY_INITIAL_PAYLOAD;
        delete process.env.AGY_INITIAL_PAYLOAD;
        const initialPayload = decodeInitialPayload(rawInitialPayload);

        // Warm up git metadata cache so subsequent hook processing does not block timers
        try {
            await this.stateMachine.handleHook({ event: "Init", isSubagent: true, conversationId: "__init__" });
        } catch {
            // ignore
        }

        if (initialPayload) {
            await this.applyHookToState(initialPayload);
        } else {
            this.resetWatchdogTimer(this.stateMachine.getCurrentStatus());
        }

        this.ipcServer.onMessage = async (payload: HookPayload) => {
            await this.handlePayload(payload);
        };
        await this.ipcServer.start();

        await this.connectDiscord();

        if (this._isConnected && this.stateMachine.getCurrentStatus() !== PresenceStatus.STOPPED && !this.lastSentSignature) {
            this.lastUpdateTime = Date.now();
            await this.reSyncPresence();
        }
    }

    /**
     * Gracefully stops the daemon, clears Discord Rich Presence, and shuts down IPC.
     */
    public async stop(): Promise<void> {
        this.isStopping = true;
        this.clearWatchdogTimer();
        this.clearReconnectTimer();
        this.clearIdleTimer();
        this.clearThrottleTimer();

        if (this._isConnected && this.rpcClient.user?.clearActivity) {
            try {
                await this.rpcClient.user.clearActivity();
            } catch {
                // ignore
            }
        }

        this.detachRpcClientEvents(this.rpcClient);
        if (this.rpcClient.destroy) {
            try {
                await this.rpcClient.destroy();
            } catch {
                // ignore
            }
        }
        this._isConnected = false;
        this.lastSentSignature = undefined;

        await this.ipcServer.stop();
    }

    /**
     * Applies an incoming Antigravity lifecycle hook event to internal state and watchdog timers.
     */
    private async applyHookToState(payload: HookPayload): Promise<PresenceActivity | null> {
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

        this.resetWatchdogTimer(currentStatus);
        return activity;
    }

    /**
     * Processes an incoming Antigravity lifecycle hook event.
     */
    public async handlePayload(payload: HookPayload): Promise<void> {
        const activity = await this.applyHookToState(payload);
        this.schedulePresenceUpdate(activity);
    }

    private computeSignature(activity: PresenceActivity | null): string {
        if (activity === null) {
            return "CLEARED";
        }
        return JSON.stringify({
            details: activity.details,
            state: activity.state,
            largeImageKey: activity.largeImageKey,
            largeImageText: activity.largeImageText,
            smallImageKey: activity.smallImageKey,
            smallImageText: activity.smallImageText,
            buttons: activity.buttons
        });
    }

    /**
     * Schedules a throttled presence update to Discord to adhere to the 2-second rate limit.
     */
    private schedulePresenceUpdate(activity: PresenceActivity | null): void {
        const now = Date.now();
        const elapsed = now - this.lastUpdateTime;

        if (this.throttleMs === 0 || (elapsed >= this.throttleMs && !this.throttleTimer)) {
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
            this.throttleTimer.unref();
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

        const signature = this.computeSignature(activity);
        if (this._isConnected && signature === this.lastSentSignature) {
            return;
        }

        try {
            if (activity === null) {
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
            }
            this.lastUpdateTime = Date.now();
            this.lastSentSignature = signature;
        } catch {
            this._isConnected = false;
            this.lastSentSignature = undefined;
            this.scheduleReconnect();
        }
    }

    private resetWatchdogTimer(status: PresenceStatus): void {
        this.clearWatchdogTimer();
        if (this.isStopping) return;

        const timeoutMs = (status === PresenceStatus.IDLE || status === PresenceStatus.STOPPED)
            ? this.watchdogMs
            : this.activeWatchdogMs;

        this.watchdogTimer = setTimeout(async () => {
            this.watchdogTimer = null;
            if (this.isStopping) return;
            try {
                await this.stop();
            } catch {
                // ignore
            }
            try {
                this.onWatchdogExit?.();
            } catch {
                // ignore
            }
        }, timeoutMs);
        this.watchdogTimer.unref();
    }

    private clearWatchdogTimer(): void {
        if (this.watchdogTimer) {
            clearTimeout(this.watchdogTimer);
            this.watchdogTimer = null;
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
                this.resetWatchdogTimer(this.stateMachine.getCurrentStatus());
            } catch {
                // ignore
            }
        }, ms);
        this.idleTimer.unref();
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
    const daemon = new RpcDaemon(loadConfigFromEnv(), {
        watchdogMs: loadWatchdogTimeoutMsFromEnv(),
        onWatchdogExit: () => process.exit(0)
    });
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

import net from "node:net";
import fs from "node:fs";
import type { HookPayload } from "./types.js";

/**
 * Returns the platform-specific IPC channel address.
 * On Windows: Named pipe (\\.\pipe\agy-discord-rpc)
 * On Unix/macOS: Domain socket (/tmp/agy-discord-rpc.sock)
 * Can be overridden via AGY_IPC_PATH or AGY_DISCORD_RPC_PIPE environment variables.
 */
export function getIpcAddress(): string {
    if (process.env.AGY_IPC_PATH) {
        return process.env.AGY_IPC_PATH;
    }
    if (process.env.AGY_DISCORD_RPC_PIPE) {
        return process.env.AGY_DISCORD_RPC_PIPE;
    }
    return process.platform === "win32"
        ? "\\\\.\\pipe\\agy-discord-rpc"
        : "/tmp/agy-discord-rpc.sock";
}

/**
 * Local IPC server listening for hook events dispatched from Antigravity CLI.
 */
export class IpcServer {
    public readonly path: string;
    public onMessage?: (payload: HookPayload) => void | Promise<void>;
    private server: net.Server | null = null;
    private readonly connections = new Set<net.Socket>();
    private _isListening = false;

    constructor(socketPath?: string) {
        this.path = socketPath || getIpcAddress();
    }

    public get isListening(): boolean {
        return this._isListening;
    }

    /**
     * Starts listening on the configured named pipe or Unix socket.
     */
    public async start(): Promise<void> {
        if (this._isListening) return;

        // Clean up stale Unix domain socket if it exists on disk
        if (process.platform !== "win32" && fs.existsSync(this.path)) {
            try {
                fs.unlinkSync(this.path);
            } catch {
                // ignore
            }
        }

        return new Promise<void>((resolve, reject) => {
            const server = net.createServer((socket) => {
                this.connections.add(socket);

                let buffer = "";
                socket.on("data", async (chunk) => {
                    buffer += chunk.toString("utf-8");
                    const lines = buffer.split("\n");
                    buffer = lines.pop() ?? "";

                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed) continue;
                        try {
                            const payload = JSON.parse(trimmed) as HookPayload;
                            if (this.onMessage) {
                                await this.onMessage(payload);
                            }
                            socket.write(JSON.stringify({ ok: true }) + "\n");
                        } catch {
                            socket.write(JSON.stringify({ error: "invalid_json" }) + "\n");
                        }
                    }
                });

                socket.on("error", () => {
                    this.connections.delete(socket);
                });

                socket.on("close", () => {
                    this.connections.delete(socket);
                });
            });

            server.once("error", (err) => {
                this._isListening = false;
                reject(err);
            });

            server.listen(this.path, () => {
                this._isListening = true;
                this.server = server;
                resolve();
            });
        });
    }

    /**
     * Closes all active connections and terminates the IPC server.
     */
    public async stop(): Promise<void> {
        if (!this.server && !this._isListening) return;

        for (const sock of this.connections) {
            try {
                sock.destroy();
            } catch {
                // ignore
            }
        }
        this.connections.clear();

        return new Promise<void>((resolve) => {
            if (!this.server) {
                this._isListening = false;
                resolve();
                return;
            }

            this.server.close(() => {
                this._isListening = false;
                this.server = null;
                if (process.platform !== "win32" && fs.existsSync(this.path)) {
                    try {
                        fs.unlinkSync(this.path);
                    } catch {
                        // ignore
                    }
                }
                resolve();
            });
        });
    }
}

/**
 * Sends a single HookPayload message to the local IPC server.
 * Returns true if successfully delivered and acknowledged, false if unreachable or error.
 */
export function sendIpcMessage(
    payload: HookPayload,
    timeoutMs: number = 1000,
    socketPath?: string
): Promise<boolean> {
    return new Promise((resolve) => {
        const targetPath = socketPath || getIpcAddress();
        let settled = false;

        const client = net.createConnection(targetPath);

        const finish = (result: boolean) => {
            if (!settled) {
                settled = true;
                try {
                    client.destroy();
                } catch {
                    // ignore
                }
                resolve(result);
            }
        };

        client.setTimeout(timeoutMs);

        client.on("connect", () => {
            const data = JSON.stringify(payload) + "\n";
            client.write(data, "utf-8");
        });

        client.on("data", () => {
            finish(true);
        });

        client.on("end", () => {
            finish(true);
        });

        client.on("timeout", () => {
            finish(false);
        });

        client.on("error", () => {
            finish(false);
        });
    });
}

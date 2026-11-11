import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { IpcServer, sendIpcMessage, getIpcAddress, probeSocketActive } from "../src/ipc";
import { RpcDaemon } from "../src/daemon";
import { HookPayload, PresenceStatus, encodeInitialPayload, DEFAULT_CONFIG } from "../src/types";

describe("Local IPC Channel", () => {
    let server: IpcServer;
    const testPipe = process.platform === "win32"
        ? `\\\\.\\pipe\\agy-discord-rpc-test-${process.pid}-${Date.now()}`
        : `/tmp/agy-discord-rpc-test-${process.pid}-${Date.now()}.sock`;

    before(async () => {
        server = new IpcServer(testPipe);
        await server.start();
    });

    after(async () => {
        await server.stop();
    });

    it("detects whether an existing IPC endpoint has a live listener", async () => {
        const activePipe = process.platform === "win32"
            ? `\\\\.\\pipe\\agy-probe-active-${process.pid}`
            : `/tmp/agy-probe-active-${process.pid}.sock`;
        const srv = new IpcServer(activePipe);
        await srv.start();
        try {
            assert.equal(await probeSocketActive(activePipe, 100), true);
        } finally {
            await srv.stop();
        }
        assert.equal(await probeSocketActive(activePipe, 100), false);
    });

    it("rejects with EADDRINUSE on Unix when socket is active and unlinks when inactive", { skip: process.platform === "win32" ? "Unix domain sockets only" : false }, async () => {
        const socketPath = `/tmp/agy-probe-eaddrinuse-${process.pid}.sock`;
        const srv1 = new IpcServer(socketPath);
        await srv1.start();
        try {
            const srv2 = new IpcServer(socketPath);
            await assert.rejects(srv2.start(), (err: any) => {
                return err?.code === "EADDRINUSE" && err?.message?.includes("already in use");
            });
        } finally {
            await srv1.stop();
        }

        // Stale socket simulation: write a dummy file at socketPath
        fs.writeFileSync(socketPath, "stale");
        assert.equal(fs.existsSync(socketPath), true);

        const srv3 = new IpcServer(socketPath);
        await srv3.start(); // Should probe, see inactive, unlink, and start
        assert.equal(srv3.isListening, true);
        await srv3.stop();
        assert.equal(fs.existsSync(socketPath), false);
    });

    it("successfully sends and receives hook payloads across local IPC socket", async () => {
        let received: HookPayload | null = null;
        server.onMessage = (payload) => {
            received = payload;
        };

        const testPayload: HookPayload = {
            event: "PreInvocation",
            conversationId: "test-conv-123"
        };

        const success = await sendIpcMessage(testPayload, 1000, testPipe);
        assert.equal(success, true);
        assert.deepEqual(received, testPayload);
    });

    it("returns platform-specific IPC address", () => {
        const address = getIpcAddress();
        assert.ok(typeof address === "string");
        if (process.platform === "win32") {
            assert.ok(address.startsWith("\\\\.\\pipe\\"));
        } else {
            assert.ok(address.endsWith(".sock"));
        }
    });

    it("returns false gracefully when sending to an unlistening endpoint", async () => {
        const fakeAddress = process.platform === "win32"
            ? "\\\\.\\pipe\\non-existent-agy-test-pipe"
            : "/tmp/non-existent-agy-test.sock";

        const success = await sendIpcMessage(
            { event: "Stop", conversationId: "none" },
            200,
            fakeAddress
        );
        assert.equal(success, false);
    });
});

describe("RPC Daemon Core", () => {
    it("coordinates IPC messages into state machine transitions", async () => {
        const testPipe = process.platform === "win32"
            ? `\\\\.\\pipe\\agy-daemon-test-pipe-1-${process.pid}`
            : `/tmp/agy-daemon-test-1-${process.pid}.sock`;

        // Mock RPC client
        const setActivityCalls: any[] = [];
        const mockRpcClient = {
            login: async () => {},
            destroy: async () => {},
            user: {
                setActivity: async (act: any) => {
                    setActivityCalls.push(act);
                    return act;
                },
                clearActivity: async () => {}
            }
        };

        const daemon = new RpcDaemon(undefined, {
            ipcPath: testPipe,
            throttleMs: 0,
            rpcClient: mockRpcClient as any
        });

        await daemon.start();

        const success = await sendIpcMessage(
            { event: "PreInvocation", conversationId: "daemon-test-c1" },
            1000,
            testPipe
        );

        assert.equal(success, true);
        assert.equal(daemon.stateMachine.getCurrentStatus(), PresenceStatus.THINKING);
        assert.ok(setActivityCalls.length >= 1);
        assert.match(setActivityCalls[setActivityCalls.length - 1].details, /Agent is thinking/);

        await daemon.stop();
    });

    it("processes AGY_INITIAL_PAYLOAD on start and ignores malformed payloads", async () => {
        const testPipe = process.platform === "win32"
            ? `\\\\.\\pipe\\agy-daemon-coldstart-${process.pid}`
            : `/tmp/agy-daemon-coldstart-${process.pid}.sock`;
        const calls: any[] = [];
        const mockRpc = {
            login: async () => {},
            destroy: async () => {},
            user: { setActivity: async (a: any) => calls.push(a), clearActivity: async () => {} }
        };
        process.env.AGY_INITIAL_PAYLOAD = encodeInitialPayload({ event: "SessionStart", conversationId: "cold-start" });
        const daemon = new RpcDaemon(undefined, { ipcPath: testPipe, throttleMs: 0, rpcClient: mockRpc as any });
        await daemon.start();
        assert.equal(process.env.AGY_INITIAL_PAYLOAD, undefined);
        assert.equal(daemon.stateMachine.getCurrentStatus(), PresenceStatus.THINKING);
        assert.ok(calls.length >= 1);
        await daemon.stop();

        process.env.AGY_INITIAL_PAYLOAD = "corrupt!!!";
        const daemon2 = new RpcDaemon(undefined, { ipcPath: testPipe, throttleMs: 0, rpcClient: mockRpc as any });
        await assert.doesNotReject(() => daemon2.start());
        assert.equal(process.env.AGY_INITIAL_PAYLOAD, undefined);
        await daemon2.stop();
    });

    it("throttles rapid presence updates using configured throttleMs", async () => {
        const testPipe = process.platform === "win32"
            ? `\\\\.\\pipe\\agy-daemon-test-pipe-2-${process.pid}`
            : `/tmp/agy-daemon-test-2-${process.pid}.sock`;

        let updateCount = 0;
        const mockRpcClient = {
            login: async () => {},
            destroy: async () => {},
            user: {
                setActivity: async () => {
                    updateCount++;
                },
                clearActivity: async () => {
                    updateCount++;
                }
            }
        };

        const daemon = new RpcDaemon(undefined, {
            ipcPath: testPipe,
            throttleMs: 100, // 100ms throttle for fast testing
            rpcClient: mockRpcClient as any
        });

        await daemon.start();

        // Fire 3 quick events
        await daemon.handlePayload({ event: "PreInvocation", conversationId: "c1" });
        await daemon.handlePayload({ event: "PreToolUse", conversationId: "c1", toolName: "read_file" });
        await daemon.handlePayload({ event: "Stop", conversationId: "c1", terminationReason: "NO_TOOL_CALL" });

        // First one went through immediately, rest are throttled
        assert.equal(updateCount, 1);

        // Wait for throttler to flush
        await new Promise((resolve) => setTimeout(resolve, 150));
        assert.equal(updateCount, 2);

        await daemon.stop();
    });

    it("handles Discord connection failures gracefully without throwing", async () => {
        const failingRpcClient = {
            login: async () => {
                throw new Error("Could not connect to Discord client");
            },
            destroy: async () => {},
            user: undefined
        };

        const testPipe = process.platform === "win32"
            ? `\\\\.\\pipe\\agy-daemon-test-pipe-3-${process.pid}`
            : `/tmp/agy-daemon-test-3-${process.pid}.sock`;

        const daemon = new RpcDaemon(undefined, {
            ipcPath: testPipe,
            throttleMs: 0,
            rpcClient: failingRpcClient as any
        });

        // start() should not throw even if login fails
        await daemon.start();
        assert.equal(daemon.isConnected, false);

        // handlePayload should not throw when client is disconnected
        await daemon.handlePayload({ event: "PreInvocation", conversationId: "c1" });

        await daemon.stop();
    });

    it("triggers idle timeout transition when inactive in WAITING_REVIEW", async () => {
        const testPipe = process.platform === "win32"
            ? `\\\\.\\pipe\\agy-daemon-test-pipe-4-${process.pid}`
            : `/tmp/agy-daemon-test-4-${process.pid}.sock`;

        let lastActivity: any = null;
        const mockRpcClient = {
            login: async () => {},
            destroy: async () => {},
            user: {
                setActivity: async (act: any) => {
                    lastActivity = act;
                },
                clearActivity: async () => {}
            }
        };

        const daemon = new RpcDaemon(
            {
                clientId: "1441771215290372156",
                privacyMode: false,
                idleTimeoutSeconds: 0.05, // 50ms idle timeout for testing
                showRepoButton: true
            },
            {
                ipcPath: testPipe,
                throttleMs: 0,
                rpcClient: mockRpcClient as any
            }
        );

        await daemon.start();

        // Agent completes turn and enters WAITING_REVIEW
        await daemon.handlePayload({ event: "PreInvocation", conversationId: "c1" });
        await daemon.handlePayload({
            event: "Stop",
            conversationId: "c1",
            terminationReason: "NO_TOOL_CALL"
        });

        assert.equal(daemon.stateMachine.getCurrentStatus(), PresenceStatus.WAITING_REVIEW);

        // Wait for idle timer to fire
        await new Promise((resolve) => setTimeout(resolve, 100));

        assert.equal(daemon.stateMachine.getCurrentStatus(), PresenceStatus.IDLE);
        assert.match(lastActivity?.details, /Idling in workspace/);

        await daemon.stop();
    });

    it("deduplicates identical consecutive presence payloads while connected", async () => {
        const testPipe = process.platform === "win32"
            ? `\\\\.\\pipe\\agy-daemon-dedup-${process.pid}`
            : `/tmp/agy-daemon-dedup-${process.pid}.sock`;
        const setCalls: any[] = [];
        const mockRpc = {
            login: async () => {},
            destroy: async () => {},
            user: { setActivity: async (a: any) => setCalls.push(a), clearActivity: async () => {} }
        };
        const daemon = new RpcDaemon(undefined, { ipcPath: testPipe, throttleMs: 50, rpcClient: mockRpc as any });
        await daemon.start();
        await daemon.handlePayload({ event: "PreInvocation", conversationId: "c1" });
        await daemon.handlePayload({ event: "PreToolUse", conversationId: "c1", toolName: "read_file" });
        await daemon.handlePayload({ event: "PostToolUse", conversationId: "c1" });
        await new Promise((r) => setTimeout(r, 80));
        assert.equal(setCalls.length, 1);

        await daemon.handlePayload({ event: "Stop", conversationId: "c1", terminationReason: "NO_TOOL_CALL" });
        await new Promise((r) => setTimeout(r, 80));
        assert.equal(setCalls.length, 2);
        await daemon.stop();
    });

    it("reconnects with backoff when Discord is unavailable or disconnects and re-syncs identical presence", async () => {
        const { EventEmitter } = await import("node:events");
        const testPipe = process.platform === "win32"
            ? `\\\\.\\pipe\\agy-daemon-reconnect-${process.pid}`
            : `/tmp/agy-daemon-reconnect-${process.pid}.sock`;
        let attempts = 0;
        const setCalls: any[] = [];
        const mockRpc: any = new EventEmitter();
        mockRpc.login = async () => {
            attempts++;
            if (attempts <= 2) throw new Error("Discord closed");
        };
        mockRpc.destroy = async () => {};
        mockRpc.user = { setActivity: async (a: any) => setCalls.push(a), clearActivity: async () => {} };

        const daemon = new RpcDaemon(undefined, {
            ipcPath: testPipe,
            throttleMs: 0,
            reconnectBaseMs: 25,
            reconnectMaxMs: 50,
            rpcClient: mockRpc
        });
        await daemon.start(); // attempt 1 fails
        await daemon.handlePayload({ event: "PreInvocation", conversationId: "c1" }); // attempt 2 fails
        assert.equal(daemon.isConnected, false);
        assert.equal(setCalls.length, 0);

        // Background reconnect timer (attempt 3) succeeds with no new hook and re-syncs
        await new Promise((r) => setTimeout(r, 120));
        assert.equal(daemon.isConnected, true);
        assert.equal(setCalls.length, 1);
        assert.match(setCalls[0].details ?? "", /Agent is thinking/);

        // Simulate disconnect while holding identical state, verify re-sync bypasses dedup cache
        mockRpc.emit("disconnected");
        assert.equal(daemon.isConnected, false);
        await new Promise((r) => setTimeout(r, 80));
        assert.equal(daemon.isConnected, true);
        assert.equal(setCalls.length, 2);
        await daemon.stop();
    });

    it("applies 2-tier inactivity watchdog without interrupting WAITING_REVIEW before idle timeout", async () => {
        const testPipe = process.platform === "win32"
            ? `\\\\.\\pipe\\agy-daemon-watchdog-${process.pid}`
            : `/tmp/agy-daemon-watchdog-${process.pid}.sock`;
        let exitCount = 0;
        const mockRpc = {
            login: async () => {},
            destroy: async () => {},
            user: { setActivity: async () => {}, clearActivity: async () => {} }
        };
        const daemon = new RpcDaemon(
            { ...DEFAULT_CONFIG, idleTimeoutSeconds: 0.08 },
            {
                ipcPath: testPipe,
                throttleMs: 0,
                watchdogMs: 40,
                activeWatchdogMs: 500,
                onWatchdogExit: () => { exitCount++; },
                rpcClient: mockRpc as any
            }
        );
        await daemon.start();
        await daemon.handlePayload({ event: "PreInvocation", conversationId: "c1" });
        await daemon.handlePayload({ event: "Stop", conversationId: "c1", terminationReason: "NO_TOOL_CALL" });

        await new Promise((r) => setTimeout(r, 50));
        assert.equal(exitCount, 0);
        assert.equal(daemon.stateMachine.getCurrentStatus(), PresenceStatus.WAITING_REVIEW);

        await new Promise((r) => setTimeout(r, 90));
        assert.equal(exitCount, 1);
        assert.equal(daemon.ipcServer.isListening, false);
    });

    it("decouples zombie client listeners during reconnection so old client events do not affect daemon", async () => {
        const { EventEmitter } = await import("node:events");
        const testPipe = process.platform === "win32"
            ? `\\\\.\\pipe\\agy-daemon-zombie-${process.pid}`
            : `/tmp/agy-daemon-zombie-${process.pid}.sock`;

        const clients: any[] = [];
        const clientFactory = () => {
            const client: any = new EventEmitter();
            client.transport = new EventEmitter();
            const clientIndex = clients.length;
            client.login = async () => {
                if (clientIndex === 0) {
                    throw new Error("First client failed");
                }
            };
            client.destroy = async () => {};
            client.user = {
                setActivity: async () => {},
                clearActivity: async () => {}
            };
            clients.push(client);
            return client;
        };

        const daemon = new RpcDaemon(undefined, {
            ipcPath: testPipe,
            throttleMs: 0,
            reconnectBaseMs: 25,
            reconnectMaxMs: 50,
            clientFactory: clientFactory as any
        });

        try {
            await daemon.start(); // client 0 fails to login, schedules reconnect
            assert.equal(daemon.isConnected, false);
            assert.equal(clients.length, 1);

            // Wait for reconnect to trigger and succeed with client 1
            await new Promise((r) => setTimeout(r, 80));
            assert.equal(daemon.isConnected, true);
            assert.equal(clients.length, 2);

            // Now emit disconnected or error on discarded client 0
            clients[0].emit("disconnected");
            clients[0].emit("error", new Error("zombie error"));
            clients[0].transport.emit("error", new Error("transport error"));

            // daemon.isConnected should still be true!
            assert.equal(daemon.isConnected, true);
        } finally {
            await daemon.stop();
        }
    });

    it("preserves newer IPC state arriving mid-login over cold-start AGY_INITIAL_PAYLOAD", async () => {
        const testPipe = process.platform === "win32"
            ? `\\\\.\\pipe\\agy-daemon-coldstart-inversion-${process.pid}`
            : `/tmp/agy-daemon-coldstart-inversion-${process.pid}.sock`;

        const setCalls: any[] = [];
        const mockRpc = {
            login: async () => {
                // Simulate login taking ~30ms while an IPC message arrives
                await new Promise((r) => setTimeout(r, 30));
            },
            destroy: async () => {},
            user: {
                setActivity: async (a: any) => {
                    setCalls.push(a);
                    return a;
                },
                clearActivity: async () => {}
            }
        };

        process.env.AGY_INITIAL_PAYLOAD = encodeInitialPayload({
            event: "SessionStart",
            conversationId: "cold-inversion"
        });

        const daemon = new RpcDaemon(undefined, {
            ipcPath: testPipe,
            throttleMs: 0,
            rpcClient: mockRpc as any
        });

        try {
            // Start daemon in background
            const startPromise = daemon.start();

            // Wait until IPC server is listening and login is in flight
            while (!daemon.ipcServer.isListening) {
                await new Promise((r) => setTimeout(r, 5));
            }

            const sent = await sendIpcMessage(
                {
                    event: "PreToolUse",
                    conversationId: "cold-inversion",
                    toolName: "read_file",
                    toolArgs: { Path: "src/daemon.ts" }
                },
                500,
                testPipe
            );
            assert.equal(sent, true);

            await startPromise;

            assert.equal(daemon.stateMachine.getCurrentStatus(), PresenceStatus.EXECUTING_TOOL);
            assert.ok(setCalls.length >= 1);
            const lastCall = setCalls[setCalls.length - 1];
            assert.match(lastCall.details ?? "", /Reading daemon\.ts/);
        } finally {
            await daemon.stop();
        }
    });
});

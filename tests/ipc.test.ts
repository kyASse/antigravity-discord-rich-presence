import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { IpcServer, sendIpcMessage, getIpcAddress } from "../src/ipc";
import { RpcDaemon } from "../src/daemon";
import { HookPayload, PresenceStatus } from "../src/types";

describe("Local IPC Channel", () => {
    let server: IpcServer;
    const testPipe = process.platform === "win32"
        ? `\\\\.\\pipe\\test-ipc-${process.pid}-${Date.now()}`
        : `/tmp/test-ipc-${process.pid}-${Date.now()}.sock`;

    before(async () => {
        server = new IpcServer(testPipe);
        await server.start();
    });

    after(async () => {
        await server.stop();
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
            ? "\\\\.\\pipe\\agy-daemon-test-pipe-1"
            : "/tmp/agy-daemon-test-1.sock";

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

    it("throttles rapid presence updates using configured throttleMs", async () => {
        const testPipe = process.platform === "win32"
            ? "\\\\.\\pipe\\agy-daemon-test-pipe-2"
            : "/tmp/agy-daemon-test-2.sock";

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
        await daemon.handlePayload({ event: "PostToolUse", conversationId: "c1" });

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
            ? "\\\\.\\pipe\\agy-daemon-test-pipe-3"
            : "/tmp/agy-daemon-test-3.sock";

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
            ? "\\\\.\\pipe\\agy-daemon-test-pipe-4"
            : "/tmp/agy-daemon-test-4.sock";

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
                clientId: "1568484776703299726",
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
});

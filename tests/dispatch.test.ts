import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { IpcServer } from "../src/ipc.js";
import { runDispatch, parseCliArgs, parseStdin } from "../src/dispatch.js";
import { HookPayload } from "../src/types.js";

describe("CLI Dispatcher", () => {
    let server: IpcServer;
    let receivedPayload: HookPayload | null = null;
    const testPipe = process.platform === "win32"
        ? `\\\\.\\pipe\\agy-discord-rpc-test-${process.pid}-${Date.now()}`
        : `/tmp/agy-discord-rpc-test-${process.pid}-${Date.now()}.sock`;

    before(async () => {
        server = new IpcServer(testPipe);
        server.onMessage = (p) => {
            receivedPayload = p;
        };
        await server.start();
    });

    after(async () => {
        await server.stop();
    });

    it("parses CLI args and dispatches event to IPC server within 50ms", async () => {
        const start = performance.now();
        await runDispatch(["--event", "PreInvocation", "--conversationId", "c-456"], { ...process.env, AGY_IPC_PATH: testPipe });
        const duration = performance.now() - start;

        assert.ok(duration < 100, `Dispatch took too long: ${duration}ms`);
        assert.equal(receivedPayload?.event, "PreInvocation");
        assert.equal(receivedPayload?.conversationId, "c-456");
    });

    it("parses all rich CLI options (--toolName, --toolArgs, --terminationReason, --isSubagent, --cwd)", async () => {
        receivedPayload = null as HookPayload | null;
        await runDispatch([
            "--event", "PreToolUse",
            "--conversationId", "c-789",
            "--toolName", "run_command",
            "--toolArgs", '{"CommandLine":"npm test"}',
            "--isSubagent", "true",
            "--cwd", "C:/test/workspace"
        ], { ...process.env, AGY_IPC_PATH: testPipe });

        const payload: HookPayload | null = receivedPayload;
        assert.equal(payload?.event, "PreToolUse");
        assert.equal(payload?.conversationId, "c-789");
        assert.equal(payload?.toolName, "run_command");
        assert.deepEqual(payload?.toolArgs, { CommandLine: "npm test" });
        assert.equal(payload?.isSubagent, true);
        assert.equal(payload?.cwd, "C:/test/workspace");
    });

    it("parses STDIN JSON payload and dispatches to IPC server", async () => {
        receivedPayload = null as HookPayload | null;
        const stdinJson = JSON.stringify({
            event: "PreToolUse",
            conversationId: "c-stdin-1",
            toolCall: {
                name: "edit_file",
                args: { Path: "src/dispatch.ts" }
            },
            workspacePaths: ["C:/test/stdin-project"]
        });

        await runDispatch([], { ...process.env, AGY_IPC_PATH: testPipe }, stdinJson);

        const payload: HookPayload | null = receivedPayload;
        assert.equal(payload?.event, "PreToolUse");
        assert.equal(payload?.conversationId, "c-stdin-1");
        assert.equal(payload?.toolName, "edit_file");
        assert.deepEqual(payload?.toolArgs, { Path: "src/dispatch.ts" });
        assert.equal(payload?.cwd, "C:/test/stdin-project");
    });

    it("allows CLI args to override STDIN payload fields", async () => {
        receivedPayload = null as HookPayload | null;
        const stdinJson = JSON.stringify({
            event: "PreInvocation",
            conversationId: "original-id",
            workspacePaths: ["/original/path"]
        });

        await runDispatch(["--event", "Stop", "--conversationId", "override-id", "--terminationReason", "NO_TOOL_CALL"], { ...process.env, AGY_IPC_PATH: testPipe }, stdinJson);

        const payload: HookPayload | null = receivedPayload;
        assert.equal(payload?.event, "Stop");
        assert.equal(payload?.conversationId, "override-id");
        assert.equal(payload?.terminationReason, "NO_TOOL_CALL");
        assert.equal(payload?.cwd, "/original/path");
    });

    it("completes quickly and gracefully without throwing when daemon is offline", async () => {
        const offlineEnv = {
            ...process.env,
            AGY_IPC_PATH: process.platform === "win32"
                ? "\\\\.\\pipe\\agy-discord-rpc-offline-test"
                : "/tmp/agy-discord-rpc-offline-test.sock",
            AGY_AUTO_SPAWN: "false"
        };

        const start = performance.now();
        await assert.doesNotReject(async () => {
            await runDispatch(["--event", "PreInvocation", "--conversationId", "c-offline"], offlineEnv);
        });
        const duration = performance.now() - start;

        assert.ok(duration < 150, `Offline dispatch took too long: ${duration}ms`);
    });

    it("returns expected hook decision objects", async () => {
        const preToolResult = await runDispatch(["--event", "PreToolUse", "--conversationId", "c-1"], { ...process.env, AGY_IPC_PATH: testPipe });
        assert.deepEqual(preToolResult, { decision: "allow" });

        const preInvocResult = await runDispatch(["--event", "PreInvocation", "--conversationId", "c-1"], { ...process.env, AGY_IPC_PATH: testPipe });
        assert.deepEqual(preInvocResult, {});
    });
});

describe("hooks.json configuration", () => {
    it("hooks.json exists and defines all required Antigravity lifecycle hooks", () => {
        const hooksPath = path.resolve("hooks.json");
        assert.ok(fs.existsSync(hooksPath), "hooks.json should exist");

        const raw = fs.readFileSync(hooksPath, "utf-8");
        const parsed = JSON.parse(raw);

        // Find the top-level hook group
        const groupKeys = Object.keys(parsed);
        assert.ok(groupKeys.length > 0, "hooks.json must contain at least one group");

        const group = parsed[groupKeys[0]];
        const requiredEvents = [
            "SessionStart",
            "PreInvocation",
            "PreToolUse",
            "PostToolUse",
            "PostInvocation",
            "Stop"
        ];

        for (const evt of requiredEvents) {
            assert.ok(group[evt], `Missing hook for event: ${evt}`);
            assert.ok(Array.isArray(group[evt]), `Hook for ${evt} must be an array`);
            assert.ok(group[evt].length > 0, `Hook array for ${evt} must not be empty`);
        }
    });
});

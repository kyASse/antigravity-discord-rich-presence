import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { PresenceStateMachine } from "../src/state";
import { PresenceStatus, DEFAULT_CONFIG } from "../src/types";

describe("Presence State Machine", () => {
    it("transitions to THINKING on PreInvocation", async () => {
        const sm = new PresenceStateMachine(DEFAULT_CONFIG);
        const activity = await sm.handleHook({ event: "PreInvocation", conversationId: "c1" });
        assert.equal(sm.getCurrentStatus(), PresenceStatus.THINKING);
        assert.match(activity?.details ?? "", /Agent is thinking/);
    });

    it("transitions to EXECUTING_TOOL on PreToolUse", async () => {
        const sm = new PresenceStateMachine(DEFAULT_CONFIG);
        const activity = await sm.handleHook({
            event: "PreToolUse",
            conversationId: "c1",
            toolName: "read_file",
            toolArgs: { Path: "foo.ts" }
        });
        assert.equal(sm.getCurrentStatus(), PresenceStatus.EXECUTING_TOOL);
        assert.match(activity?.details ?? "", /Reading foo.ts/);
    });

    it("transitions to WAITING_REVIEW on normal turn Stop (NO_TOOL_CALL)", async () => {
        const sm = new PresenceStateMachine(DEFAULT_CONFIG);
        await sm.handleHook({ event: "PreInvocation", conversationId: "c1" });
        const activity = await sm.handleHook({
            event: "Stop",
            conversationId: "c1",
            terminationReason: "NO_TOOL_CALL"
        });
        assert.equal(sm.getCurrentStatus(), PresenceStatus.WAITING_REVIEW);
        assert.match(activity?.details ?? "", /Waiting for user review/);
    });

    it("clears presence when session is cancelled or stopped completely", async () => {
        const sm = new PresenceStateMachine(DEFAULT_CONFIG);
        await sm.handleHook({ event: "PreInvocation", conversationId: "c1" });
        const activity = await sm.handleHook({
            event: "Stop",
            conversationId: "c1",
            terminationReason: "USER_CANCELED"
        });
        assert.equal(activity, null);
        assert.equal(sm.getCurrentStatus(), PresenceStatus.STOPPED);
    });

    it("arbitrates subagent activity without prematurely clearing primary agent", async () => {
        const sm = new PresenceStateMachine(DEFAULT_CONFIG);
        await sm.handleHook({ event: "PreInvocation", conversationId: "root" });
        await sm.handleHook({ event: "PreToolUse", conversationId: "sub1", isSubagent: true, toolName: "search_web" });
        assert.equal(sm.getActiveSubagentsCount(), 1);
        assert.equal(sm.getCurrentStatus(), PresenceStatus.EXECUTING_TOOL);

        // Subagent completes its turn
        await sm.handleHook({ event: "Stop", conversationId: "sub1", isSubagent: true, terminationReason: "NO_TOOL_CALL" });
        // Root agent is still active
        assert.equal(sm.getCurrentStatus(), PresenceStatus.THINKING);
    });

    it("transitions to IDLE on handleIdleTimeout when in WAITING_REVIEW", async () => {
        const sm = new PresenceStateMachine(DEFAULT_CONFIG);
        await sm.handleHook({ event: "PreInvocation", conversationId: "c1" });
        await sm.handleHook({ event: "Stop", conversationId: "c1", terminationReason: "NO_TOOL_CALL" });
        assert.equal(sm.getCurrentStatus(), PresenceStatus.WAITING_REVIEW);

        const activity = sm.handleIdleTimeout();
        assert.equal(sm.getCurrentStatus(), PresenceStatus.IDLE);
        assert.equal(activity?.details, "Idling in workspace");
        assert.equal(activity?.smallImageKey, "zzz");
    });

    it("does not transition to IDLE on handleIdleTimeout when actively working", async () => {
        const sm = new PresenceStateMachine(DEFAULT_CONFIG);
        await sm.handleHook({ event: "PreInvocation", conversationId: "c1" });
        assert.equal(sm.getCurrentStatus(), PresenceStatus.THINKING);

        const activity = sm.handleIdleTimeout();
        assert.equal(sm.getCurrentStatus(), PresenceStatus.THINKING);
        assert.match(activity?.details ?? "", /Agent is thinking/);
    });

    it("tracks multiple concurrent subagents and reflects counts", async () => {
        const sm = new PresenceStateMachine(DEFAULT_CONFIG);
        await sm.handleHook({ event: "PreInvocation", conversationId: "root" });
        await sm.handleHook({ event: "PreInvocation", conversationId: "sub1", isSubagent: true });
        await sm.handleHook({ event: "PreToolUse", conversationId: "sub2", isSubagent: true, toolName: "search_web" });

        assert.equal(sm.getActiveSubagentsCount(), 2);
        assert.equal(sm.getCurrentStatus(), PresenceStatus.EXECUTING_TOOL);

        // Stop one subagent
        await sm.handleHook({ event: "Stop", conversationId: "sub2", isSubagent: true, terminationReason: "NO_TOOL_CALL" });
        assert.equal(sm.getActiveSubagentsCount(), 1);
        assert.equal(sm.getCurrentStatus(), PresenceStatus.THINKING);

        // Stop the second subagent
        await sm.handleHook({ event: "Stop", conversationId: "sub1", isSubagent: true, terminationReason: "NO_TOOL_CALL" });
        assert.equal(sm.getActiveSubagentsCount(), 0);
        assert.equal(sm.getCurrentStatus(), PresenceStatus.THINKING);
    });

    it("respects privacyMode by omitting repository button and masking tool actions", async () => {
        const privateConfig = { ...DEFAULT_CONFIG, privacyMode: true };
        const sm = new PresenceStateMachine(privateConfig);
        const activity = await sm.handleHook({
            event: "PreToolUse",
            conversationId: "c1",
            toolName: "run_command",
            toolArgs: { CommandLine: "git commit -m 'secret token 123'" }
        });
        assert.equal(activity?.buttons, undefined);
        assert.equal(activity?.details, "Running: git");
    });

    it("includes View Repository button when Git remote exists and showRepoButton is true", async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-state-test-"));
        try {
            execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
            execFileSync(
                "git",
                ["config", "remote.origin.url", "https://github.com/test-owner/test-repo.git"],
                { cwd: tmpDir, stdio: "ignore" }
            );

            const sm = new PresenceStateMachine({ ...DEFAULT_CONFIG, showRepoButton: true });
            const activity = await sm.handleHook({
                event: "PreInvocation",
                conversationId: "c1",
                cwd: tmpDir
            });

            assert.ok(activity?.buttons);
            assert.deepEqual(activity.buttons, [
                { label: "View Repository", url: "https://github.com/test-owner/test-repo" }
            ]);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it("prunes subagent from sessions on termination", async () => {
        const sm = new PresenceStateMachine(DEFAULT_CONFIG);
        await sm.handleHook({ event: "PreInvocation", conversationId: "root" });
        await sm.handleHook({ event: "PreInvocation", conversationId: "sub1", isSubagent: true });
        assert.equal(sm.getActiveSubagentsCount(), 1);

        await sm.handleHook({ event: "Stop", conversationId: "sub1", isSubagent: true, terminationReason: "NO_TOOL_CALL" });
        assert.equal(sm.getActiveSubagentsCount(), 0);
        // Verify sub1 was deleted from internal sessions
        assert.equal((sm as any).sessions.has("sub1"), false);
        assert.equal((sm as any).sessions.has("root"), true);
    });

    it("transitions to WAITING_REVIEW on Stop when terminationReason is omitted or undefined", async () => {
        const sm = new PresenceStateMachine(DEFAULT_CONFIG);
        await sm.handleHook({ event: "PreInvocation", conversationId: "c1" });
        const activity = await sm.handleHook({ event: "Stop", conversationId: "c1" });
        assert.equal(sm.getCurrentStatus(), PresenceStatus.WAITING_REVIEW);
        assert.match(activity?.details ?? "", /Waiting for user review/);
    });

    it("does not let an old stale session indefinitely block WAITING_REVIEW", async () => {
        const sm = new PresenceStateMachine(DEFAULT_CONFIG);
        // Stale test session created 10 minutes ago
        await sm.handleHook({ event: "PreInvocation", conversationId: "stale-test" });
        const staleSession = (sm as any).sessions.get("stale-test");
        staleSession.updatedAt = Date.now() - 600_000; // 10 minutes old

        // New real conversation finishes
        await sm.handleHook({ event: "PreInvocation", conversationId: "real-c1" });
        const activity = await sm.handleHook({ event: "Stop", conversationId: "real-c1", terminationReason: "NO_TOOL_CALL" });

        assert.equal(sm.getCurrentStatus(), PresenceStatus.WAITING_REVIEW);
        assert.match(activity?.details ?? "", /Waiting for user review/);
    });

    it("transitions to WAITING_REVIEW on PostInvocation even if previous status was EXECUTING_TOOL", async () => {
        const sm = new PresenceStateMachine(DEFAULT_CONFIG);
        await sm.handleHook({ event: "PreToolUse", conversationId: "c1", toolName: "read_file" });
        assert.equal(sm.getCurrentStatus(), PresenceStatus.EXECUTING_TOOL);

        const activity = await sm.handleHook({ event: "PostInvocation", conversationId: "c1" });
        assert.equal(sm.getCurrentStatus(), PresenceStatus.WAITING_REVIEW);
        assert.match(activity?.details ?? "", /Waiting for user review/);
    });

    it("clears any executing tool session when Stop arrives for primary agent", async () => {
        const sm = new PresenceStateMachine(DEFAULT_CONFIG);
        // Suppose a session with key 'default' was marked as EXECUTING_TOOL
        await sm.handleHook({ event: "PreToolUse", conversationId: "default", toolName: "read_file" });
        assert.equal(sm.getCurrentStatus(), PresenceStatus.EXECUTING_TOOL);

        // Stop arrives with conversationId "c1"
        const activity = await sm.handleHook({ event: "Stop", conversationId: "c1", terminationReason: "NO_TOOL_CALL" });
        assert.equal(sm.getCurrentStatus(), PresenceStatus.WAITING_REVIEW);
        assert.match(activity?.details ?? "", /Waiting for user review/);
    });
});

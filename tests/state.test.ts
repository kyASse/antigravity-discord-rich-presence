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

    it("caps details, state, and button labels to Discord RPC limits while keeping subagent suffix", async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "long-git-test-"));
        try {
            execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
            const longBranch = "feat/" + "very-long-branch-segment-".repeat(6);
            execFileSync("git", ["checkout", "-b", longBranch], { cwd: tmpDir, stdio: "ignore" });
            execFileSync(
                "git",
                ["config", "remote.origin.url", "https://github.com/test-owner/" + "r".repeat(500) + ".git"],
                { cwd: tmpDir, stdio: "ignore" }
            );

            const sm = new PresenceStateMachine({ ...DEFAULT_CONFIG, showRepoButton: true });
            await sm.handleHook({ event: "PreInvocation", conversationId: "sub1", isSubagent: true });
            const activity = await sm.handleHook({
                event: "PreToolUse",
                conversationId: "root",
                cwd: tmpDir,
                toolName: "run_command",
                toolArgs: { CommandLine: "echo " + "x".repeat(200) }
            });

            assert.ok((activity?.details?.length ?? 0) <= 128);
            assert.ok(activity?.details?.includes("(1 subagent active)"));
            assert.ok((activity?.state?.length ?? 0) <= 128);
            assert.equal(activity?.buttons, undefined); // > 512 chars URL omitted
            assert.deepEqual(sm.getCurrentActivity(), activity);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it("isolates cwd, gitInfo, and startTimestamp across concurrent workspaces and arbitrates by status then recency", async () => {
        const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "ws-a-"));
        const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "ws-b-"));
        try {
            execFileSync("git", ["init"], { cwd: dirA, stdio: "ignore" });
            execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dirA, stdio: "ignore" });
            execFileSync("git", ["config", "user.name", "Test User"], { cwd: dirA, stdio: "ignore" });
            execFileSync("git", ["checkout", "-b", "feat/alpha"], { cwd: dirA, stdio: "ignore" });
            execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: dirA, stdio: "ignore" });
            execFileSync("git", ["config", "remote.origin.url", "https://github.com/org/repo-alpha.git"], { cwd: dirA, stdio: "ignore" });

            execFileSync("git", ["init"], { cwd: dirB, stdio: "ignore" });
            execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dirB, stdio: "ignore" });
            execFileSync("git", ["config", "user.name", "Test User"], { cwd: dirB, stdio: "ignore" });
            execFileSync("git", ["checkout", "-b", "fix/beta"], { cwd: dirB, stdio: "ignore" });
            execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: dirB, stdio: "ignore" });
            execFileSync("git", ["config", "remote.origin.url", "https://github.com/org/repo-beta.git"], { cwd: dirB, stdio: "ignore" });

            let fakeNow = 1_000_000;
            const sm = new PresenceStateMachine(DEFAULT_CONFIG, { now: () => fakeNow });

            // Workspace A starts THINKING at t=1_000_000
            const actA = await sm.handleHook({ event: "PreInvocation", conversationId: "conv-a", cwd: dirA });
            assert.equal(actA?.state, "Project: repo-alpha (feat/alpha)");
            assert.equal(actA?.startTimestamp, 1_000_000);

            // Workspace B starts EXECUTING_TOOL at t=1_005_000 -> higher priority wins
            fakeNow = 1_005_000;
            const actB = await sm.handleHook({
                event: "PreToolUse",
                conversationId: "conv-b",
                cwd: dirB,
                toolName: "read_file",
                toolArgs: { Path: "beta.ts" }
            });
            assert.equal(actB?.state, "Project: repo-beta (fix/beta)");
            assert.equal(actB?.startTimestamp, 1_005_000);

            // Follow-up hook for conv-b omitting cwd keeps Workspace B context
            fakeNow = 1_006_000;
            const actB2 = await sm.handleHook({ event: "PostToolUse", conversationId: "conv-b" });
            assert.equal(actB2?.state, "Project: repo-beta (fix/beta)");

            // Cancelling Workspace B must not clear or overwrite Workspace A's git/startTimestamp
            fakeNow = 1_007_000;
            const afterCancelB = await sm.handleHook({
                event: "Stop",
                conversationId: "conv-b",
                terminationReason: "USER_CANCELED"
            });
            assert.equal(sm.getCurrentStatus(), PresenceStatus.THINKING);
            assert.equal(afterCancelB?.state, "Project: repo-alpha (feat/alpha)");
            assert.equal(afterCancelB?.startTimestamp, 1_000_000);
            assert.deepEqual(afterCancelB?.buttons, [
                { label: "View Repository", url: "https://github.com/org/repo-alpha" }
            ]);
        } finally {
            fs.rmSync(dirA, { recursive: true, force: true });
            fs.rmSync(dirB, { recursive: true, force: true });
        }
    });

    it("does not leak subagents from Workspace A into Workspace B's displayed details", async () => {
        const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "ws-sub-a-"));
        const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "ws-sub-b-"));
        try {
            let fakeNow = 2_000_000;
            const sm = new PresenceStateMachine(DEFAULT_CONFIG, { now: () => fakeNow });

            await sm.handleHook({ event: "PreInvocation", conversationId: "root-a", cwd: dirA });
            await sm.handleHook({ event: "PreInvocation", conversationId: "sub-a", isSubagent: true, cwd: dirA });

            fakeNow = 2_001_000;
            const actB = await sm.handleHook({
                event: "PreToolUse",
                conversationId: "root-b",
                cwd: dirB,
                toolName: "edit_file",
                toolArgs: { Path: "main.ts" }
            });
            assert.equal(actB?.details, "Editing main.ts");
            assert.equal(actB?.state, `Project: ${path.basename(dirB)}`);
        } finally {
            fs.rmSync(dirA, { recursive: true, force: true });
            fs.rmSync(dirB, { recursive: true, force: true });
        }
    });

    it("expires orphaned subagents after subagentTtlMs and recovers WAITING_REVIEW / STOPPED state", async () => {
        let fakeNow = 10_000;
        const sm = new PresenceStateMachine(DEFAULT_CONFIG, {
            subagentTtlMs: 5_000,
            now: () => fakeNow
        });

        await sm.handleHook({ event: "PreInvocation", conversationId: "root" });
        await sm.handleHook({ event: "PreToolUse", conversationId: "sub-orphan", isSubagent: true, toolName: "search_web" });
        await sm.handleHook({ event: "Stop", conversationId: "root", terminationReason: "NO_TOOL_CALL" });

        // Root finished turn, but orphaned subagent keeps status in EXECUTING_TOOL
        assert.equal(sm.getCurrentStatus(), PresenceStatus.EXECUTING_TOOL);
        assert.equal(sm.getActiveSubagentsCount(), 1);
        assert.equal(sm.getNextSubagentExpiryMs(), 5_000);

        // Advance before TTL: still active
        fakeNow = 14_000;
        assert.equal(sm.pruneStaleSubagents(), 0);
        assert.equal(sm.getNextSubagentExpiryMs(), 1_000);
        assert.equal(sm.getCurrentStatus(), PresenceStatus.EXECUTING_TOOL);

        // Advance past TTL: orphaned subagent pruned -> recovers to WAITING_REVIEW
        fakeNow = 15_000;
        assert.equal(sm.pruneStaleSubagents(), 1);
        assert.equal((sm as any).sessions.has("sub-orphan"), false);
        assert.equal(sm.getActiveSubagentsCount(), 0);
        assert.equal(sm.getNextSubagentExpiryMs(), null);
        assert.equal(sm.getCurrentStatus(), PresenceStatus.WAITING_REVIEW);
        assert.equal(sm.getCurrentActivity()?.details, "Waiting for user review");
    });

    it("refreshes subagent TTL on activity and returns STOPPED when only orphaned subagent existed", async () => {
        let fakeNow = 20_000;
        const sm = new PresenceStateMachine(DEFAULT_CONFIG, {
            subagentTtlMs: 5_000,
            now: () => fakeNow
        });

        await sm.handleHook({ event: "PreInvocation", conversationId: "sub-only", isSubagent: true });
        fakeNow = 24_000;
        // Heartbeat / tool event resets subagent updatedAt
        await sm.handleHook({ event: "PreToolUse", conversationId: "sub-only", isSubagent: true, toolName: "read_file", toolArgs: { Path: "a.ts" } });

        fakeNow = 26_000; // 2s since last update (< 5s TTL)
        assert.equal(sm.getCurrentStatus(), PresenceStatus.EXECUTING_TOOL);

        fakeNow = 29_000; // 5s since last update (>= 5s TTL)
        assert.equal(sm.getCurrentStatus(), PresenceStatus.STOPPED);
        assert.equal(sm.getCurrentActivity(), null);
    });
});

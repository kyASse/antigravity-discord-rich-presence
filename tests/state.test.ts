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

    it("maps legacy privacyMode=true to stealth mode by hiding repo, tool details, buttons, and party", async () => {
        const privateConfig = { ...DEFAULT_CONFIG, privacyMode: true };
        const sm = new PresenceStateMachine(privateConfig);
        const activity = await sm.handleHook({
            event: "PreToolUse",
            conversationId: "c1",
            toolName: "run_command",
            toolArgs: { CommandLine: "git commit -m 'secret token 123'" }
        });
        assert.equal(activity?.details, "Working in Antigravity");
        assert.equal(activity?.state, undefined);
        assert.equal(activity?.smallImageKey, undefined);
        assert.equal(activity?.smallImageText, undefined);
        assert.equal(activity?.buttons, undefined);
        assert.equal(activity?.party, undefined);
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

    it("refreshes subagent TTL on activity, returns STOPPED when only orphaned subagent existed, and resets startTimestamp on new session", async () => {
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

        // New session after orphaned subagents expired gets a fresh startTimestamp
        fakeNow = 50_000;
        const fresh = await sm.handleHook({ event: "PreInvocation", conversationId: "fresh-root" });
        assert.equal(fresh?.startTimestamp, 50_000);
    });

    it("populates Discord RPC party metrics during active subagent swarms, clears when subagents end, and resets peak across consecutive swarms", async () => {
        let fakeNow = 10_000;
        const sm = new PresenceStateMachine(DEFAULT_CONFIG, { now: () => fakeNow });

        // Primary agent alone: no party
        const solo = await sm.handleHook({ event: "PreInvocation", conversationId: "root-swarm" });
        assert.equal(solo?.party, undefined);

        // 2 subagents join -> 3 active agents of peak 3
        fakeNow = 10_100;
        await sm.handleHook({ event: "PreInvocation", conversationId: "sub-1", isSubagent: true });
        fakeNow = 10_200;
        const swarm3 = await sm.handleHook({
            event: "PreToolUse",
            conversationId: "sub-2",
            isSubagent: true,
            toolName: "search_web"
        });
        assert.deepEqual(swarm3?.party, { id: "root-swarm", size: [3, 3] });

        // 1 subagent completes -> 2 active of peak 3
        fakeNow = 10_300;
        const swarm2 = await sm.handleHook({
            event: "Stop",
            conversationId: "sub-2",
            isSubagent: true,
            terminationReason: "NO_TOOL_CALL"
        });
        assert.deepEqual(swarm2?.party, { id: "root-swarm", size: [2, 3] });

        // Last subagent completes -> party cleared
        fakeNow = 10_400;
        const backToSolo = await sm.handleHook({
            event: "Stop",
            conversationId: "sub-1",
            isSubagent: true,
            terminationReason: "NO_TOOL_CALL"
        });
        assert.equal(backToSolo?.party, undefined);

        // Consecutive swarm resets peakActiveAgents back to [2, 2]
        fakeNow = 10_500;
        const nextSwarm = await sm.handleHook({ event: "PreInvocation", conversationId: "sub-3", isSubagent: true });
        assert.deepEqual(nextSwarm?.party, { id: "root-swarm", size: [2, 2] });
    });

    it("falls back to antigravity-swarm party.id when no non-subagent primary session exists in the winning workspace", async () => {
        const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "ws-sub-only-"));
        try {
            let fakeNow = 30_000;
            const sm = new PresenceStateMachine(DEFAULT_CONFIG, { now: () => fakeNow });

            await sm.handleHook({ event: "PreInvocation", conversationId: "sub-only-1", isSubagent: true, cwd: dirA });
            fakeNow = 30_100;
            const act = await sm.handleHook({ event: "PreInvocation", conversationId: "sub-only-2", isSubagent: true, cwd: dirA });
            assert.deepEqual(act?.party, { id: "antigravity-swarm", size: [2, 2] });
        } finally {
            fs.rmSync(dirA, { recursive: true, force: true });
        }
    });

    it("prevents unscoped subagent in DEFAULT_WORKSPACE_KEY from hijacking an active non-default workspace", async () => {
        const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "ws-unscoped-"));
        try {
            let fakeNow = 1_000;
            const sm = new PresenceStateMachine(DEFAULT_CONFIG, { now: () => fakeNow });

            await sm.handleHook({ event: "PreInvocation", conversationId: "root", cwd: dirA });
            fakeNow = 1_001;
            const act = await sm.handleHook({ event: "PreInvocation", conversationId: "sub1", isSubagent: true });

            assert.equal(act?.state, `Project: ${path.basename(dirA)}`);
            assert.equal(act?.startTimestamp, 1_000);
            assert.deepEqual(act?.party, { id: "root", size: [2, 2] });
        } finally {
            fs.rmSync(dirA, { recursive: true, force: true });
        }
    });

    it("scopes SessionEnd to target workspace without stopping other active workspaces", async () => {
        const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "ws-end-a-"));
        const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "ws-end-b-"));
        try {
            let fakeNow = 40_000;
            const sm = new PresenceStateMachine(DEFAULT_CONFIG, { now: () => fakeNow });

            await sm.handleHook({ event: "PreInvocation", conversationId: "conv-a", cwd: dirA });
            fakeNow = 40_100;
            await sm.handleHook({ event: "PreInvocation", conversationId: "conv-b", cwd: dirB });

            fakeNow = 40_200;
            const afterEndB = await sm.handleHook({ event: "SessionEnd", conversationId: "conv-b" });
            assert.equal(sm.getCurrentStatus(), PresenceStatus.THINKING);
            assert.equal(afterEndB?.state, `Project: ${path.basename(dirA)}`);
            assert.equal(afterEndB?.startTimestamp, 40_000);
        } finally {
            fs.rmSync(dirA, { recursive: true, force: true });
            fs.rmSync(dirB, { recursive: true, force: true });
        }
    });

    it("caps party.id to 128 characters and isolates party counts per workspace", async () => {
        const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "party-a-"));
        const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "party-b-"));
        try {
            let fakeNow = 5_000;
            const sm = new PresenceStateMachine(DEFAULT_CONFIG, { now: () => fakeNow });
            const longConvId = "swarm-" + "x".repeat(150);

            await sm.handleHook({ event: "PreInvocation", conversationId: longConvId, cwd: dirA });
            const actA = await sm.handleHook({ event: "PreInvocation", conversationId: "sub-a1", isSubagent: true, cwd: dirA });
            assert.ok(actA?.party);
            assert.ok(actA.party.id.length >= 2 && actA.party.id.length <= 128);
            assert.deepEqual(actA.party.size, [2, 2]);

            // Workspace B with 1 subagent only counts its own agents
            fakeNow = 6_000;
            await sm.handleHook({ event: "PreInvocation", conversationId: "root-b", cwd: dirB });
            const actB = await sm.handleHook({
                event: "PreToolUse",
                conversationId: "sub-b1",
                isSubagent: true,
                cwd: dirB,
                toolName: "read_file",
                toolArgs: { Path: "index.ts" }
            });
            assert.deepEqual(actB?.party, { id: "root-b", size: [2, 2] });
        } finally {
            fs.rmSync(dirA, { recursive: true, force: true });
            fs.rmSync(dirB, { recursive: true, force: true });
        }
    });

    it("enforces stealth profile across all states and suppresses party/state/smallImage/buttons", async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "stealth-state-test-"));
        try {
            execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
            execFileSync(
                "git",
                ["config", "remote.origin.url", "https://github.com/test-owner/secret-repo.git"],
                { cwd: tmpDir, stdio: "ignore" }
            );

            const sm = new PresenceStateMachine({
                ...DEFAULT_CONFIG,
                privacyProfile: "stealth",
                showRepoButton: true
            });

            await sm.handleHook({ event: "PreInvocation", conversationId: "root", cwd: tmpDir });
            const executing = await sm.handleHook({
                event: "PreToolUse",
                conversationId: "sub1",
                isSubagent: true,
                cwd: tmpDir,
                toolName: "read_file",
                toolArgs: { Path: "secret-file.ts" }
            });
            assert.equal(executing?.details, "Working in Antigravity");
            assert.equal(executing?.state, undefined);
            assert.equal(executing?.buttons, undefined);
            assert.equal(executing?.smallImageKey, undefined);
            assert.equal(executing?.smallImageText, undefined);
            assert.equal(executing?.party, undefined);
            assert.equal(executing?.largeImageKey, "antigravity");
            assert.ok(executing?.startTimestamp);

            await sm.handleHook({ event: "Stop", conversationId: "sub1", isSubagent: true, terminationReason: "NO_TOOL_CALL" });
            const review = await sm.handleHook({ event: "Stop", conversationId: "root", terminationReason: "NO_TOOL_CALL" });
            assert.equal(review?.details, "Working in Antigravity");
            assert.equal(review?.state, undefined);
            assert.equal(review?.smallImageKey, undefined);

            const idle = sm.handleIdleTimeout();
            assert.equal(idle?.details, "Working in Antigravity");
            assert.equal(idle?.state, undefined);
            assert.equal(idle?.smallImageKey, undefined);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it("applies balanced vs showcase tool and sensitive filename rules in state machine", async () => {
        const balancedSm = new PresenceStateMachine({ ...DEFAULT_CONFIG, privacyProfile: "balanced" });
        const envAct = await balancedSm.handleHook({
            event: "PreToolUse",
            conversationId: "c1",
            toolName: "read_file",
            toolArgs: { Path: "/app/.env.production" }
        });
        assert.equal(envAct?.details, "Reading sensitive file");

        const cmdBalanced = await balancedSm.handleHook({
            event: "PreToolUse",
            conversationId: "c1",
            toolName: "run_command",
            toolArgs: { toolSummary: "Deploy prod", CommandLine: "npm run deploy --token=secret" }
        });
        assert.equal(cmdBalanced?.details, "Running: npm");

        const showcaseSm = new PresenceStateMachine({ ...DEFAULT_CONFIG, privacyProfile: "showcase" });
        const envShowcase = await showcaseSm.handleHook({
            event: "PreToolUse",
            conversationId: "c2",
            toolName: "read_file",
            toolArgs: { Path: "/app/.env" }
        });
        assert.equal(envShowcase?.details, "Reading sensitive file");

        const cmdShowcase = await showcaseSm.handleHook({
            event: "PreToolUse",
            conversationId: "c2",
            toolName: "run_command",
            toolArgs: { toolSummary: "Deploy using TOKEN=ghp_123456" }
        });
        assert.equal(cmdShowcase?.details, "Running: Deploy using TOKEN=***");
    });

    it("resolves per-workspace .agents/discord-rpc.json overrides with 5s TTL cache and env precedence", async () => {
        const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "ws-cfg-a-"));
        const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "ws-cfg-b-"));
        try {
            fs.mkdirSync(path.join(dirA, ".agents"), { recursive: true });
            fs.mkdirSync(path.join(dirB, ".agents"), { recursive: true });
            fs.writeFileSync(
                path.join(dirA, ".agents", "discord-rpc.json"),
                JSON.stringify({ privacyProfile: "stealth", idleTimeoutSeconds: 90 }),
                "utf-8"
            );
            fs.writeFileSync(
                path.join(dirB, ".agents", "discord-rpc.json"),
                JSON.stringify({ privacyProfile: "showcase", showRepoButton: false, idleTimeoutSeconds: 45 }),
                "utf-8"
            );

            let fakeNow = 10_000;
            const sm = new PresenceStateMachine(DEFAULT_CONFIG, { now: () => fakeNow });

            // Workspace A: stealth with active subagent suppresses party/state/smallImage
            await sm.handleHook({ event: "PreInvocation", conversationId: "root-a", cwd: dirA });
            const actA = await sm.handleHook({ event: "PreInvocation", conversationId: "sub-a", isSubagent: true, cwd: dirA });
            assert.equal(actA?.details, "Working in Antigravity");
            assert.equal(actA?.state, undefined);
            assert.equal(actA?.party, undefined);
            assert.equal(sm.getActiveIdleTimeoutSeconds(), 90);

            // Workspace B wins with EXECUTING_TOOL and uses showcase + showRepoButton: false + idleTimeoutSeconds: 45
            fakeNow = 11_000;
            await sm.handleHook({ event: "PreInvocation", conversationId: "root-b", cwd: dirB });
            const actB = await sm.handleHook({
                event: "PreToolUse",
                conversationId: "sub-b",
                isSubagent: true,
                cwd: dirB,
                toolName: "run_command",
                toolArgs: { toolSummary: "Run integration tests" }
            });
            assert.equal(actB?.details, "Running: Run integration tests");
            assert.equal(actB?.state, `Project: ${path.basename(dirB)}`);
            assert.equal(actB?.buttons, undefined);
            assert.deepEqual(actB?.party, { id: "root-b", size: [2, 2] });
            assert.equal(sm.getActiveIdleTimeoutSeconds(), 45);

            // Update Workspace B config on disk; cached within 5s, refreshed after > 5s
            fs.writeFileSync(
                path.join(dirB, ".agents", "discord-rpc.json"),
                JSON.stringify({ privacyProfile: "stealth" }),
                "utf-8"
            );
            fakeNow = 13_000;
            const cachedB = sm.getCurrentActivity();
            assert.match(cachedB?.details ?? "", /Run integration tests/);

            fakeNow = 17_000;
            const refreshedB = sm.getCurrentActivity();
            assert.equal(refreshedB?.details, "Working in Antigravity");
            assert.equal(refreshedB?.party, undefined);

            // Explicit env override trumps workspace .agents/discord-rpc.json
            const envSm = new PresenceStateMachine(DEFAULT_CONFIG, {
                env: { AGY_DISCORD_PRIVACY_PROFILE: "showcase" },
                globalConfig: { privacyProfile: "stealth" }
            });
            fs.writeFileSync(
                path.join(dirA, ".agents", "discord-rpc.json"),
                JSON.stringify({ privacyProfile: "stealth" }),
                "utf-8"
            );
            const envAct = await envSm.handleHook({
                event: "PreToolUse",
                conversationId: "c-env",
                cwd: dirA,
                toolName: "run_command",
                toolArgs: { toolSummary: "Full showcase command" }
            });
            assert.equal(envAct?.details, "Running: Full showcase command");
        } finally {
            fs.rmSync(dirA, { recursive: true, force: true });
            fs.rmSync(dirB, { recursive: true, force: true });
        }
    });
});

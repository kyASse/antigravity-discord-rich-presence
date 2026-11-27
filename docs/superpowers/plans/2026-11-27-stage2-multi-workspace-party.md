# Stage 2: Multi-Workspace Isolation & Swarm "Party" Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Isolate per-workspace context (`cwd`, `gitInfo`, `startTimestamp`), automatically expire orphaned subagents via TTL, and surface native Discord RPC `party` metrics for multi-agent sessions.

**Architecture:** `PresenceStateMachine` (`src/state.ts`) replaces single global workspace fields with a `workspaces` map keyed by normalized `cwd`, arbitrates the displayed workspace by status priority then recency, prunes stale subagents via `pruneStaleSubagents()`, and emits `PresenceActivity.party`. `RpcDaemon` (`src/daemon.ts`) forwards `party` using `@xhayper/discord-rpc`'s `partyId`/`partySize`/`partyMax` fields, includes `party` in payload deduplication, and runs an `.unref()`ed subagent reaper timer.

**Tech Stack:** Node.js (v18+/v24 ESM), TypeScript, `@xhayper/discord-rpc`, `node:test`, `node:assert/strict`, `tsx`, `esbuild`.

**Spec:** `docs/superpowers/specs/2026-11-27-stage2-multi-workspace-party-design.md`

## Global Constraints
- Runtime & Build: Node.js 18+ ESM; `npm run build` (`scripts/build.mjs`) bundles standalone `bin/daemon.js` and `bin/dispatch.js`.
- Discord RPC Limits: `details`, `state`, `largeImageText`, `smallImageText`, and `party.id` max **128** chars (min **2** chars); `party.size` is `[active, max]` with `1 <= active <= max`.
- `@xhayper/discord-rpc` Contract: `ClientUser.setActivity()` expects flat `partyId`, `partySize`, `partyMax` properties (not nested `party`).
- Backward Compatibility: Preserve `DEFAULT_CONFIG` exact shape, `new RpcDaemon()` / `new PresenceStateMachine()` default behavior, `(sm as any).sessions` map property, and subagent hooks that omit `cwd`.
- Test Isolation: No real multi-minute waits in unit tests; inject `subagentTtlMs` / `now` clock hooks and use unique per-process IPC paths.

## Review Focus
1. **Workspace B `cwd` & `Stop(USER_CANCELED)` Isolation:** Updating `cwd` or cancelling a session in Workspace B must never overwrite Workspace A's `gitInfo`/`startTimestamp` or terminate Workspace A's active sessions. (Pinned in Task 2).
2. **Omitted `cwd` Continuity & Unscoped Subagent Compatibility:** Follow-up hooks for an existing conversation that omit `cwd` must preserve that session's workspace, and subagents spawned without `cwd` must remain counted when another workspace is active. (Pinned in Task 2).
3. **Orphaned Subagent TTL Expiration Without New Hooks:** A crashed subagent that never sends `Stop` must be pruned automatically after `subagentTtlMs` elapses, allowing `RpcDaemon` to transition back to `WAITING_REVIEW` and arm `idleTimer` even if no further IPC hooks arrive. (Pinned in Task 3 and Task 5).
4. **Discord RPC `party` Bounds & `SetActivity` Mapping:** `party.id` must be 2–128 chars, `party.size` must satisfy `1 <= active <= max`, and `RpcDaemon` must map `activity.party` to `partyId`/`partySize`/`partyMax` and include `party` in `computeSignature()`. (Pinned in Task 4 and Task 5).
5. **Cross-Workspace Consistency on Arbitration:** When Workspace A (`THINKING` with subagents) and Workspace B (`EXECUTING_TOOL` without subagents) coexist, `details`, `state`, `startTimestamp`, `buttons`, and `party` must all come consistently from the winning workspace. (Pinned in Task 2 and Task 4).

---

### Task 1: Add `PresenceActivity.party` and Subagent TTL Env Helpers

**Files:**
- Modify: `src/types.ts:19-100`
- Test: `tests/types.test.ts:1-71`

**Interfaces:**
- Consumes: `PresenceActivity` (`src/types.ts`)
- Produces:
  - `PresenceActivity.party?: { id: string; size: [number, number] }` (`src/types.ts`)
  - `DEFAULT_SUBAGENT_TTL_MS = 600_000` (`src/types.ts`)
  - `loadSubagentTtlMsFromEnv(env?: NodeJS.ProcessEnv): number` (`src/types.ts`)

- [ ] **Step 1: Write failing test in `tests/types.test.ts`**

```typescript
// Update import and add test inside describe("Types & Defaults") in tests/types.test.ts
import {
    PresenceStatus,
    DEFAULT_CONFIG,
    DEFAULT_SUBAGENT_TTL_MS,
    loadConfigFromEnv,
    loadWatchdogTimeoutMsFromEnv,
    loadSubagentTtlMsFromEnv,
    encodeInitialPayload,
    decodeInitialPayload,
    type PresenceActivity
} from "../src/types";

it("exports DEFAULT_SUBAGENT_TTL_MS, loads AGY_DISCORD_SUBAGENT_TTL safely, and supports PresenceActivity.party", () => {
    assert.equal(DEFAULT_SUBAGENT_TTL_MS, 600_000);
    assert.equal(loadSubagentTtlMsFromEnv({}), 600_000);
    assert.equal(loadSubagentTtlMsFromEnv({ AGY_DISCORD_SUBAGENT_TTL: " 120 " }), 120_000);
    assert.equal(loadSubagentTtlMsFromEnv({ AGY_DISCORD_SUBAGENT_TTL: "0" }), 600_000);
    assert.equal(loadSubagentTtlMsFromEnv({ AGY_DISCORD_SUBAGENT_TTL: "-10" }), 600_000);
    assert.equal(loadSubagentTtlMsFromEnv({ AGY_DISCORD_SUBAGENT_TTL: "invalid" }), 600_000);

    const activity: PresenceActivity = {
        details: "Agent is thinking...",
        party: { id: "conv-1", size: [2, 3] }
    };
    assert.deepEqual(activity.party, { id: "conv-1", size: [2, 3] });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/types.test.ts`
Expected: FAIL (`DEFAULT_SUBAGENT_TTL_MS` / `loadSubagentTtlMsFromEnv` not exported).

- [ ] **Step 3: Implement `PresenceActivity.party`, `DEFAULT_SUBAGENT_TTL_MS`, and `loadSubagentTtlMsFromEnv()` in `src/types.ts`**

Add `party?: { id: string; size: [number, number] };` to `PresenceActivity`. Export `export const DEFAULT_SUBAGENT_TTL_MS = 600_000;` and `export function loadSubagentTtlMsFromEnv(env: NodeJS.ProcessEnv = process.env): number` parsing `AGY_DISCORD_SUBAGENT_TTL` as positive finite base-10 integer seconds multiplied by `1000`, falling back to `DEFAULT_SUBAGENT_TTL_MS`. Leave `DEFAULT_CONFIG` untouched.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/types.test.ts`
Expected: PASS (all tests in `tests/types.test.ts` pass).

- [ ] **Step 5: Commit**

```bash
git add src/types.ts tests/types.test.ts
git commit -m "feat: add PresenceActivity.party type and subagent TTL env loader"
```

---

### Task 2: Workspace-Scoped Context & Arbitration in `PresenceStateMachine`

**Files:**
- Modify: `src/state.ts:1-386`
- Test: `tests/state.test.ts:1-192`

**Interfaces:**
- Consumes: `HookPayload`, `PresenceActivity`, `PresenceStatus`, `PluginConfig`, `DEFAULT_CONFIG` (`src/types.ts`), `getGitInfo` (`src/git.ts`), `truncateRpcText`, `validateRpcButtonUrl`, `mapToolToAction` (`src/sanitizer.ts`)
- Produces:
  - Per-workspace `WorkspaceContext` isolation (`cwd`, `gitInfo`, `startTimestamp`, `updatedAt`, 5s git cache) inside `PresenceStateMachine`
  - `DEFAULT_WORKSPACE_KEY = "__default__"` and `normalizeWorkspaceKey(cwd: string): string`
  - Workspace arbitration by status precedence (`EXECUTING_TOOL > THINKING > WAITING_REVIEW > IDLE > STOPPED`) then latest `updatedAt`
  - Scoped `Stop` / `SessionEnd` cancellation per workspace

- [ ] **Step 1: Write failing tests in `tests/state.test.ts`**

```typescript
// Append inside describe("Presence State Machine") in tests/state.test.ts
it("isolates cwd, gitInfo, and startTimestamp across concurrent workspaces and arbitrates by status then recency", async () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "ws-a-"));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "ws-b-"));
    try {
        execFileSync("git", ["init"], { cwd: dirA, stdio: "ignore" });
        execFileSync("git", ["checkout", "-b", "feat/alpha"], { cwd: dirA, stdio: "ignore" });
        execFileSync("git", ["config", "remote.origin.url", "https://github.com/org/repo-alpha.git"], { cwd: dirA, stdio: "ignore" });

        execFileSync("git", ["init"], { cwd: dirB, stdio: "ignore" });
        execFileSync("git", ["checkout", "-b", "fix/beta"], { cwd: dirB, stdio: "ignore" });
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/state.test.ts`
Expected: FAIL (`PresenceStateMachine` constructor ignores `options` / Workspace B overwrites Workspace A and `USER_CANCELED` wipes Workspace A).

- [ ] **Step 3: Refactor `PresenceStateMachine` in `src/state.ts` for workspace-scoped context and arbitration**

Implementation details to pin in `src/state.ts`:
- Add `export interface PresenceStateMachineOptions { subagentTtlMs?: number; now?: () => number; }` and accept `options: PresenceStateMachineOptions = {}` in `constructor(config = DEFAULT_CONFIG, options = {})`.
- Define `DEFAULT_WORKSPACE_KEY = "__default__"` and `normalizeWorkspaceKey(cwd: string): string` (using `path.resolve(cwd)`; lowercase on `win32` for stable map keying while keeping `path.resolve(cwd)` as `WorkspaceContext.cwd`).
- Add `workspaceKey: string` to `SessionState`. On `handleHook(payload)`:
  - If `payload.cwd` is non-empty, compute `workspaceKey = normalizeWorkspaceKey(payload.cwd)` and update `session.workspaceKey = workspaceKey`.
  - Else if `session` already exists, reuse `session.workspaceKey`.
  - Else use `DEFAULT_WORKSPACE_KEY`.
- Maintain `private readonly workspaces = new Map<string, WorkspaceContext>()` storing `{ key, cwd, gitInfo, lastGitFetchTime, startTimestamp, peakActiveAgents, updatedAt }`.
- Cache `getGitInfo(ws.cwd)` on each `WorkspaceContext` independently (5,000 ms TTL).
- Scope non-`NO_TOOL_CALL` `Stop` and `SessionEnd` cancellation to sessions where `s.workspaceKey === targetWorkspaceKey` (rather than wiping all workspaces).
- Add status precedence helper (`EXECUTING_TOOL=4, THINKING=3, WAITING_REVIEW=2, IDLE=1, STOPPED=0`) and `getWinningWorkspace(): { workspace: WorkspaceContext; status: PresenceStatus } | null` choosing highest status priority across workspaces, tie-broken by highest `workspace.updatedAt`.
- Update `getActiveSubagentsCount(workspaceKey?: string): number` so when `workspaceKey` is provided (and !== `DEFAULT_WORKSPACE_KEY`), it counts active subagents where `s.workspaceKey === workspaceKey || s.workspaceKey === DEFAULT_WORKSPACE_KEY`; when omitted, it counts all active subagents across `this.sessions`.
- Update `buildActivity()`, `formatState()`, `getButtons()`, and `getExecutingSession(workspaceKey)` to read exclusively from the winning workspace. When a workspace's derived status drops to `STOPPED`, clear `ws.startTimestamp = undefined` and `ws.peakActiveAgents = 0`.
- Keep `private readonly sessions = new Map<string, SessionState>()` intact so existing tests inspecting `(sm as any).sessions` pass.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/state.test.ts`
Expected: PASS (all existing + new multi-workspace tests in `tests/state.test.ts` pass).

- [ ] **Step 5: Commit**

```bash
git add src/state.ts tests/state.test.ts
git commit -m "feat: isolate workspace contexts and add multi-workspace arbitration"
```

---

### Task 3: Orphaned Subagent TTL Reaper in `PresenceStateMachine`

**Files:**
- Modify: `src/state.ts`
- Test: `tests/state.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_SUBAGENT_TTL_MS` (`src/types.ts`), `PresenceStateMachineOptions.subagentTtlMs` (`src/state.ts`)
- Produces:
  - `PresenceStateMachine.pruneStaleSubagents(now?: number): number`
  - `PresenceStateMachine.getNextSubagentExpiryMs(now?: number): number | null`

- [ ] **Step 1: Write failing tests in `tests/state.test.ts`**

```typescript
// Append inside describe("Presence State Machine") in tests/state.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/state.test.ts`
Expected: FAIL (`sm.pruneStaleSubagents is not a function`).

- [ ] **Step 3: Implement `pruneStaleSubagents()` and `getNextSubagentExpiryMs()` in `src/state.ts`**

- Store `private readonly subagentTtlMs = options.subagentTtlMs ?? DEFAULT_SUBAGENT_TTL_MS;` and `private readonly now = options.now ?? (() => Date.now());` (import `DEFAULT_SUBAGENT_TTL_MS` from `./types.js`).
- `public pruneStaleSubagents(now: number = this.now()): number`: deletes all `SessionState` entries where `session.isSubagent && now - session.updatedAt >= this.subagentTtlMs`, returns count deleted, and for any affected workspace whose derived status is now `STOPPED`, resets `ws.startTimestamp = undefined` and `ws.peakActiveAgents = 0`.
- `public getNextSubagentExpiryMs(now: number = this.now()): number | null`: scans `this.sessions` for `isSubagent === true` and returns the minimum `Math.max(1, this.subagentTtlMs - (now - session.updatedAt))`, or `null` if none.
- Call `this.pruneStaleSubagents(now)` at the start of `handleHook()`, `handleIdleTimeout()`, `getCurrentStatus()`, `getActiveSubagentsCount()`, and `getCurrentActivity()`. Use `this.now()` consistently for `now` timestamps inside `PresenceStateMachine`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/state.test.ts`
Expected: PASS (all tests in `tests/state.test.ts` pass).

- [ ] **Step 5: Commit**

```bash
git add src/state.ts tests/state.test.ts
git commit -m "feat: add orphaned subagent TTL reaper to PresenceStateMachine"
```

---

### Task 4: Discord RPC `party` Metrics in `PresenceStateMachine`

**Files:**
- Modify: `src/state.ts`
- Test: `tests/state.test.ts`

**Interfaces:**
- Consumes: `PresenceActivity.party` (`src/types.ts`), `truncateRpcText` (`src/sanitizer.ts`), `WorkspaceContext` (`src/state.ts`)
- Produces:
  - `PresenceActivity.party = { id, size: [activeAgents, maxAgents] }` emitted by `PresenceStateMachine.buildActivity()` whenever active subagent count for the winning workspace `> 0`

- [ ] **Step 1: Write failing tests in `tests/state.test.ts`**

```typescript
// Append inside describe("Presence State Machine") in tests/state.test.ts
it("populates Discord RPC party metrics during active subagent swarms and clears when subagents end", async () => {
    const sm = new PresenceStateMachine(DEFAULT_CONFIG);

    // Primary agent alone: no party
    const solo = await sm.handleHook({ event: "PreInvocation", conversationId: "root-swarm" });
    assert.equal(solo?.party, undefined);

    // 2 subagents join -> 3 active agents of peak 3
    await sm.handleHook({ event: "PreInvocation", conversationId: "sub-1", isSubagent: true });
    const swarm3 = await sm.handleHook({
        event: "PreToolUse",
        conversationId: "sub-2",
        isSubagent: true,
        toolName: "search_web"
    });
    assert.deepEqual(swarm3?.party, { id: "root-swarm", size: [3, 3] });

    // 1 subagent completes -> 2 active of peak 3
    const swarm2 = await sm.handleHook({
        event: "Stop",
        conversationId: "sub-2",
        isSubagent: true,
        terminationReason: "NO_TOOL_CALL"
    });
    assert.deepEqual(swarm2?.party, { id: "root-swarm", size: [2, 3] });

    // Last subagent completes -> party cleared
    const backToSolo = await sm.handleHook({
        event: "Stop",
        conversationId: "sub-1",
        isSubagent: true,
        terminationReason: "NO_TOOL_CALL"
    });
    assert.equal(backToSolo?.party, undefined);
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/state.test.ts`
Expected: FAIL (`act?.party` is `undefined`).

- [ ] **Step 3: Implement `party` computation in `src/state.ts`**

In `PresenceStateMachine.buildActivity()`:
- Compute `subCount` for the winning workspace.
- If `(status === PresenceStatus.THINKING || status === PresenceStatus.EXECUTING_TOOL) && subCount > 0`:
  - Determine if the winning workspace has an active (`THINKING` or `EXECUTING_TOOL`) non-subagent primary session; `activeAgents = (hasActivePrimary ? 1 : 0) + subCount`.
  - Update `winningWorkspace.peakActiveAgents = Math.max(winningWorkspace.peakActiveAgents, activeAgents)`.
  - Resolve `rawPartyId`: primary non-subagent `conversationId` in winning workspace (prefer active, fallback any non-subagent in that workspace, else `"antigravity-swarm"`). Sanitize via `truncateRpcText(rawPartyId, 128) || "antigravity-swarm"`.
  - Set `party: { id: partyId, size: [activeAgents, winningWorkspace.peakActiveAgents] }` on the returned `PresenceActivity`.
- Otherwise omit `party`, and reset `winningWorkspace.peakActiveAgents = 0` when `subCount === 0` or status is `WAITING_REVIEW` / `IDLE` / `STOPPED`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/state.test.ts`
Expected: PASS (all tests in `tests/state.test.ts` pass).

- [ ] **Step 5: Commit**

```bash
git add src/state.ts tests/state.test.ts
git commit -m "feat: emit Discord RPC party metrics for active subagent swarms"
```

---

### Task 5: `RpcDaemon` Party Forwarding, Deduplication, Subagent Reaper Timer & Bundle Rebuild

**Files:**
- Modify: `src/daemon.ts:15-490`
- Test: `tests/ipc.test.ts:101-509`
- Rebuild: `bin/daemon.js`, `bin/dispatch.js`

**Interfaces:**
- Consumes:
  - `PresenceActivity.party` (`src/types.ts`)
  - `loadSubagentTtlMsFromEnv()` (`src/types.ts`)
  - `PresenceStateMachine.pruneStaleSubagents()`, `PresenceStateMachine.getNextSubagentExpiryMs()` (`src/state.ts`)
- Produces:
  - `DaemonOptions.subagentTtlMs?: number` (`src/daemon.ts`)
  - `@xhayper/discord-rpc` `partyId`, `partySize`, `partyMax` mapping in `sendPresenceToDiscord()` (`src/daemon.ts`)
  - `party` included in `computeSignature()` (`src/daemon.ts`)
  - `.unref()`ed `subagentReaperTimer` in `RpcDaemon` (`src/daemon.ts`)
  - Updated `bin/daemon.js` & `bin/dispatch.js`

- [ ] **Step 1: Write failing tests in `tests/ipc.test.ts`**

```typescript
// Append inside describe("RPC Daemon Core") in tests/ipc.test.ts
it("forwards partyId/partySize/partyMax to Discord RPC and triggers updates on party size changes", async () => {
    const testPipe = process.platform === "win32"
        ? `\\\\.\\pipe\\agy-daemon-party-${process.pid}`
        : `/tmp/agy-daemon-party-${process.pid}.sock`;

    const setCalls: any[] = [];
    const mockRpc = {
        login: async () => {},
        destroy: async () => {},
        user: {
            setActivity: async (act: any) => {
                setCalls.push(act);
                return act;
            },
            clearActivity: async () => {}
        }
    };

    const daemon = new RpcDaemon(DEFAULT_CONFIG, {
        ipcPath: testPipe,
        throttleMs: 0,
        rpcClient: mockRpc as any
    });

    try {
        await daemon.start();
        await daemon.handlePayload({ event: "PreInvocation", conversationId: "root-p" });
        await daemon.handlePayload({ event: "PreInvocation", conversationId: "sub-p1", isSubagent: true });
        await daemon.handlePayload({ event: "PreInvocation", conversationId: "sub-p2", isSubagent: true });
        await daemon.handlePayload({ event: "Stop", conversationId: "sub-p2", isSubagent: true, terminationReason: "NO_TOOL_CALL" });

        assert.equal(setCalls.length, 4);
        assert.equal(setCalls[0].partyId, undefined);
        assert.equal(setCalls[1].partyId, "root-p");
        assert.equal(setCalls[1].partySize, 2);
        assert.equal(setCalls[1].partyMax, 2);
        assert.equal(setCalls[2].partySize, 3);
        assert.equal(setCalls[2].partyMax, 3);
        assert.equal(setCalls[3].partySize, 2);
        assert.equal(setCalls[3].partyMax, 3);
    } finally {
        await daemon.stop();
    }
});

it("automatically prunes orphaned subagents via reaper timer and transitions to WAITING_REVIEW / IDLE", async () => {
    const testPipe = process.platform === "win32"
        ? `\\\\.\\pipe\\agy-daemon-reaper-${process.pid}`
        : `/tmp/agy-daemon-reaper-${process.pid}.sock`;

    const setCalls: any[] = [];
    const mockRpc = {
        login: async () => {},
        destroy: async () => {},
        user: {
            setActivity: async (act: any) => {
                setCalls.push(act);
                return act;
            },
            clearActivity: async () => {}
        }
    };

    const daemon = new RpcDaemon(
        { ...DEFAULT_CONFIG, idleTimeoutSeconds: 0.05 },
        {
            ipcPath: testPipe,
            throttleMs: 0,
            subagentTtlMs: 40,
            rpcClient: mockRpc as any
        }
    );

    try {
        await daemon.start();
        await daemon.handlePayload({ event: "PreInvocation", conversationId: "root-r" });
        await daemon.handlePayload({ event: "PreToolUse", conversationId: "sub-r", isSubagent: true, toolName: "search_web" });
        await daemon.handlePayload({ event: "Stop", conversationId: "root-r", terminationReason: "NO_TOOL_CALL" });

        assert.equal(daemon.stateMachine.getCurrentStatus(), PresenceStatus.EXECUTING_TOOL);

        // Wait for subagent TTL reaper (40ms) without sending any new IPC events
        await new Promise((r) => setTimeout(r, 70));
        assert.equal(daemon.stateMachine.getCurrentStatus(), PresenceStatus.WAITING_REVIEW);
        assert.ok(setCalls.some((c) => c.details === "Waiting for user review"));

        // Wait for idleTimer (50ms) armed after reaper recovery
        await new Promise((r) => setTimeout(r, 80));
        assert.equal(daemon.stateMachine.getCurrentStatus(), PresenceStatus.IDLE);
        assert.ok(setCalls.some((c) => c.details === "Idling in workspace"));
    } finally {
        await daemon.stop();
    }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/ipc.test.ts`
Expected: FAIL (`partyId` undefined in `setCalls[1]`, orphaned subagent not reaped in `RpcDaemon`).

- [ ] **Step 3: Update `src/daemon.ts` for `party` mapping, signature deduplication, and `subagentReaperTimer`**

Implementation details in `src/daemon.ts`:
- Import `loadSubagentTtlMsFromEnv` from `./types.js`.
- Add `subagentTtlMs?: number;` to `DaemonOptions` and pass `{ subagentTtlMs: options.subagentTtlMs }` to `new PresenceStateMachine(this.config, ...)`. In `isDirectRun`, pass `subagentTtlMs: loadSubagentTtlMsFromEnv()`.
- In `computeSignature(activity)`: include `party: activity.party` in the serialized JSON object.
- In `sendPresenceToDiscord(activity)`: when `activity.party` is defined, set:
  ```ts
  presencePayload.partyId = activity.party.id;
  presencePayload.partySize = activity.party.size[0];
  presencePayload.partyMax = activity.party.size[1];
  ```
- Add `private subagentReaperTimer: NodeJS.Timeout | null = null;`, `private clearSubagentReaperTimer(): void`, and `private resetSubagentReaperTimer(): void`:
  - `resetSubagentReaperTimer()` clears any existing timer, checks `this.stateMachine.getNextSubagentExpiryMs()`, and if non-null (and `!this.isStopping`), arms a `.unref()`ed `setTimeout` for that delay.
  - When the timer fires: call `const pruned = this.stateMachine.pruneStaleSubagents()`, if `pruned > 0` compute `const activity = this.stateMachine.getCurrentActivity()`, update `idleTimer` (`WAITING_REVIEW` -> `resetIdleTimer()`, `STOPPED` -> `clearIdleTimer()`), call `resetWatchdogTimer(currentStatus)`, and call `this.schedulePresenceUpdate(activity)`. Finally call `this.resetSubagentReaperTimer()` in case other newer subagents are still active.
  - Call `this.resetSubagentReaperTimer()` at the end of `applyHookToState()`, and call `this.clearSubagentReaperTimer()` inside `stop()`.

- [ ] **Step 4: Run full test suite and build standalone bundles**

Run: `npm run build && npm test`
Expected: Build generates `bin/daemon.js` and `bin/dispatch.js` cleanly; `npm test` exits 0 with all Stage 2 tests passing (and 0 failures).

- [ ] **Step 5: Commit**

```bash
git add src/daemon.ts tests/ipc.test.ts bin/daemon.js bin/dispatch.js
git commit -m "feat: forward Discord party metrics and add daemon subagent reaper timer"
```

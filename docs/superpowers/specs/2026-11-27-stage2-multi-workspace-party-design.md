# Design Document: Stage 2 — Multi-Workspace Isolation & Swarm "Party" Architecture (`v1.1.0`)

- **Date:** 2026-11-27
- **Branch:** `feat/stage2-multi-workspace-party` (from `development`)
- **Target Version:** `1.1.0`
- **Status:** Proposed (Ready for Plan Review)
- **Related Docs:**
  - [Edge Cases & Feature Options](../../2026-11-11-edge-cases-and-feature-options.md)
  - [Development Stages Roadmap](../../2026-11-11-development-stages.md)
  - [Original Design Spec](./2026-11-05-antigravity-discord-presence-design.md)
  - [Stage 1 Stabilization Spec](./2026-11-11-stabilization-patch-v1.0.1-design.md)

---

## 1. Intent & The Why

With `v1.0.1` stabilization complete, the core `PresenceStateMachine` (`src/state.ts`) still assumes a single global workspace and relies purely on explicit `Stop`/`SessionEnd` hooks to retire subagents:

1. **Multi-Workspace State Bleeding (Edge Case #8a):** `PresenceStateMachine` tracks sessions by `conversationId`, but stores `cwd`, `gitInfo`, and `startTimestamp` as single global fields. Opening two Antigravity windows on different repositories causes hooks from Workspace B to overwrite Workspace A's branch, repository name, button URL, and session timer. Cancelling a session in Workspace B also wipes Workspace A's sessions.
2. **Orphaned Subagent Leaks (Edge Case #10):** Subagent entries are only deleted on `Stop` or `SessionEnd`. If a subagent crashes or is terminated without emitting a closing hook, its session remains `THINKING` or `EXECUTING_TOOL` forever, locking Discord Rich Presence at `(N subagents active)` and preventing `WAITING_REVIEW` -> `IDLE` transitions.
3. **Native Swarm Party Visibility (Option 1):** Discord RPC supports native `party` metadata (`partyId`, `partySize`, `partyMax` in `@xhayper/discord-rpc`), allowing Antigravity's multi-agent/subagent collaboration to appear natively on Discord (e.g., `(2 of 3)` alongside the existing details text).

Stage 2 (`v1.1.0`) isolates workspace metadata, adds an automatic subagent TTL reaper, and surfaces native Discord `party` metrics without breaking `v1.0.1` config or test contracts.

---

## 2. Goals, Non-Goals, and Anti-Goals

### Goals
- **Workspace-Scoped Metadata:** Isolate `cwd`, `gitInfo` (5-second cache), `startTimestamp`, and active turn peak agent counts per workspace inside `PresenceStateMachine`.
- **Deterministic Workspace Arbitration:** Display the highest-priority workspace (`EXECUTING_TOOL > THINKING > WAITING_REVIEW > IDLE > STOPPED`), breaking ties by most recent hook activity (`updatedAt`).
- **Scoped Cancellation:** Ensure `Stop` (non-`NO_TOOL_CALL`) or `SessionEnd` on a workspace stops sessions in that workspace without terminating unrelated workspaces.
- **Orphaned Subagent TTL Reaper:** Automatically expire `isSubagent: true` sessions that receive no hook updates for `subagentTtlMs` (default `600_000` ms / 10 minutes, configurable via `AGY_DISCORD_SUBAGENT_TTL` in seconds), including timer-driven pruning in `RpcDaemon` when no new hooks arrive.
- **Discord RPC `party` Support:** Add `party?: { id: string; size: [number, number] }` to `PresenceActivity`, populate it during active multi-agent swarm turns, include it in `RpcDaemon` payload deduplication, and map it to `@xhayper/discord-rpc`'s `partyId`, `partySize`, and `partyMax`.

### Non-Goals
- 3-tier privacy presets (`stealth`/`balanced`/`showcase`) or persistent `config.json` files (deferred to Stage 3).
- Language/tech stack asset detection or dual interactive buttons (deferred to Stage 4).
- Long-running task Discord Webhooks (deferred to Stage 5).

### Anti-Goals
- Running a separate daemon process per workspace (the single local IPC daemon continues to arbitrate across workspaces).
- Breaking `DEFAULT_CONFIG` shape or existing `new RpcDaemon()` / `new PresenceStateMachine()` constructor compatibility.
- Introducing real multi-minute waits in unit tests (TTL and reaper behavior must be testable via injected clock/options in milliseconds).

---

## 3. Constraints & External Library Behavior

- **Runtime & Build:** Node.js 18+ ESM; TypeScript compiled to standalone `bin/daemon.js` and `bin/dispatch.js` via `npm run build` (`scripts/build.mjs`).
- **`@xhayper/discord-rpc` `SetActivity` Contract:** `ClientUser.setActivity()` reads `partyId`, `partySize`, and `partyMax` (not a nested `party` object) and serializes `formattedActivity.party = { id, size: [partySize, partyMax] }`.
- **Discord RPC Field Limits:** `party.id` must be 2–128 characters; `party.size` is `[currentSize, maxSize]` with `1 <= currentSize <= maxSize`.
- **Existing Test Contracts:** `tests/state.test.ts` accesses `(sm as any).sessions` directly and calls `handleHook()` without `cwd` on subagents; both must remain compatible.

---

## 4. Detailed Design

### 4.1 Types & Subagent TTL Environment Helper (`src/types.ts`)
- Extend `PresenceActivity` with:
  ```ts
  party?: { id: string; size: [number, number] };
  ```
- Export `DEFAULT_SUBAGENT_TTL_MS = 600_000` (10 minutes) and `loadSubagentTtlMsFromEnv(env: NodeJS.ProcessEnv = process.env): number` reading `AGY_DISCORD_SUBAGENT_TTL` (in seconds, positive finite integer, fallback `DEFAULT_SUBAGENT_TTL_MS`). Keep `DEFAULT_CONFIG` unchanged.

### 4.2 Workspace-Scoped Context & Arbitration (`src/state.ts`)
- Define `DEFAULT_WORKSPACE_KEY = "__default__"`.
- When `payload.cwd` is provided and non-empty, normalize it via `path.resolve(payload.cwd)` (and on Windows normalize case only for key comparison while keeping the resolved path as `cwd` for `getGitInfo()`).
- If `payload.cwd` is omitted:
  - For an existing session in `this.sessions`, retain `session.workspaceKey`.
  - For a new session, assign `DEFAULT_WORKSPACE_KEY`.
- Maintain `private readonly workspaces = new Map<string, WorkspaceContext>()` where each `WorkspaceContext` stores:
  - `key: string`
  - `cwd: string` (`path.resolve(payload.cwd)` or `process.cwd()` for `DEFAULT_WORKSPACE_KEY`)
  - `gitInfo?: GitInfo`
  - `lastGitFetchTime: number`
  - `startTimestamp?: number`
  - `peakActiveAgents: number`
  - `updatedAt: number`
- **Cancellation Scoping:** When a primary session receives `Stop` (without `NO_TOOL_CALL`) or `SessionEnd`, mark sessions sharing `session.workspaceKey` (plus `DEFAULT_WORKSPACE_KEY` only if the target session itself is in `DEFAULT_WORKSPACE_KEY`) as `STOPPED` instead of clearing other workspaces.
- **Arbitration (`getWinningWorkspace()`):**
  - Status precedence: `EXECUTING_TOOL (4) > THINKING (3) > WAITING_REVIEW (2) > IDLE (1) > STOPPED (0)`.
  - Compute each workspace's status from its sessions (treating `DEFAULT_WORKSPACE_KEY` subagents as eligible companions when counting subagents for a non-default active workspace, while keeping non-default workspaces strictly isolated from each other).
  - Select the non-`STOPPED` workspace with the highest status priority, breaking ties by highest `updatedAt`.

### 4.3 Orphaned Subagent TTL Reaper (`src/state.ts`, `src/daemon.ts`)
- Add `PresenceStateMachineOptions`:
  ```ts
  export interface PresenceStateMachineOptions {
      subagentTtlMs?: number;
      now?: () => number;
  }
  ```
  Construct `new PresenceStateMachine(config = DEFAULT_CONFIG, options: PresenceStateMachineOptions = {})`.
- Implement `pruneStaleSubagents(now = this.now()): number`:
  - Removes every `SessionState` with `isSubagent === true` where `now - session.updatedAt >= this.subagentTtlMs`.
  - Resets `startTimestamp` and `peakActiveAgents` on any workspace whose remaining sessions are all `STOPPED` (or empty).
- Implement `getNextSubagentExpiryMs(now = this.now()): number | null` returning milliseconds until the earliest active subagent expires (`Math.max(1, this.subagentTtlMs - (now - session.updatedAt))`), or `null` if no subagent sessions exist.
- Call `pruneStaleSubagents(now)` inside `handleHook()`, `handleIdleTimeout()`, `getCurrentStatus()`, `getActiveSubagentsCount()`, and `getCurrentActivity()`.
- In `RpcDaemon` (`src/daemon.ts`):
  - Accept `subagentTtlMs?: number` in `DaemonOptions` (passed to `PresenceStateMachine`; `isDirectRun` passes `loadSubagentTtlMsFromEnv()`).
  - Manage a `.unref()`ed `subagentReaperTimer` armed to `getNextSubagentExpiryMs()` whenever subagents exist. When it fires, prune stale subagents, re-evaluate status (`WAITING_REVIEW` -> arm `idleTimer`, `STOPPED` -> clear `idleTimer`), reset watchdog, and schedule a presence update if pruned count `> 0`. Clear it in `stop()`.

### 4.4 Discord RPC `party` Metrics (`src/state.ts`, `src/daemon.ts`)
- In `PresenceStateMachine`:
  - For the winning workspace, compute `activeSubagentsCount` (active subagents in winning workspace + unscoped `DEFAULT_WORKSPACE_KEY` subagents).
  - When `activeSubagentsCount > 0` and winning status is `THINKING` or `EXECUTING_TOOL`:
    - `activeAgents = (hasActivePrimaryInWinningWorkspace ? 1 : 0) + activeSubagentsCount` (minimum `1`).
    - Update `workspace.peakActiveAgents = Math.max(workspace.peakActiveAgents, activeAgents)`.
    - Build `partyId` from the active primary session's `conversationId` in that workspace (or winning workspace key / `"antigravity-swarm"`), truncated safely via `truncateRpcText(..., 128) || "antigravity-swarm"`.
    - Set `party: { id: partyId, size: [activeAgents, workspace.peakActiveAgents] }`.
  - Reset `workspace.peakActiveAgents = 0` when the workspace transitions to `WAITING_REVIEW`, `IDLE`, or `STOPPED`.
- In `RpcDaemon` (`src/daemon.ts`):
  - Include `party: activity.party` in `computeSignature()`.
  - In `sendPresenceToDiscord()`, when `activity.party` is present, attach:
    ```ts
    presencePayload.partyId = activity.party.id;
    presencePayload.partySize = activity.party.size[0];
    presencePayload.partyMax = activity.party.size[1];
    ```

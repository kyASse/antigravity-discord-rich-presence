# Stabilization Patch (`v1.0.1`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a reliable, Discord-RPC-compliant `v1.0.1` stabilization patch that fixes env config loading, cold-start event loss, payload truncation, Discord auto-reconnect + deduplication, inactivity watchdog exit, `hooks.json` duplicate execution, and test IPC isolation.

**Architecture:** Harden the existing two-process plugin architecture (`bin/dispatch.js` -> local IPC -> `bin/daemon.js`). Shared env/payload helpers live in `src/types.ts`, Discord text/URL/command guards in `src/sanitizer.ts` and `src/state.ts`, active-socket probing in `src/ipc.ts`, cold-start forwarding in `src/dispatch.ts`, and backoff reconnect, deduplication, and 2-tier inactivity watchdog in `src/daemon.ts`.

**Tech Stack:** Node.js (v18+/v24 ESM), TypeScript, `@xhayper/discord-rpc`, `node:test`, `node:assert/strict`, `tsx`, `esbuild`.

**Spec:** `docs/superpowers/specs/2026-11-11-stabilization-patch-v1.0.1-design.md`

## Global Constraints
- Runtime & Build: Node.js 18+ ESM; `npm run build` (`scripts/build.mjs`) bundles standalone `bin/daemon.js` and `bin/dispatch.js` via `esbuild`.
- Discord RPC Limits: `details`, `state`, `largeImageText`, `smallImageText` max **128** chars (min **2** chars when non-empty); `buttons[].label` max **32** chars; `buttons[].url` max **512** chars (`http://` or `https://` only); max **2** buttons.
- Dispatcher Budget: `dispatch.js` must execute non-blocking within `< 50ms` IPC timeout; never poll/wait synchronously for spawned daemon startup.
- Throttle & Compatibility: Keep default `throttleMs = 2000`; preserve `PluginConfig` shape and default `new RpcDaemon()` behavior for deterministic unit tests.
- Antigravity Hook Contract: `hooks.json` supports `SessionStart`, `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation`, `Stop` (`PreToolUse` returns `{"decision": "allow"}`, others return `{}`).

## Review Focus
1. **Emoji/UTF-16 Surrogate Truncation at 128 Chars:** Truncating strings containing multi-byte emojis at index `128` must slice by Unicode codepoints (`Array.from`) without leaving broken trailing surrogates. (Pinned in Task 3).
2. **Oversized (> 512 chars) or Non-HTTP Button URLs:** Git remotes exceeding 512 chars or non-`http:`/`https:` schemes must omit the button safely rather than causing Discord RPC rejection. (Pinned in Task 3).
3. **Malformed `AGY_INITIAL_PAYLOAD` on Daemon Boot:** Corrupted or non-JSON base64 in `AGY_INITIAL_PAYLOAD` must be safely ignored without crashing `RpcDaemon.start()`. (Pinned in Task 5).
4. **Watchdog Does Not Kill `WAITING_REVIEW` Prematurely:** When `watchdogMs` is shorter than `idleTimeoutSeconds`, staying in `WAITING_REVIEW` must wait for `handleIdleTimeout()` to transition to `IDLE` before starting the `idleShutdownMs` countdown. (Pinned in Task 6).
5. **Re-Sync After Discord Disconnect With Identical State:** Reconnecting to Discord while holding the same activity state must bypass the deduplication cache and immediately push the active presence. (Pinned in Task 6).

---

### Task 1: Isolate Test IPC Paths & Deduplicate `hooks.json`

**Files:**
- Modify: `hooks.json:1-98`
- Modify: `tests/ipc.test.ts:7-34`
- Modify: `tests/dispatch.test.ts:9-119`
- Modify: `tests/e2e.test.ts:21-27`

**Interfaces:**
- Consumes: `IpcServer(socketPath?: string)` (`src/ipc.ts`), `runDispatch(argv, env, stdinInput?)` (`src/dispatch.ts`)
- Produces: Isolated per-process test IPC sockets so `npm test` passes while production daemon holds `\\.\pipe\agy-discord-rpc`; single `"discord-presence"` group in `hooks.json`.

- [ ] **Step 1: Add duplicate-group guard in `tests/e2e.test.ts` and verify failure**

```typescript
// In tests/e2e.test.ts inside "validates plugin.json and hooks.json manifests"
const groupKeys = Object.keys(hooks);
assert.equal(groupKeys.length, 1, "hooks.json must not register duplicate hook groups");
assert.equal(groupKeys[0], "discord-presence");
```

Run: `npx tsx --test tests/e2e.test.ts`
Expected: FAIL (`AssertionError: Expected values to be strictly deep-equal: 2 !== 1`).

- [ ] **Step 2: Remove redundant `"antigravity-discord-presence"` block from `hooks.json`**

Keep only the `"discord-presence"` top-level object in `hooks.json` so each Antigravity lifecycle event fires `node bin/dispatch.js` once instead of twice.

- [ ] **Step 3: Isolate `Local IPC Channel` and `CLI Dispatcher` test suites from global default pipe**

In `tests/ipc.test.ts` (`Local IPC Channel`) and `tests/dispatch.test.ts` (`CLI Dispatcher`):
- Generate a unique per-process socket path in suite scope:
  `const testPipe = process.platform === "win32" ? \`\\\\.\\pipe\\agy-discord-rpc-test-${process.pid}-${Date.now()}\` : \`/tmp/agy-discord-rpc-test-${process.pid}-${Date.now()}.sock\`;`
- Construct `server = new IpcServer(testPipe)` in `before()`.
- Pass `testPipe` to `sendIpcMessage(testPayload, 1000, testPipe)` in `tests/ipc.test.ts:30`, and pass `{ ...process.env, AGY_IPC_PATH: testPipe }` as `env` to every `runDispatch(...)` call in `tests/dispatch.test.ts` (except the dedicated `offlineEnv` test).

- [ ] **Step 4: Run full test suite to verify isolation and `hooks.json` fix**

Run: `npm test`
Expected: PASS (all tests pass with 0 failures and 0 cancelled suites, even while Antigravity's live daemon is running on `\\.\pipe\agy-discord-rpc`).

- [ ] **Step 5: Commit**

```bash
git add hooks.json tests/ipc.test.ts tests/dispatch.test.ts tests/e2e.test.ts
git commit -m "fix: isolate test IPC pipes and remove duplicate hooks.json group"
```

---

### Task 2: Environment Configuration Loader & Initial Payload Helpers

**Files:**
- Modify: `src/types.ts:1-42`
- Modify: `src/daemon.ts:258-282`
- Test: `tests/types.test.ts:1-17`

**Interfaces:**
- Consumes: `PluginConfig`, `DEFAULT_CONFIG`, `HookPayload` (`src/types.ts`)
- Produces:
  - `loadConfigFromEnv(env?: NodeJS.ProcessEnv): PluginConfig` (`src/types.ts`)
  - `loadWatchdogTimeoutMsFromEnv(env?: NodeJS.ProcessEnv): number` (`src/types.ts`)
  - `encodeInitialPayload(payload: HookPayload): string` (`src/types.ts`)
  - `decodeInitialPayload(raw: string | undefined): HookPayload | null` (`src/types.ts`)

- [ ] **Step 1: Write failing tests in `tests/types.test.ts`**

```typescript
// Append to tests/types.test.ts
import {
    PresenceStatus,
    DEFAULT_CONFIG,
    loadConfigFromEnv,
    loadWatchdogTimeoutMsFromEnv,
    encodeInitialPayload,
    decodeInitialPayload
} from "../src/types";

it("loads PluginConfig and watchdog timeout from env vars with safe fallbacks", () => {
    assert.deepEqual(loadConfigFromEnv({}), DEFAULT_CONFIG);

    const custom = loadConfigFromEnv({
        AGY_DISCORD_CLIENT_ID: " 999888777 ",
        AGY_DISCORD_PRIVACY_MODE: "true",
        AGY_DISCORD_IDLE_TIMEOUT: "120",
        AGY_DISCORD_SHOW_REPO_BUTTON: "false"
    });
    assert.deepEqual(custom, {
        clientId: "999888777",
        privacyMode: true,
        idleTimeoutSeconds: 120,
        showRepoButton: false
    });

    const invalid = loadConfigFromEnv({
        AGY_DISCORD_CLIENT_ID: "   ",
        AGY_DISCORD_PRIVACY_MODE: "maybe",
        AGY_DISCORD_IDLE_TIMEOUT: "-5",
        AGY_DISCORD_SHOW_REPO_BUTTON: "0"
    });
    assert.equal(invalid.clientId, DEFAULT_CONFIG.clientId);
    assert.equal(invalid.privacyMode, false);
    assert.equal(invalid.idleTimeoutSeconds, 300);
    assert.equal(invalid.showRepoButton, false);

    assert.equal(loadWatchdogTimeoutMsFromEnv({}), 1_800_000);
    assert.equal(loadWatchdogTimeoutMsFromEnv({ AGY_DISCORD_WATCHDOG_TIMEOUT: "90" }), 90_000);
    assert.equal(loadWatchdogTimeoutMsFromEnv({ AGY_DISCORD_WATCHDOG_TIMEOUT: "abc" }), 1_800_000);
});

it("encodes and decodes AGY_INITIAL_PAYLOAD defensively", () => {
    const encoded = encodeInitialPayload({ event: "SessionStart", conversationId: "c-init" });
    assert.deepEqual(decodeInitialPayload(encoded), { event: "SessionStart", conversationId: "c-init" });
    assert.equal(decodeInitialPayload(undefined), null);
    assert.equal(decodeInitialPayload("not-valid-base64-json!!!"), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/types.test.ts`
Expected: FAIL with missing exports (`loadConfigFromEnv`, etc.).

- [ ] **Step 3: Implement helpers in `src/types.ts` and wire `loadConfigFromEnv` in `src/daemon.ts`**

- Implement `loadConfigFromEnv`, `loadWatchdogTimeoutMsFromEnv` (default `1_800_000` ms = 30m), `encodeInitialPayload` (`Buffer.from(JSON.stringify(payload), "utf-8").toString("base64")`), and `decodeInitialPayload` (validates parsed object has string `event` field; returns `null` on error) in `src/types.ts`.
- In `src/daemon.ts` (`isDirectRun`), replace `new RpcDaemon()` with `new RpcDaemon(loadConfigFromEnv(), { watchdogMs: loadWatchdogTimeoutMsFromEnv(), onWatchdogExit: () => process.exit(0) })` (once `DaemonOptions` adds those optional fields in Task 6; for now pass `new RpcDaemon(loadConfigFromEnv())`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/types.test.ts`
Expected: PASS (3/3 tests in `types.test.ts`).

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/daemon.ts tests/types.test.ts
git commit -m "feat: load AGY_DISCORD_* env config and initial payload helpers"
```

---

### Task 3: Discord RPC Truncation, Button URL Guard & `toolSummary` Sanitization

**Files:**
- Modify: `src/sanitizer.ts:116-196`
- Modify: `src/state.ts:262-372`
- Test: `tests/sanitizer.test.ts:54-75`
- Test: `tests/state.test.ts:122-160`

**Interfaces:**
- Consumes: `sanitizeCommand` (`src/sanitizer.ts`), `PresenceActivity`, `PresenceStatus` (`src/types.ts`)
- Produces:
  - `truncateRpcText(value: string | undefined, maxLength: number): string | undefined` (`src/sanitizer.ts`)
  - `validateRpcButtonUrl(rawUrl: string): string | undefined` (`src/sanitizer.ts`)
  - `PresenceStateMachine.getCurrentActivity(): PresenceActivity | null` (`src/state.ts`)

- [ ] **Step 1: Write failing tests in `tests/sanitizer.test.ts` and `tests/state.test.ts`**

```typescript
// In tests/sanitizer.test.ts
import { sanitizeGitUrl, sanitizeCommand, mapToolToAction, truncateRpcText, validateRpcButtonUrl } from "../src/sanitizer";

it("truncates RPC fields cleanly by Unicode codepoints and enforces >= 2 chars", () => {
    assert.equal(truncateRpcText("a", 128), undefined);
    assert.equal(truncateRpcText("  ", 128), undefined);
    assert.equal(truncateRpcText("ab", 128), "ab");
    const longEmoji = "🚀".repeat(70);
    const truncated = truncateRpcText(longEmoji, 128)!;
    assert.equal(Array.from(truncated).length, 128);
    assert.ok(truncated.endsWith("..."));
    assert.ok(!truncated.includes("\uFFFD"));
});

it("validates RPC button URL scheme and 512-char limit", () => {
    assert.equal(validateRpcButtonUrl("https://github.com/org/repo"), "https://github.com/org/repo");
    assert.equal(validateRpcButtonUrl("ftp://example.com/repo"), undefined);
    assert.equal(validateRpcButtonUrl("https://github.com/" + "a".repeat(500)), undefined);
});

it("sanitizes toolSummary secrets when privacyMode is false", () => {
    assert.equal(
        mapToolToAction("run_command", { toolSummary: "Deploy using TOKEN=ghp_1234567890abcdef" }, false),
        "Running: Deploy using TOKEN=***"
    );
});
```

```typescript
// In tests/state.test.ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test tests/sanitizer.test.ts tests/state.test.ts`
Expected: FAIL (missing `truncateRpcText`, `validateRpcButtonUrl`, `getCurrentActivity`, and unsanitized `toolSummary`).

- [ ] **Step 3: Implement guards in `src/sanitizer.ts` and `src/state.ts`**

- In `src/sanitizer.ts`:
  - Export `truncateRpcText(value: string | undefined, maxLength: number): string | undefined` using `Array.from(trimmed)` slicing to `maxLength - 3` + `"..."` when exceeding `maxLength`, and returning `undefined` if trimmed length `< 2`.
  - Export `validateRpcButtonUrl(rawUrl: string): string | undefined`: parses via `new URL(rawUrl)`, accepts only `http:` or `https:`, and returns `rawUrl` only if `rawUrl.length <= 512`.
  - In `mapToolToAction()`, sanitize `args.toolSummary` via `sanitizeCommand(args.toolSummary.trim(), false)` when `privacyMode` is `false`.
- In `src/state.ts`:
  - Export `getCurrentActivity(): PresenceActivity | null` returning `this.buildActivity(this.getCurrentStatus())`.
  - In `getButtons()`: validate `remoteUrl` with `validateRpcButtonUrl()`, truncate button `label` to `32` chars, cap button list to max `2`.
  - In `formatState()` & `buildActivity()`: cap `state`, `largeImageText`, `smallImageText` at `128`; in `EXECUTING_TOOL`, truncate `action` to `Math.max(2, 128 - subSuffix.length)` before concatenating `subSuffix`, then apply `truncateRpcText(..., 128)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test tests/sanitizer.test.ts tests/state.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sanitizer.ts src/state.ts tests/sanitizer.test.ts tests/state.test.ts
git commit -m "fix: enforce Discord RPC char/URL limits and sanitize toolSummary"
```

---

### Task 4: Safe Socket Probe Before Unix Unlink (`src/ipc.ts`)

**Files:**
- Modify: `src/ipc.ts:44-101`
- Test: `tests/ipc.test.ts:1-58`

**Interfaces:**
- Consumes: `net.createConnection`, `fs.unlinkSync` (`src/ipc.ts`)
- Produces: `probeSocketActive(socketPath: string, timeoutMs?: number): Promise<boolean>` (`src/ipc.ts`), used inside `IpcServer.start()` before unlinking existing non-Windows socket files.

- [ ] **Step 1: Write failing tests in `tests/ipc.test.ts`**

```typescript
// In tests/ipc.test.ts
import { IpcServer, sendIpcMessage, getIpcAddress, probeSocketActive } from "../src/ipc";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/ipc.test.ts`
Expected: FAIL (`probeSocketActive` not exported).

- [ ] **Step 3: Implement `probeSocketActive` and guard `IpcServer.start()` in `src/ipc.ts`**

- Export `probeSocketActive(socketPath: string, timeoutMs: number = 50): Promise<boolean>`: opens `net.createConnection(socketPath)` with `setTimeout(timeoutMs)`, resolves `true` on `"connect"`, `false` on `"error"` or `"timeout"`, destroying the probe socket cleanly.
- In `IpcServer.start()` on `process.platform !== "win32"`: when `fs.existsSync(this.path)` is true, await `probeSocketActive(this.path, 50)`. If `true`, reject with an Error (`code = "EADDRINUSE"`, `EADDRINUSE: address already in use ${this.path}`) instead of unlinking; only call `fs.unlinkSync(this.path)` if `false`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/ipc.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ipc.ts tests/ipc.test.ts
git commit -m "fix: probe existing IPC socket before unlinking stale Unix socket file"
```

---

### Task 5: Zero-Loss Cold Start (`AGY_INITIAL_PAYLOAD`)

**Files:**
- Modify: `src/dispatch.ts:153-170,219-258`
- Modify: `src/daemon.ts:104-113`
- Test: `tests/dispatch.test.ts:94-120`
- Test: `tests/ipc.test.ts:59-100`

**Interfaces:**
- Consumes: `encodeInitialPayload`, `decodeInitialPayload` (`src/types.ts`), `RpcDaemon.handlePayload()` (`src/daemon.ts`)
- Produces: `spawnDaemon(env?: NodeJS.ProcessEnv, initialPayload?: HookPayload): child_process.ChildProcess | null` (`src/dispatch.ts`), cold-start hydration inside `RpcDaemon.start()`.

- [ ] **Step 1: Write failing tests in `tests/dispatch.test.ts` and `tests/ipc.test.ts`**

```typescript
// In tests/dispatch.test.ts (test spawnDaemon env wiring via mock/wrapper or temp script)
it("passes AGY_INITIAL_PAYLOAD in spawned daemon env on cold start without mutating parent env", async () => {
    const tmpOut = path.join(os.tmpdir(), `agy-coldstart-${process.pid}-${Date.now()}.json`);
    const fakeDaemon = path.join(os.tmpdir(), `agy-fake-daemon-${process.pid}-${Date.now()}.mjs`);
    fs.writeFileSync(
        fakeDaemon,
        `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(tmpOut)}, process.env.AGY_INITIAL_PAYLOAD ?? "");`,
        "utf-8"
    );
    try {
        await runDispatch(
            ["--event", "SessionStart", "--conversationId", "cold-1"],
            {
                ...process.env,
                AGY_IPC_PATH: process.platform === "win32"
                    ? `\\\\.\\pipe\\agy-coldstart-missing-${process.pid}`
                    : `/tmp/agy-coldstart-missing-${process.pid}.sock`,
                AGY_DAEMON_PATH: fakeDaemon,
                AGY_AUTO_SPAWN: "true"
            }
        );
        // Wait briefly for child process to write file
        await new Promise((r) => setTimeout(r, 250));
        const written = fs.readFileSync(tmpOut, "utf-8");
        assert.equal(decodeInitialPayload(written)?.conversationId, "cold-1");
        assert.equal(process.env.AGY_INITIAL_PAYLOAD, undefined);
    } finally {
        fs.rmSync(tmpOut, { force: true });
        fs.rmSync(fakeDaemon, { force: true });
    }
});
```

```typescript
// In tests/ipc.test.ts inside "RPC Daemon Core"
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test tests/dispatch.test.ts tests/ipc.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `AGY_INITIAL_PAYLOAD` forwarding and hydration**

- In `src/dispatch.ts`: update `spawnDaemon(env = process.env, initialPayload?: HookPayload)` to merge `AGY_INITIAL_PAYLOAD: encodeInitialPayload(initialPayload)` into the spawned child's `env` when `initialPayload` is provided; update `runDispatch()` to call `spawnDaemon(env, payload)` when `!delivered`.
- In `src/daemon.ts`: inside `start()`, after `await this.ipcServer.start()`, read and immediately `delete process.env.AGY_INITIAL_PAYLOAD`; decode via `decodeInitialPayload()`, and if valid, call `await this.handlePayload(initialPayload)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test tests/dispatch.test.ts tests/ipc.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dispatch.ts src/daemon.ts tests/dispatch.test.ts tests/ipc.test.ts
git commit -m "feat: forward initial hook payload across cold-start daemon spawn"
```

---

### Task 6: Exponential Backoff Reconnect, Re-Sync, Deduplication & 2-Tier Watchdog

**Files:**
- Modify: `src/daemon.ts:12-265`
- Test: `tests/ipc.test.ts:101-223`

**Interfaces:**
- Consumes: `PresenceStateMachine.getCurrentActivity()` (`src/state.ts`), `loadWatchdogTimeoutMsFromEnv()` (`src/types.ts`)
- Produces:
  - Extended `DaemonOptions`: `{ ipcPath?, throttleMs?, rpcClient?, clientFactory?, reconnectBaseMs?, reconnectMaxMs?, watchdogMs?, activeWatchdogMs?, onWatchdogExit? }` (`src/daemon.ts`)
  - Background reconnect loop with exponential backoff (`2000ms` base -> `30000ms` cap) and automatic presence re-sync on connect.
  - Normalized activity deduplication inside `sendPresenceToDiscord()` (reset on disconnect).
  - 2-tier inactivity watchdog (`watchdogMs` on `IDLE`/`STOPPED`; `activeWatchdogMs` = `14_400_000ms` on active/`WAITING_REVIEW`).

- [ ] **Step 1: Update throttle test fixture & write failing tests in `tests/ipc.test.ts`**

Update `tests/ipc.test.ts:128-138` 3rd event from `{ event: "PostToolUse", conversationId: "c1" }` to `{ event: "Stop", conversationId: "c1", terminationReason: "NO_TOOL_CALL" }`, then add:

```typescript
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
```

- [ ] **Step 2: Run test to verify new tests fail**

Run: `npx tsx --test tests/ipc.test.ts`
Expected: FAIL on deduplication, reconnect, and watchdog tests.

- [ ] **Step 3: Implement reconnect, deduplication, and 2-tier watchdog in `src/daemon.ts`**

- Add `reconnectBaseMs` (default `2000`), `reconnectMaxMs` (default `30_000`), `watchdogMs` (default `1_800_000`), `activeWatchdogMs` (default `14_400_000`), `onWatchdogExit`, and `clientFactory` to `DaemonOptions`.
- On connect failure or `"disconnected"` / `"error"` / `"close"` while `!this.isStopping`: reset `lastSentSignature = undefined`, set `_isConnected = false`, and schedule exponential backoff `scheduleReconnect()`. When creating a real client (no `options.rpcClient`), re-instantiate via `clientFactory` / `new Client({ clientId })` if needed and re-attach listeners. On successful login/ready, reset `reconnectAttempt = 0` and immediately push `this.stateMachine.getCurrentActivity()` if `getCurrentStatus() !== STOPPED`.
- In `sendPresenceToDiscord()`: compute normalized signature (`"CLEARED"` for `null`, or JSON of `{ details, state, largeImageKey, largeImageText, smallImageKey, smallImageText, buttons }`); return early if `_isConnected && signature === this.lastSentSignature`, otherwise send and store `this.lastSentSignature = signature`.
- Implement `resetWatchdogTimer(status: PresenceStatus)`: uses `this.watchdogMs` when `status === IDLE || status === STOPPED`, and `this.activeWatchdogMs` otherwise; `.unref()` timer; when fired, calls `await this.stop()` then `this.onWatchdogExit?.()`. Call `resetWatchdogTimer()` on every `handlePayload()`, on `idleTimer` transition to `IDLE`, and on `start()`. Clear `reconnectTimer` and `watchdogTimer` inside `stop()`.
- In `isDirectRun` (`src/daemon.ts`), pass `loadWatchdogTimeoutMsFromEnv()` and `onWatchdogExit: () => process.exit(0)`.

- [ ] **Step 4: Run tests to verify all pass**

Run: `npx tsx --test tests/ipc.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/daemon.ts tests/ipc.test.ts
git commit -m "feat: add Discord reconnect backoff, payload deduplication, and 2-tier watchdog"
```

---

### Task 7: Documentation Cleanup, Bundle Rebuild & End-to-End Verification

**Files:**
- Modify: `README.md:85-135`
- Modify: `package.json:3` (bump version to `1.0.1` — check `plugin.json:4` as well)
- Modify: `plugin.json:4`
- Rebuild: `bin/daemon.js`, `bin/dispatch.js`

**Interfaces:**
- Consumes: `npm run build`, `npm test`
- Produces: Synchronized `bin/daemon.js` & `bin/dispatch.js`, clean `README.md` configuration & FAQ, `v1.0.1` metadata.

- [ ] **Step 1: Clean up `README.md` and bump version to `1.0.1`**

- In `README.md`:
  - Merge `AGY_DISCORD_WATCHDOG_TIMEOUT` (default `1800`s / 30m), `AGY_AUTO_SPAWN`, and `AGY_IPC_PATH` cleanly into the main `## Configuration` table and remove the stray duplicate table rows at lines 109–112.
  - Add a short FAQ note under `## Configuration` explaining that Discord Desktop intentionally disables clicking Rich Presence action buttons on your own profile preview (other users can click them normally).
- Update `"version": "1.0.1"` in `package.json` and `plugin.json` (only if `tests/e2e.test.ts` or manifests expect it—verified `e2e.test.ts` checks `plugin.name`, not version).

- [ ] **Step 2: Rebuild production bundles**

Run: `npm run build`
Expected: `Successfully built bin/daemon.js and bin/dispatch.js`.

- [ ] **Step 3: Run full test suite & CLI smoke check**

Run: `npm test`
Expected: All tests across all suites PASS with `0` failures and `0` cancelled tests.

Run: `node bin/dispatch.js --event PreToolUse` (with `AGY_AUTO_SPAWN=false`)
Expected: Outputs `{"decision":"allow"}` cleanly in `< 100ms`.

- [ ] **Step 4: Commit**

```bash
git add README.md package.json plugin.json bin/daemon.js bin/dispatch.js
git commit -m "chore: update docs, rebuild v1.0.1 bundles, and bump version"
```

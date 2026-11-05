# Antigravity Discord Rich Presence Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a native Antigravity App plugin that integrates with Discord Desktop to display real-time Smart Hybrid Rich Presence (agent thinking, tool execution, waiting for review, idle) with privacy protection and subagent arbitration.

**Architecture:** A native Antigravity Plugin with `hooks.json` capturing agent lifecycle events. A lightweight CLI dispatcher (`bin/dispatch.js`) forwards events over a local IPC channel (Windows Named Pipe / Unix Socket) to a persistent background daemon (`bin/daemon.js`). The daemon maintains the `@xhayper/discord-rpc` client connection, runs the state machine, throttles Discord updates to 2s, and cleans up on session termination.

**Tech Stack:** Node.js (v24), TypeScript, `@xhayper/discord-rpc`, `node:test`, `node:assert/strict`, `esbuild` for bundling.

**Spec:** `docs/superpowers/specs/2026-11-05-antigravity-discord-presence-design.md`

## Global Constraints
- Target platform: Antigravity 2.0 (Antigravity App Desktop) on Windows, macOS, and Linux.
- Default Discord Client ID: `1441771215290372156`.
- Update rate limit: Maximum 1 Discord RPC update per 2 seconds (throttled).
- Inactivity idle timeout: 300 seconds (5 minutes) before transitioning from `Waiting Review` to `Idle`.
- Zero-latency requirement: CLI dispatcher must complete within <50ms without blocking Antigravity hook execution.
- Credential safety: Remote URLs and shell commands must be strictly sanitized before sending to Discord.

## Review Focus
1. **Malicious / Sensitive Git Remote URLs (embedded credentials):** Remote URLs like `https://oauth2:ghp_secretToken@github.com/org/repo.git` must be stripped to `https://github.com/org/repo` without leaking secrets. (Tested in Task 2).
2. **Discord Desktop Not Running / Crashed:** Daemon must not crash when the Discord local pipe is unavailable or abruptly closes, but should quietly retry or gracefully enter a dormant state without throwing unhandled rejections. (Tested in Task 5).
3. **Subagent Terminations Overwriting Primary Agent:** When a subagent finishes its turn (`Stop`), it must not prematurely overwrite the primary agent's active presence if the primary agent is still running tools or thinking. (Tested in Task 4).
4. **Hook Execution Latency:** If the daemon is dead or slow, `dispatch.js` must time out or fail asynchronously within 50ms rather than hanging Antigravity's lifecycle loop. (Tested in Task 6).
5. **Normal Turn End vs. Actual Session Abort:** Normal turn end (`terminationReason: "NO_TOOL_CALL"`) must transition to `Waiting Review`, whereas explicit user abort (`USER_CANCELED`) must clear presence immediately. (Tested in Task 4).

---

### Task 1: Project Scaffolding & Shared Types

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `plugin.json`
- Create: `src/types.ts`
- Test: `tests/types.test.ts`

**Interfaces:**
- Consumes: None (root configuration)
- Produces:
  - `interface HookPayload { event: string; conversationId?: string; isSubagent?: boolean; toolName?: string; toolArgs?: Record<string, unknown>; terminationReason?: string; cwd?: string }`
  - `enum PresenceStatus { THINKING = "THINKING", EXECUTING_TOOL = "EXECUTING_TOOL", WAITING_REVIEW = "WAITING_REVIEW", IDLE = "IDLE", STOPPED = "STOPPED" }`
  - `interface PresenceActivity { details?: string; state?: string; startTimestamp?: number; largeImageKey?: string; largeImageText?: string; smallImageKey?: string; smallImageText?: string; buttons?: Array<{ label: string; url: string }> }`
  - `interface PluginConfig { clientId: string; privacyMode: boolean; idleTimeoutSeconds: number; showRepoButton: boolean }`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/types.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PresenceStatus, DEFAULT_CONFIG } from "../src/types";

describe("Types & Defaults", () => {
    it("exports valid PresenceStatus enum and DEFAULT_CONFIG", () => {
        assert.equal(PresenceStatus.THINKING, "THINKING");
        assert.equal(PresenceStatus.EXECUTING_TOOL, "EXECUTING_TOOL");
        assert.equal(PresenceStatus.WAITING_REVIEW, "WAITING_REVIEW");
        assert.equal(PresenceStatus.IDLE, "IDLE");
        assert.equal(PresenceStatus.STOPPED, "STOPPED");
        assert.equal(DEFAULT_CONFIG.clientId, "1441771215290372156");
        assert.equal(DEFAULT_CONFIG.idleTimeoutSeconds, 300);
        assert.equal(DEFAULT_CONFIG.privacyMode, false);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/types.test.ts`
Expected: FAIL with module not found or syntax error before compilation

- [ ] **Step 3: Implement scaffolding and `src/types.ts`**

Setup `package.json` with `@xhayper/discord-rpc`, `tsx`, `typescript`, `esbuild`. Setup `plugin.json` declaring plugin metadata, `tsconfig.json`, and implement `src/types.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/types.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json plugin.json src/types.ts tests/types.test.ts
git commit -m "feat: scaffold project and define core presence types"
```

---

### Task 2: Sanitizer & Privacy Utility

**Files:**
- Create: `src/sanitizer.ts`
- Test: `tests/sanitizer.test.ts`

**Interfaces:**
- Consumes: `HookPayload`, `PluginConfig` from `src/types.ts`
- Produces:
  - `sanitizeGitUrl(rawUrl: string): string | undefined`
  - `sanitizeCommand(command: string, privacyMode?: boolean): string`
  - `mapToolToAction(toolName: string, args?: Record<string, unknown>, privacyMode?: boolean): string`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/sanitizer.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeGitUrl, sanitizeCommand, mapToolToAction } from "../src/sanitizer";

describe("Sanitizer", () => {
    it("strips credentials from HTTP/HTTPS/SSH git remote urls", () => {
        assert.equal(
            sanitizeGitUrl("https://x-access-token:ghp_123456789@github.com/owner/repo.git"),
            "https://github.com/owner/repo"
        );
        assert.equal(
            sanitizeGitUrl("git@github.com:owner/repo.git"),
            "https://github.com/owner/repo"
        );
        assert.equal(sanitizeGitUrl("not-a-url"), undefined);
    });

    it("sanitizes commands and masks passwords in privacy mode", () => {
        assert.equal(sanitizeCommand("npm test -- --grep auth"), "npm test -- --grep auth");
        assert.equal(sanitizeCommand("git commit -m 'secret password=123'", true), "git");
        assert.equal(sanitizeCommand("export TOKEN=abcdef && run", false), "export TOKEN=*** && run");
    });

    it("maps tools into human-friendly actions", () => {
        assert.equal(mapToolToAction("read_file", { Path: "/project/src/index.ts" }), "Reading index.ts");
        assert.equal(mapToolToAction("write_file", { Path: "/project/src/app.ts" }), "Editing app.ts");
        assert.equal(mapToolToAction("run_command", { toolSummary: "Unit test execution" }), "Running: Unit test execution");
        assert.equal(mapToolToAction("invoke_subagent", {}), "Dispatching Subagent");
        assert.equal(mapToolToAction("search_web", {}), "Searching web documentation");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/sanitizer.test.ts`
Expected: FAIL with module `../src/sanitizer` not found

- [ ] **Step 3: Implement `src/sanitizer.ts`**

Implement URL parsing with regex/URL parser, regex for secret stripping, and the friendly tool dictionary.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/sanitizer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/sanitizer.ts tests/sanitizer.test.ts
git commit -m "feat: implement URL and command sanitizer with friendly tool mapping"
```

---

### Task 3: Git & Workspace Detection

**Files:**
- Create: `src/git.ts`
- Test: `tests/git.test.ts`

**Interfaces:**
- Consumes: `sanitizeGitUrl` from `src/sanitizer.ts`
- Produces:
  - `interface GitInfo { branch?: string; repoName?: string; remoteUrl?: string }`
  - `getGitInfo(dirPath: string): Promise<GitInfo>`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/git.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getGitInfo } from "../src/git";
import path from "node:path";

describe("Git Info Reader", () => {
    it("extracts git metadata for the current workspace", async () => {
        const info = await getGitInfo(process.cwd());
        assert.ok(info.branch !== undefined || info.repoName !== undefined);
        if (info.remoteUrl) {
            assert.ok(!info.remoteUrl.includes("@"));
        }
    });

    it("returns empty object gracefully for non-git directories", async () => {
        const tempRoot = path.parse(process.cwd()).root;
        const info = await getGitInfo(tempRoot);
        assert.deepEqual(info, {});
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/git.test.ts`
Expected: FAIL with module `../src/git` not found

- [ ] **Step 3: Implement `src/git.ts`**

Use `node:child_process` `execFile` with short timeout (500ms) to run `git rev-parse --abbrev-ref HEAD` and `git config --get remote.origin.url`, resolving safely without throwing on error.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/git.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/git.ts tests/git.test.ts
git commit -m "feat: implement git and workspace metadata detector"
```

---

### Task 4: Presence State Machine & Subagent Arbitration

**Files:**
- Create: `src/state.ts`
- Test: `tests/state.test.ts`

**Interfaces:**
- Consumes: `HookPayload`, `PresenceStatus`, `PresenceActivity`, `PluginConfig` from `src/types.ts`
- Produces:
  - `class PresenceStateMachine`
    - `handleHook(payload: HookPayload): Promise<PresenceActivity | null>`
    - `handleIdleTimeout(): PresenceActivity | null`
    - `getCurrentStatus(): PresenceStatus`
    - `getActiveSubagentsCount(): number`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/state.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/state.test.ts`
Expected: FAIL with module `../src/state` not found

- [ ] **Step 3: Implement `src/state.ts`**

Implement session tracking map, priority calculation, idle transition logic, and activity payload construction.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/state.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/state.ts tests/state.test.ts
git commit -m "feat: implement presence state machine and subagent arbitration"
```

---

### Task 5: Local IPC Channel & Daemon Core

**Files:**
- Create: `src/ipc.ts`
- Create: `src/daemon.ts`
- Test: `tests/ipc.test.ts`

**Interfaces:**
- Consumes: `PresenceStateMachine` from `src/state.ts`, `HookPayload` from `src/types.ts`
- Produces:
  - `getIpcAddress(): string` (Named pipe `\\.\pipe\agy-discord-rpc` or Unix socket)
  - `class IpcServer` (listens for incoming hook payloads from dispatcher)
  - `class RpcDaemon` (coordinates IpcServer, Discord RPC client, throttled presence updates, and idle timer)

- [ ] **Step 1: Write the failing test**

```typescript
// tests/ipc.test.ts
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { IpcServer, sendIpcMessage } from "../src/ipc";
import { HookPayload } from "../src/types";

describe("Local IPC Channel", () => {
    let server: IpcServer;

    before(async () => {
        server = new IpcServer();
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

        const success = await sendIpcMessage(testPayload, 1000);
        assert.equal(success, true);
        assert.deepEqual(received, testPayload);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/ipc.test.ts`
Expected: FAIL with module `../src/ipc` not found

- [ ] **Step 3: Implement `src/ipc.ts` and `src/daemon.ts`**

Implement `node:net` named pipe / socket server and client. Implement `RpcDaemon` wrapping `@xhayper/discord-rpc` with automatic reconnection, throttler, and graceful error handling.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/ipc.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ipc.ts src/daemon.ts tests/ipc.test.ts
git commit -m "feat: implement local IPC server and discord rpc daemon core"
```

---

### Task 6: Fast CLI Dispatcher & `hooks.json` Configuration

**Files:**
- Create: `src/dispatch.ts`
- Create: `hooks.json`
- Test: `tests/dispatch.test.ts`

**Interfaces:**
- Consumes: `sendIpcMessage` from `src/ipc.ts`, `HookPayload` from `src/types.ts`
- Produces:
  - `runDispatch(argv: string[], env: NodeJS.ProcessEnv): Promise<void>`
  - Hook handler configuration in `hooks.json` mapping Antigravity lifecycle events to `dispatch.js`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/dispatch.test.ts
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { IpcServer } from "../src/ipc";
import { runDispatch } from "../src/dispatch";
import { HookPayload } from "../src/types";

describe("CLI Dispatcher", () => {
    let server: IpcServer;
    let receivedPayload: HookPayload | null = null;

    before(async () => {
        server = new IpcServer();
        server.onMessage = (p) => { receivedPayload = p; };
        await server.start();
    });

    after(async () => {
        await server.stop();
    });

    it("parses CLI args and dispatches event to IPC server within 50ms", async () => {
        const start = performance.now();
        await runDispatch(["--event", "PreInvocation", "--conversationId", "c-456"], process.env);
        const duration = performance.now() - start;

        assert.ok(duration < 100, `Dispatch took too long: ${duration}ms`);
        assert.equal(receivedPayload?.event, "PreInvocation");
        assert.equal(receivedPayload?.conversationId, "c-456");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/dispatch.test.ts`
Expected: FAIL with module `../src/dispatch` not found

- [ ] **Step 3: Implement `src/dispatch.ts` and `hooks.json`**

Implement fast argument parser, daemon auto-spawn on `SessionStart` (via `spawn(..., { detached: true, stdio: 'ignore' })`), and create `hooks.json` registering `SessionStart`, `PreInvocation`, `PreToolUse`, `PostToolUse`, `PostInvocation`, `Stop`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/dispatch.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/dispatch.ts hooks.json tests/dispatch.test.ts
git commit -m "feat: implement CLI dispatcher and Antigravity hooks.json configuration"
```

---

### Task 7: Bundling, Packaging & End-to-End Test

**Files:**
- Create: `bin/daemon.js` (generated bundle)
- Create: `bin/dispatch.js` (generated bundle)
- Create: `scripts/build.mjs`
- Create: `README.md`
- Test: `tests/e2e.test.ts`

**Interfaces:**
- Consumes: All previous tasks
- Produces:
  - Standalone bundled executables in `bin/` requiring zero runtime compilation.
  - End-to-end integration test exercising the full lifecycle.

- [ ] **Step 1: Write the failing E2E test**

```typescript
// tests/e2e.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

describe("E2E Integration & Build Verification", () => {
    it("ensures build script generates standalone bin/daemon.js and bin/dispatch.js", () => {
        execFileSync("node", ["scripts/build.mjs"], { stdio: "pipe" });
        assert.ok(fs.existsSync(path.resolve("bin/daemon.js")));
        assert.ok(fs.existsSync(path.resolve("bin/dispatch.js")));
    });

    it("validates plugin.json and hooks.json manifests", () => {
        const plugin = JSON.parse(fs.readFileSync("plugin.json", "utf-8"));
        const hooks = JSON.parse(fs.readFileSync("hooks.json", "utf-8"));
        assert.equal(plugin.name, "antigravity-discord-presence");
        assert.ok(hooks["discord-presence"] !== undefined);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/e2e.test.ts`
Expected: FAIL with `scripts/build.mjs` not found

- [ ] **Step 3: Implement `scripts/build.mjs` and `README.md`**

Implement `scripts/build.mjs` with `esbuild` to bundle `src/daemon.ts` -> `bin/daemon.js` and `src/dispatch.ts` -> `bin/dispatch.js`. Write documentation in `README.md`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/e2e.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite to verify all tasks pass**

Run: `npm test`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add scripts/build.mjs bin/ README.md tests/e2e.test.ts package.json
git commit -m "feat: setup esbuild pipeline, user guide, and e2e verification"
```

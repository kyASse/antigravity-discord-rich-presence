# Design Document: Stabilization Patch (`v1.0.1` / Stage 1)

- **Date:** 2026-11-11
- **Branch:** `feat/discord-rpc-enhancements`
- **Target Version:** `1.0.1`
- **Status:** Proposed (Builder-Checked; Ready for User Approval)
- **Related Docs:**
  - [Edge Cases & Feature Options](../../2026-11-11-edge-cases-and-feature-options.md)
  - [Development Stages Roadmap](../../2026-11-11-development-stages.md)
  - [Original Design Spec](./2026-11-05-antigravity-discord-presence-design.md)

---

## 1. Intent & The Why

Before expanding **Antigravity Discord Rich Presence** with multi-workspace tracking, dynamic tech stack icons, or webhook notifications, audit of the `development` branch revealed concrete reliability, specification-compliance, and developer-experience gaps:

1. **Undelivered Configuration Promise:** `README.md` documents 4 environment variables (`AGY_DISCORD_CLIENT_ID`, `AGY_DISCORD_PRIVACY_MODE`, `AGY_DISCORD_IDLE_TIMEOUT`, `AGY_DISCORD_SHOW_REPO_BUTTON`), yet `src/daemon.ts` instantiates `new RpcDaemon()` with hardcoded `DEFAULT_CONFIG` and never reads them.
2. **Cold-Start Event Loss:** When `bin/dispatch.js` triggers `spawnDaemon()` because the daemon is offline (`!delivered`), the triggering hook payload (typically `SessionStart` or first `PreInvocation`) is discarded rather than forwarded to the newly spawned daemon.
3. **Discord RPC Payload & Connection Fragility:** Long repo/branch names or command summaries are not truncated to Discord's strict `128`/`32`/`512` character limits; `toolSummary` bypasses `sanitizeCommand()`; and if Discord Desktop starts after Antigravity or disconnects during OS sleep, the daemon lacks a background exponential-backoff reconnect loop and activity re-sync.
4. **Hook Duplication & Orphan Daemons:** `hooks.json` defines two identical root hook groups (`"discord-presence"` and `"antigravity-discord-presence"`), causing Antigravity to execute `node bin/dispatch.js` twice per lifecycle event. Additionally, Antigravity's official `hooks.json` contract does not emit a `SessionEnd` hook, meaning an abandoned or abruptly closed IDE session can leave the detached daemon running indefinitely without an inactivity watchdog.
5. **Broken Local Test Execution Under Live Plugin Usage:** `tests/ipc.test.ts` (`Local IPC Channel`) and `tests/dispatch.test.ts` (`CLI Dispatcher`) bind directly to the global default pipe (`\\.\pipe\agy-discord-rpc`), failing with `EADDRINUSE` whenever the plugin is actively running on the developer's machine.

This stabilization patch (`v1.0.1`) resolves these foundational defects without changing the core presence UX or introducing breaking config formats.

---

## 2. Goals, Non-Goals, and Anti-Goals

### Goals
- **Config Parity:** Ensure all documented `AGY_DISCORD_*` environment variables work reliably in standalone daemon runs.
- **Zero-Loss Cold Start:** Preserve and process the initial lifecycle hook payload that triggers daemon auto-spawn, keeping `dispatch.js` execution latency under 50ms.
- **Discord RPC Spec Compliance:** Enforce strict field length truncation (`128` / `32` / `512` chars), URL scheme validation, duplicate-activity suppression, and automatic reconnection with exponential backoff.
- **Process & Socket Hygiene:** Eliminate double hook execution in `hooks.json`, prevent stale Unix socket hijacking, and auto-terminate idle/orphaned daemon processes via a watchdog.
- **Deterministic Test Suite:** Isolate IPC socket paths in tests so `npm test` passes consistently even when a production daemon is active.

### Non-Goals
- Multi-workspace `cwd`/`gitInfo` isolation or Discord `party` payloads (deferred to Stage 2).
- Granular privacy tiers (`stealth`/`balanced`/`showcase`) or persistent `config.json` files (deferred to Stage 3).
- Dynamic language/tech stack icons or dual interactive buttons (deferred to Stage 4).
- Long-running task Discord Webhooks (deferred to Stage 5).

### Anti-Goals
- Blocking `dispatch.js` by waiting/polling for daemon startup synchronously (must stay fire-and-forget within the 50ms IPC budget).
- Spamming Discord RPC with identical payloads or tight reconnect loops (100ms polling) when Discord Desktop is closed.
- Breaking backward compatibility for existing `PluginConfig`, `DaemonOptions`, or `hooks.json` test contracts.

---

## 3. Constraints

- **Node.js 18+ Native/ESM Runtime:** Code compiles via `esbuild` (`scripts/build.mjs`) into standalone `bin/daemon.js` and `bin/dispatch.js` without requiring end users to run `npm install`.
- **Discord Developer RPC Limits:**
  - `details`, `state`, `largeImageText`, `smallImageText`: max **128** chars (min 2 chars when non-empty).
  - `buttons[].label`: max **32** chars; `buttons[].url`: max **512** chars, `http://` or `https://` only; max **2** buttons.
- **Antigravity Plugin Hook Contract:** Supports `SessionStart`, `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation`, and `Stop` (`hooks.json` top-level keys are merged and executed sequentially by Antigravity). `PreToolUse` must output `{"decision": "allow"}`; other hooks output `{}`.

---

## 4. Approaches Considered

| Approach | Scope | Trade-offs | Decision |
| :--- | :--- | :--- | :--- |
| **A. Engineering-First Full Roadmap** | Sequential execution of Stages 1 → 5 before release. | Zero rework, but delays fixing live bugs in `v1.0.0` until all new features complete. | Rejected |
| **B. Hardening + Visual Fast-Track** | Mix Stage 1 critical fixes with Stage 4 (Tech Stack + Dual Buttons). | Fast visual update, but mixes stability fixes with new asset/state dependencies before Stage 2 workspace isolation. | Rejected |
| **C. Stabilization Patch Only (`v1.0.1`)** | Focused Stage 1 scope: fix all existing reliability, spec compliance, config, and test isolation gaps first. | Delivers immediate stability and clean test baseline with minimal risk; defers new user-facing features to `v1.1.0+`. | **CHOSEN** |

---

## 5. Detailed Design (The "How")

### 5.1 Environment Configuration Loader (`src/types.ts`, `src/daemon.ts`)
- Add `loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PluginConfig`:
  - `AGY_DISCORD_CLIENT_ID`: non-empty trimmed string, fallback to `DEFAULT_CONFIG.clientId`.
  - `AGY_DISCORD_PRIVACY_MODE`: `"true"` or `"1"` (case-insensitive) → `true`, `"false"` or `"0"` → `false`, fallback `DEFAULT_CONFIG.privacyMode`.
  - `AGY_DISCORD_IDLE_TIMEOUT`: parsed finite number `> 0`, fallback `DEFAULT_CONFIG.idleTimeoutSeconds` (`300`).
  - `AGY_DISCORD_SHOW_REPO_BUTTON`: `"false"` or `"0"` → `false`, `"true"` or `"1"` → `true`, fallback `DEFAULT_CONFIG.showRepoButton`.
- Update `isDirectRun` in `src/daemon.ts` to initialize `new RpcDaemon(loadConfigFromEnv())`.
- Note: Keep `new RpcDaemon(config = DEFAULT_CONFIG, options = {})` signature untouched so unit tests constructing `new RpcDaemon()` stay deterministic and independent of host env vars unless explicitly called.

### 5.2 Zero-Loss Cold Start (`src/dispatch.ts`, `src/daemon.ts`)
- **Problem:** `runDispatch()` spawns `daemon.js` asynchronously when `!delivered` and exits immediately, losing the triggering `HookPayload`.
- **Design:**
  - In `spawnDaemon(env, initialPayload?)` inside `src/dispatch.ts`, when `initialPayload` is provided, serialize it as base64-encoded JSON into the child process environment as `AGY_INITIAL_PAYLOAD` (only in the spawned child's `env`, never mutating the parent process env).
  - In `RpcDaemon.start()` (`src/daemon.ts`), after `await this.ipcServer.start()` succeeds, check `process.env.AGY_INITIAL_PAYLOAD`. If present and non-empty:
    - Decode base64 → `JSON.parse` inside a `try/catch` (ignore malformed data defensively).
    - Clear `delete process.env.AGY_INITIAL_PAYLOAD` immediately so it is never re-processed.
    - Process it via `await this.handlePayload(initialPayload)` before or alongside initial Discord connection.
  - Why `AGY_INITIAL_PAYLOAD` env var instead of CLI arg or retrying IPC in `dispatch.ts`? Zero extra latency in `dispatch.ts` (stays `< 50ms`), avoids Windows shell/CLI escaping issues with nested JSON quotes in `toolArgs`, and guarantees the daemon processes the first event as soon as its IPC server is ready. *(Decision: our call; builder can unit test both encode/decode paths cleanly.)*

### 5.3 Discord RPC Payload Compliance & Sanitization (`src/sanitizer.ts`, `src/state.ts`)
- Add `truncateRpcText(value: string | undefined, maxLength: number): string | undefined` in `src/sanitizer.ts`:
  - *(Our Call)* Trims input and returns `undefined` if the trimmed length is `< 2` characters (Discord RPC requires at least 2 characters whenever a text field is present, so omitting single-character anomalies prevents RPC rejection; formatted strings like `"Project: a"` are already >= 10 characters).
  - If the Unicode codepoint length (`Array.from(trimmed).length`) exceeds `maxLength`, slice to `maxLength - 3` codepoints and append `"..."` (using `Array.from` prevents splitting UTF-16 surrogate pairs/emojis).
- Apply truncation in `PresenceStateMachine.buildActivity()` and `formatState()` (`src/state.ts`):
  - In `EXECUTING_TOOL`: when appending `subSuffix`, compute `maxActionLen = 128 - subSuffix.length` and truncate `action` first so the subagent count suffix is preserved, then guard total `details` <= 128 chars.
  - `state`: cap at 128 chars (`formatState()`).
  - `largeImageText`, `smallImageText`: cap at 128 chars.
  - `getButtons()`: enforce max 2 buttons, `label` <= 32 chars, `url` validated as `http:`/`https:` via `URL` constructor and length <= 512 chars (omit button if URL > 512 chars or invalid).
- In `mapToolToAction()` (`src/sanitizer.ts`): pass `args.toolSummary` through `sanitizeCommand(args.toolSummary, false)` so tokens/secrets accidentally placed in a tool summary are masked when `privacyMode = false`.
- Update `README.md` FAQ/Configuration section with a brief note explaining Discord Desktop's intentional restriction that prevents clicking Rich Presence buttons on your own profile preview.

### 5.4 Discord Auto-Reconnect, Rate-Limit Stability & Re-Sync (`src/daemon.ts`)
- **Background Exponential Backoff Reconnect:**
  - Introduce reconnect scheduling (`scheduleReconnect()`) triggered when initial `connectDiscord()` fails or when Discord client/transport emits `"disconnected"`, `"error"`, or `"close"` (only if `!this.isStopping`).
  - Backoff progression: `2_000ms` → `4_000ms` → `8_000ms` → `16_000ms` → capped at `30_000ms`. Reset backoff attempt counter to `0` once `"ready"` / `"connected"` or `login()` succeeds.
  - **Re-instantiation safety:** Preserve `options.rpcClient` injection for unit test mocks. When running with the real `@xhayper/discord-rpc` client (no `options.rpcClient` supplied), safely re-instantiate `Client` on reconnect if the previous transport was destroyed.
  - **Presence Re-Sync on Reconnect:** Compute or fetch the current active `PresenceActivity` from `this.stateMachine` so when Discord reconnects successfully while status is not `STOPPED`, the daemon immediately pushes the current presence state to Discord.
- **Duplicate Activity Suppression & Throttle Optimization:**
  - *(Our Call)* Keep default `throttleMs = 2000` (consistent with `README.md`) and perform payload deduplication directly inside `sendPresenceToDiscord()`. Compare a normalized key of `(details, state, smallImageKey, smallImageText, largeImageKey, largeImageText, buttons)` (or `"CLEARED"` when `activity === null`) against the last successfully sent payload while connected, skipping redundant `setActivity()`/`clearActivity()` calls if identical.
  - Reset the last-sent payload cache to `undefined` whenever Discord disconnects (`_isConnected` becomes `false`), guaranteeing re-sync always emits upon reconnect.
  - **Test Alignment (`tests/ipc.test.ts`):** Because the existing throttle test (`tests/ipc.test.ts:128-138`) previously burst `PreInvocation` → `PreToolUse` → `PostToolUse` (returning to the identical `"Agent is thinking..."` payload as event 1), update its 3rd event to end on a distinct state (e.g. `PreToolUse` with `edit_file` or `Stop` with `NO_TOOL_CALL`) so throttle flushing remains verified independently, and add an explicit deduplication unit test.

### 5.5 Daemon Inactivity Watchdog & Unix Socket Safety (`src/daemon.ts`, `src/ipc.ts`)
- **Inactivity Auto-Shutdown Watchdog (`src/daemon.ts`):**
  - Antigravity `hooks.json` has no `SessionEnd` event. If the user closes Antigravity IDE abruptly, the detached daemon stays alive.
  - Add a watchdog timer (`watchdogTimer`) managed by `RpcDaemon`:
    - *(Our Call)* **Tier 1 (`IDLE` or `STOPPED`):** Starts `idleShutdownMs` countdown (default **30 minutes** = `1_800_000ms`, configurable via `AGY_DISCORD_WATCHDOG_TIMEOUT` in seconds or `DaemonOptions.watchdogMs`) **upon transitioning into `IDLE` (inside `handleIdleTimeout()`) or `STOPPED` (inside `handlePayload()`)**. `WAITING_REVIEW` is governed by `idleTimer` (`AGY_DISCORD_IDLE_TIMEOUT`), ensuring custom idle timeouts (even >= 30m) are never killed prematurely while waiting for review.
    - *(Our Call)* **Tier 2 (`THINKING`, `EXECUTING_TOOL`, `WAITING_REVIEW`):** Resets to a **4-hour** (`14_400_000ms`) safety ceiling on every `handlePayload()` so truly crashed/abandoned active turns are still reaped without interrupting long builds or long review waits.
  - When the watchdog fires, invoke `await this.stop()`, and when running standalone (`isDirectRun`), call `onWatchdogExit` to exit cleanly (`process.exit(0)`).
  - Ensure `watchdogTimer` is `.unref()`ed and cleared in `stop()` so tests and event loops never hang waiting on timers.
- **Safe Unix Socket Unlink (`src/ipc.ts`):**
  - On non-Windows platforms, before calling `fs.unlinkSync(this.path)` in `IpcServer.start()`, probe the existing socket via a short `net.connect(this.path)` (e.g. 50ms timeout).
  - Only unlink if connection fails with `ECONNREFUSED` or `ENOENT` (truly stale socket). If connection succeeds, an active daemon already owns the socket—reject with an `EADDRINUSE`-style error rather than deleting a live daemon's socket file.

### 5.6 `hooks.json` Deduplication & Lifecycle Alignment (`hooks.json`)
- **Problem:** `hooks.json` currently declares two top-level keys (`"discord-presence"` and `"antigravity-discord-presence"`) with identical handlers, causing Antigravity to spawn `node bin/dispatch.js` twice for every event.
- **Design:**
  - Remove the redundant `"antigravity-discord-presence"` block and retain `"discord-presence"` (which matches the assertion in `tests/e2e.test.ts` line 25: `hooks["discord-presence"] !== undefined`).
  - Keep defensive `"SessionEnd"` handling inside `PresenceStateMachine.handleHook()` (`src/state.ts`) for manual/test usage, without adding an unsupported `"SessionEnd"` key to `hooks.json`.

### 5.7 Test Suite IPC Isolation (`tests/ipc.test.ts`, `tests/dispatch.test.ts`)
- Update `Local IPC Channel` (`tests/ipc.test.ts`) and `CLI Dispatcher` (`tests/dispatch.test.ts`) to bind to unique per-process test pipe/socket paths (e.g., `\\.\pipe\agy-discord-rpc-test-${process.pid}-${Date.now()}` on Windows or `/tmp/agy-discord-rpc-test-${process.pid}-${Date.now()}.sock` on Unix) via `new IpcServer(testPipe)` and passing `AGY_IPC_PATH: testPipe` in the `env` argument of `runDispatch()`.
- Ensure `getIpcAddress()` default-path test remains intact without actually listening on the default pipe.
- Rebuild `bin/daemon.js` and `bin/dispatch.js` (`npm run build`) after TypeScript edits so production bundles stay synchronized.

---

## 6. What Is Left to the Builder

- Exact helper function names/signatures for truncation and config parsing, and whether to expose `getCurrentActivity()` publicly on `PresenceStateMachine`.
- Structuring unit tests for reconnect backoff (using fake timers or short `reconnectBaseMs` option on `DaemonOptions`), watchdog shutdown (using short `watchdogMs` option), cold-start `AGY_INITIAL_PAYLOAD`, env config loading, and `128`/`32`/`512`-char truncation edge cases.
- Ensuring `DaemonOptions` cleanly exposes optional test hooks (like `watchdogMs`, `reconnectBaseMs`, `onWatchdogExit`) with sensible production defaults so tests run in milliseconds without real waits.

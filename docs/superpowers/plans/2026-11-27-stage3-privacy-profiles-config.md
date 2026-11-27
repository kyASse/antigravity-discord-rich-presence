# Stage 3: Granular Privacy Profiles & Persistent Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement 3-tier privacy profiles (`stealth`, `balanced`, `showcase`), sensitive filename redaction, persistent global and per-workspace JSON configuration (`Env Vars > Workspace Config > Global Config > DEFAULT_CONFIG`), and updated `README.md` documentation for `v1.2.0`.

**Architecture:** `src/types.ts` defines `PrivacyProfile`, extends `PluginConfig`/`DEFAULT_CONFIG`, and maps `AGY_DISCORD_PRIVACY_PROFILE` alongside legacy `AGY_DISCORD_PRIVACY_MODE`. `src/sanitizer.ts` adds `isSensitiveFilename()` and profile-aware `mapToolToAction()`. `src/config.ts` loads and validates optional JSON config files (`~/.gemini/antigravity-discord-rpc.json` and `<cwd>/.agents/discord-rpc.json`) with per-layer privacy normalization and explicit env overrides. `PresenceStateMachine` (`src/state.ts`) caches per-workspace overrides with a 5-second TTL and enforces `stealth` redaction (omitting `state`, `smallImage*`, `buttons`, and `party`), while `RpcDaemon` (`src/daemon.ts`) initializes from `loadDaemonConfig()` and honors winning workspace `idleTimeoutSeconds`.

**Tech Stack:** Node.js 20+ ESM, TypeScript, `node:test`, `node:assert/strict`, `tsx`, `esbuild`.

**Spec:** `docs/superpowers/specs/2026-11-27-stage3-privacy-profiles-config-design.md`

## Global Constraints
- Runtime & Build: Node.js 20+ ESM (`"type": "module"`); `npm run build` (`scripts/build.mjs`) bundles standalone `bin/daemon.js` and `bin/dispatch.js`.
- Discord RPC Limits: `details`, `state`, `largeImageText`, `smallImageText`, and `party.id` bounded to 2–128 chars via `truncateRpcText()`; `buttons` max 2 items, label <= 32 chars, valid `http:`/`https:` URL <= 512 chars.
- Config Precedence: `Env Vars > Workspace Config (.agents/discord-rpc.json) > Global Config (~/.gemini/antigravity-discord-rpc.json) > DEFAULT_CONFIG`.
- Zero-Crash Defensive I/O: Missing, unreadable, non-object, or malformed JSON config files must return `{}` without throwing.
- Backward Compatibility & Test Isolation: Preserve `new PresenceStateMachine()`, `new RpcDaemon()`, `loadConfigFromEnv()`, `sanitizeCommand(cmd, boolean)`, and `mapToolToAction(name, args, boolean)` callers; unit tests must never implicitly read the host user's real `~/.gemini/antigravity-discord-rpc.json` or ambient shell `AGY_DISCORD_*` env vars.

## Review Focus
1. **Unset or invalid env vars must not clobber JSON config:** Unset or invalid `AGY_DISCORD_PRIVACY_PROFILE` / `AGY_DISCORD_IDLE_TIMEOUT` must leave workspace/global JSON values intact. (Pinned in Task 3).
2. **Cross-layer `privacyMode` vs `privacyProfile` precedence:** Global `{ privacyMode: true }` overridden by workspace `{ privacyProfile: "showcase" }`, and workspace `{ privacyProfile: "showcase" }` overridden by env `AGY_DISCORD_PRIVACY_MODE=true`, must both resolve deterministically. (Pinned in Task 3 and Task 4).
3. **Malformed, non-object, or partially invalid JSON config files:** Invalid JSON syntax, arrays/`null`, or one bad property alongside valid properties must never throw and must preserve valid sibling fields. (Pinned in Task 3).
4. **Sensitive filename patterns vs normal source files:** `.env*`, `*.pem`, `*.key`, `id_rsa`, `*secret*`, `*credential*`, `.npmrc` must be redacted while `tokenizer.ts`, `auth.ts`, `config.ts`, `id_rsa.pub` remain visible in `balanced`/`showcase`. (Pinned in Task 2).
5. **Multi-workspace config isolation & `stealth` suppression:** Workspace A (`stealth` with active subagents) must omit `state`, `smallImage*`, `buttons`, and `party` while Workspace B (`showcase`) in the same `PresenceStateMachine` emits full details and `party` when active. (Pinned in Task 4).

---

### Task 1: Add `PrivacyProfile` Type, `DEFAULT_CONFIG` Default, and Env Mapping (`src/types.ts`)

**Files:**
- Modify: `src/types.ts:31-86`
- Modify: `tests/types.test.ts:1-67`
- Modify: `tests/ipc.test.ts:256-263`

**Interfaces:**
- Consumes: `PluginConfig`, `DEFAULT_CONFIG`, `loadConfigFromEnv` (`src/types.ts`)
- Produces:
  - `export type PrivacyProfile = "stealth" | "balanced" | "showcase"`
  - `PluginConfig.privacyProfile: PrivacyProfile` (required, default `"balanced"`)
  - `export function parsePrivacyProfile(raw: string | undefined): PrivacyProfile | undefined`
  - `export function resolveEffectivePrivacyProfile(config: Pick<PluginConfig, "privacyMode" | "privacyProfile">): PrivacyProfile`

- [ ] **Step 1: Write failing tests in `tests/types.test.ts` and update inline `PluginConfig` literal in `tests/ipc.test.ts`**

Update `tests/types.test.ts` imports and `describe("Types & Defaults")` assertions:
```typescript
import {
    PresenceStatus,
    DEFAULT_CONFIG,
    DEFAULT_SUBAGENT_TTL_MS,
    loadConfigFromEnv,
    loadWatchdogTimeoutMsFromEnv,
    loadSubagentTtlMsFromEnv,
    parsePrivacyProfile,
    resolveEffectivePrivacyProfile,
    encodeInitialPayload,
    decodeInitialPayload,
    type PresenceActivity
} from "../src/types";

// In "exports valid PresenceStatus enum and DEFAULT_CONFIG":
assert.equal(DEFAULT_CONFIG.privacyProfile, "balanced");

// In "loads PluginConfig and watchdog timeout from env vars with safe fallbacks":
assert.deepEqual(custom, {
    clientId: "999888777",
    privacyMode: true,
    privacyProfile: "stealth",
    idleTimeoutSeconds: 120,
    showRepoButton: false
});

// Add new test:
it("parses privacyProfile, resolves legacy privacyMode=true to stealth, and prioritizes AGY_DISCORD_PRIVACY_PROFILE", () => {
    assert.equal(parsePrivacyProfile(" STEALTH "), "stealth");
    assert.equal(parsePrivacyProfile("Balanced"), "balanced");
    assert.equal(parsePrivacyProfile("showcase"), "showcase");
    assert.equal(parsePrivacyProfile("unknown"), undefined);
    assert.equal(parsePrivacyProfile(undefined), undefined);

    assert.equal(resolveEffectivePrivacyProfile({ privacyMode: true, privacyProfile: "balanced" }), "stealth");
    assert.equal(resolveEffectivePrivacyProfile({ privacyMode: false, privacyProfile: "showcase" }), "showcase");

    const fromProfile = loadConfigFromEnv({ AGY_DISCORD_PRIVACY_PROFILE: "showcase" });
    assert.equal(fromProfile.privacyProfile, "showcase");
    assert.equal(fromProfile.privacyMode, false);

    const profileOverridesLegacy = loadConfigFromEnv({
        AGY_DISCORD_PRIVACY_PROFILE: "showcase",
        AGY_DISCORD_PRIVACY_MODE: "true"
    });
    assert.equal(profileOverridesLegacy.privacyProfile, "showcase");
    assert.equal(profileOverridesLegacy.privacyMode, false);

    const stealthFromProfile = loadConfigFromEnv({ AGY_DISCORD_PRIVACY_PROFILE: "stealth" });
    assert.equal(stealthFromProfile.privacyProfile, "stealth");
    assert.equal(stealthFromProfile.privacyMode, true);

    const invalidProfileFallsBack = loadConfigFromEnv({
        AGY_DISCORD_PRIVACY_PROFILE: "invalid",
        AGY_DISCORD_PRIVACY_MODE: "true"
    });
    assert.equal(invalidProfileFallsBack.privacyProfile, "stealth");
    assert.equal(invalidProfileFallsBack.privacyMode, true);
});
```
Also update `tests/ipc.test.ts:257-262` to include `privacyProfile: "balanced"` on the inline `PluginConfig` literal.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/types.test.ts`
Expected: FAIL (`parsePrivacyProfile` / `resolveEffectivePrivacyProfile` not exported and `DEFAULT_CONFIG.privacyProfile` undefined).

- [ ] **Step 3: Implement `PrivacyProfile`, `parsePrivacyProfile()`, `resolveEffectivePrivacyProfile()`, and update `loadConfigFromEnv()` in `src/types.ts`**

- Add `export type PrivacyProfile = "stealth" | "balanced" | "showcase";`.
- Add `privacyProfile: "balanced"` to `PluginConfig` and `DEFAULT_CONFIG`.
- Implement `parsePrivacyProfile(raw)` (trimmed, lowercased match against `"stealth" | "balanced" | "showcase"`).
- Implement `resolveEffectivePrivacyProfile(config)`: returns `"stealth"` if `config.privacyMode === true`, else `config.privacyProfile` if valid, else `"balanced"`.
- In `loadConfigFromEnv(env)`: if `parsePrivacyProfile(env.AGY_DISCORD_PRIVACY_PROFILE)` returns a valid profile, use it and set `privacyMode = profile === "stealth"`; otherwise parse `AGY_DISCORD_PRIVACY_MODE` and map `privacyMode: true` -> `"stealth"`, `false` -> `DEFAULT_CONFIG.privacyProfile` (`"balanced"`).

- [ ] **Step 4: Run tests to verify pass**

Run: `npx tsx --test tests/types.test.ts && npx tsc --noEmit`
Expected: PASS on `tests/types.test.ts` and clean TypeScript compilation (`tsc --noEmit` exits 0).

- [ ] **Step 5: Commit**

```bash
git add src/types.ts tests/types.test.ts tests/ipc.test.ts
git commit -m "feat: add PrivacyProfile types and env mapping"
```

---

### Task 2: Sensitive Filename Detection & Profile-Aware Tool Mapping (`src/sanitizer.ts`)

**Files:**
- Modify: `src/sanitizer.ts:1-198`
- Modify: `tests/sanitizer.test.ts:1-117`

**Interfaces:**
- Consumes: `PrivacyProfile` (`src/types.ts`)
- Produces:
  - `export function isSensitiveFilename(filePath: string): boolean`
  - `export function mapToolToAction(toolName: string, args?: Record<string, unknown>, privacy?: boolean | PrivacyProfile): string`

- [ ] **Step 1: Write failing tests in `tests/sanitizer.test.ts`**

```typescript
// Import isSensitiveFilename from "../src/sanitizer"
it("detects sensitive filenames while allowing normal source files", () => {
    const sensitive = [
        ".env",
        ".env.local",
        "/app/.env.production",
        "C:\\keys\\server.pem",
        "private.key",
        "cert.p12",
        "bundle.pfx",
        "keystore.jks",
        "app.keystore",
        "putty.ppk",
        "/home/user/.ssh/id_rsa",
        "id_ed25519",
        "id_ecdsa",
        "id_dsa",
        ".npmrc",
        ".pypirc",
        ".netrc",
        ".htpasswd",
        ".pgpass",
        "secrets.json",
        "client_secret.yaml",
        "credentials.json",
        "aws-credentials.toml",
        "service-account-prod.json"
    ];
    for (const file of sensitive) {
        assert.equal(isSensitiveFilename(file), true, `Expected sensitive: ${file}`);
    }

    const safe = [
        "src/index.ts",
        "src/config.ts",
        "src/tokenizer.ts",
        "src/auth.ts",
        "/home/user/.ssh/id_rsa.pub",
        ""
    ];
    for (const file of safe) {
        assert.equal(isSensitiveFilename(file), false, `Expected non-sensitive: ${file}`);
    }
});

it("applies balanced vs showcase vs stealth rules in mapToolToAction", () => {
    // Balanced masks sensitive files and reduces run_command to base command
    assert.equal(mapToolToAction("read_file", { Path: "/app/.env.production" }, "balanced"), "Reading sensitive file");
    assert.equal(mapToolToAction("edit_file", { Path: "C:\\repo\\secrets.json" }, "balanced"), "Editing sensitive file");
    assert.equal(mapToolToAction("read_file", { Path: "src/index.ts" }, "balanced"), "Reading index.ts");
    assert.equal(
        mapToolToAction("run_command", { toolSummary: "Deploy app", CommandLine: "npm run deploy --token=abc" }, "balanced"),
        "Running: npm"
    );
    assert.equal(mapToolToAction("run_command", { toolSummary: "Deploy app" }, "balanced"), "Running command");

    // Showcase still masks sensitive files, but shows sanitized run_command details
    assert.equal(mapToolToAction("read_file", { Path: "/app/.env" }, "showcase"), "Reading sensitive file");
    assert.equal(mapToolToAction("write_file", { Path: "/app/id_rsa" }, "showcase"), "Editing sensitive file");
    assert.equal(
        mapToolToAction("run_command", { toolSummary: "Deploy using TOKEN=ghp_123456" }, "showcase"),
        "Running: Deploy using TOKEN=***"
    );
    assert.equal(
        mapToolToAction("run_command", { CommandLine: "npm test -- --grep auth" }, "showcase"),
        "Running: npm test -- --grep auth"
    );

    // Stealth matches privacyMode=true at sanitizer level
    assert.equal(
        mapToolToAction("run_command", { toolSummary: "Secret", CommandLine: "git status" }, "stealth"),
        "Running: git"
    );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/sanitizer.test.ts`
Expected: FAIL (`isSensitiveFilename` not exported).

- [ ] **Step 3: Implement `isSensitiveFilename()` and update `mapToolToAction()` in `src/sanitizer.ts`**

- Import `type PrivacyProfile` from `./types.js`.
- Implement `isSensitiveFilename(filePath: string): boolean`:
  - Return `false` if `!filePath || typeof filePath !== "string" || !filePath.trim()`.
  - Compute `basename = path.basename(filePath.trim().replace(/\\/g, "/")).toLowerCase()`.
  - Match:
    - `/^\.env(\.|$)/i`
    - `/\.(pem|key|p12|pfx|jks|keystore|ppk)$/i`
    - `/^id_(rsa|ed25519|ecdsa|dsa)(?:\.(?!pub$).*)?$/i`
    - Exact dotfiles: `.npmrc`, `.pypirc`, `.netrc`, `.htpasswd`, `.pgpass`
    - `/secret/i`, `/credential/i`, `/^service[-_]?account.*\.json$/i`
- Update `mapToolToAction(toolName, args, privacy: boolean | PrivacyProfile = false)`:
  - Resolve `mode`: `privacy === true ? "stealth" : privacy === false ? "showcase" : privacy`.
  - In `read_file` / `write_file` / `edit_file`: check `isSensitiveFilename(rawPath)` when `rawPath` exists; return `"Reading sensitive file"` / `"Editing sensitive file"` when true.
  - In `run_command`: if `mode === "stealth" || mode === "balanced"`, ignore `toolSummary` and call `sanitizeCommand(CommandLine, true)`; if `mode === "showcase"`, preserve sanitized `toolSummary` / sanitized `CommandLine` (`sanitizeCommand(..., false)`).

- [ ] **Step 4: Run tests to verify pass**

Run: `npx tsx --test tests/sanitizer.test.ts`
Expected: PASS (all existing and new sanitizer assertions pass).

- [ ] **Step 5: Commit**

```bash
git add src/sanitizer.ts tests/sanitizer.test.ts
git commit -m "feat: add sensitive filename redaction and profile-aware tool mapping"
```

---

### Task 3: Persistent JSON Configuration Loader (`src/config.ts`)

**Files:**
- Create: `src/config.ts`
- Create: `tests/config.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_CONFIG`, `DEFAULT_SUBAGENT_TTL_MS`, `parsePrivacyProfile`, `type PluginConfig`, `type PrivacyProfile` (`src/types.ts`)
- Produces:
  - `export interface ConfigOverrides extends Partial<PluginConfig> { watchdogTimeoutSeconds?: number; subagentTtlSeconds?: number }`
  - `export interface LoadedDaemonConfig { config: PluginConfig; globalConfig: Partial<PluginConfig>; envOverrides: Partial<PluginConfig>; watchdogMs: number; subagentTtlMs: number }`
  - `export function getGlobalConfigPath(homedir?: string): string`
  - `export function getWorkspaceConfigPath(cwd: string): string`
  - `export function loadConfigFile(filePath: string): ConfigOverrides`
  - `export function parseConfigOverridesFromEnv(env?: NodeJS.ProcessEnv): ConfigOverrides`
  - `export function toWorkspaceOverrides(overrides: ConfigOverrides): Partial<PluginConfig>`
  - `export function loadDaemonConfig(options?: { env?: NodeJS.ProcessEnv; globalConfigPath?: string }): LoadedDaemonConfig`
  - `export function resolveWorkspaceConfig(params: { baseConfig: PluginConfig; cwd?: string; envOverrides?: Partial<PluginConfig>; enableWorkspaceConfig?: boolean }): PluginConfig`

- [ ] **Step 1: Write failing tests in `tests/config.test.ts`**

Cover all priority rules, Review Focus #1/#2/#3, and error resilience using `fs.mkdtempSync`:
- `getGlobalConfigPath("/home/alice")` ends with `.gemini/antigravity-discord-rpc.json`; `getWorkspaceConfigPath("/repo")` ends with `.agents/discord-rpc.json`.
- Missing file, directory path, malformed JSON (`"{bad json"`), JSON array (`"[1,2]"`), or `null` returns `{}` without throwing.
- Partial field validation: `{ privacyProfile: "invalid", showRepoButton: false, idleTimeoutSeconds: -10 }` keeps `{ showRepoButton: false }` and drops invalid fields.
- Precedence `Env > Workspace > Global > DEFAULT_CONFIG`:
  - Global sets `{ privacyProfile: "stealth", showRepoButton: false, clientId: "111", watchdogTimeoutSeconds: 900, subagentTtlSeconds: 120 }`.
  - Workspace `.agents/discord-rpc.json` sets `{ privacyProfile: "showcase", clientId: "999-ignored", watchdogTimeoutSeconds: 5, idleTimeoutSeconds: 45 }` -> workspace overrides `privacyProfile` to `"showcase"` and `idleTimeoutSeconds` to `45`, keeps `showRepoButton: false` from global, and ignores daemon-only `clientId` / `watchdogTimeoutSeconds` / `subagentTtlSeconds`.
  - Unset or invalid env (`{ AGY_DISCORD_PRIVACY_PROFILE: "bogus", AGY_DISCORD_IDLE_TIMEOUT: "abc" }`) does NOT clobber JSON values.
  - Explicit env `AGY_DISCORD_PRIVACY_MODE: "true"` overrides workspace `{ privacyProfile: "showcase" }` to `"stealth"`.
  - Explicit env `AGY_DISCORD_PRIVACY_PROFILE: "showcase"` overrides global `{ privacyMode: true }` and workspace `{ privacyProfile: "stealth" }` to `"showcase"` (`privacyMode: false`).
  - Workspace `{ privacyMode: false }` (without `privacyProfile`) overrides global `{ privacyProfile: "stealth" }` to `"balanced"`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/config.test.ts`
Expected: FAIL (`Cannot find module '../src/config'`).

- [ ] **Step 3: Implement `src/config.ts`**

- Implement `getGlobalConfigPath`, `getWorkspaceConfigPath`, `loadConfigFile`, `parseConfigOverridesFromEnv`, `toWorkspaceOverrides`, `loadDaemonConfig`, `resolveWorkspaceConfig`.
- Ensure per-layer privacy normalization:
  - When a layer explicitly provides valid `privacyProfile`, set `{ privacyProfile, privacyMode: privacyProfile === "stealth" }`.
  - Else if it provides boolean `privacyMode`, set `privacyMode: true -> { privacyMode: true, privacyProfile: "stealth" }` or `privacyMode: false -> { privacyMode: false, privacyProfile: "balanced" }`.
  - Else omit both `privacyMode` and `privacyProfile` from that layer's partial object.
- `toWorkspaceOverrides` strips daemon-only keys (`clientId`, `watchdogTimeoutSeconds`, `subagentTtlSeconds`) and keeps only `privacyProfile`, `privacyMode`, `showRepoButton`, `idleTimeoutSeconds`.
- `loadDaemonConfig` defaults `watchdogMs` to `1_800_000` and `subagentTtlMs` to `DEFAULT_SUBAGENT_TTL_MS` (`600_000`), overridden by global config then env overrides (`* 1000`).

- [ ] **Step 4: Run tests to verify pass**

Run: `npx tsx --test tests/config.test.ts`
Expected: PASS (all config precedence and malformed JSON tests pass).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: add layered persistent JSON config loader"
```

---

### Task 4: State Machine 3-Tier Privacy & Per-Workspace Config Caching (`src/state.ts`)

**Files:**
- Modify: `src/state.ts:1-669`
- Modify: `tests/state.test.ts:105-470`

**Interfaces:**
- Consumes: `resolveEffectivePrivacyProfile` (`src/types.ts`), `loadConfigFile`, `getWorkspaceConfigPath`, `parseConfigOverridesFromEnv`, `toWorkspaceOverrides` (`src/config.ts`), `mapToolToAction` (`src/sanitizer.ts`)
- Produces:
  - Extended `PresenceStateMachineOptions` (`env?`, `globalConfig?`, `enableWorkspaceConfig?`, `configCacheTtlMs?`)
  - `PresenceStateMachine.getActiveIdleTimeoutSeconds(): number`
  - `stealth` redaction & 5-second per-workspace config caching inside `PresenceStateMachine`

- [ ] **Step 1: Write failing tests in `tests/state.test.ts`**

- Update existing `privacyMode` test (`tests/state.test.ts:109-120`) to verify `privacyMode: true` maps to `stealth` (`details === "Working in Antigravity"`, `state === undefined`, `buttons === undefined`, `smallImageKey === undefined`, `party === undefined`).
- Add new tests:
  - `stealth` hides repo, branch, tool, subagent count, `party`, `smallImage*`, and `buttons` across `THINKING`, `EXECUTING_TOOL`, `WAITING_REVIEW`, and `IDLE`, retaining only `"Working in Antigravity"`, `startTimestamp`, and `largeImageKey`/`largeImageText`.
  - `balanced` (default) displays repo/branch/buttons/party and non-sensitive filenames (`Reading index.ts`), redacts `.env.production` to `"Reading sensitive file"`, and summarizes `run_command` to base command (`"Running: npm"`).
  - `showcase` displays full sanitized `run_command` (`toolSummary` / sanitized `CommandLine`) while still redacting `.env` to `"Reading sensitive file"`.
  - Multi-workspace `.agents/discord-rpc.json` overrides: Workspace A has `.agents/discord-rpc.json` with `{ "privacyProfile": "stealth", "idleTimeoutSeconds": 90 }` (with active subagents -> no `party`, `"Working in Antigravity"`), Workspace B has `{ "privacyProfile": "showcase", "showRepoButton": false }` -> Workspace B shows sanitized command & `party` without repo button when winning, and `getActiveIdleTimeoutSeconds()` reflects the winning workspace's `idleTimeoutSeconds`.
  - `options.env` (`AGY_DISCORD_PRIVACY_PROFILE: "stealth"`) overrides workspace `.agents/discord-rpc.json` (`"showcase"`), and 5-second config cache refreshes via injected `now` clock when `.agents/discord-rpc.json` changes on disk.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/state.test.ts`
Expected: FAIL (`stealth` still emits `Running: git`, `.env.production` is not masked, `.agents/discord-rpc.json` is ignored).

- [ ] **Step 3: Implement 3-tier privacy and per-workspace config caching in `src/state.ts`**

- Store `private readonly baseConfig: PluginConfig`, `private readonly envOverrides: Partial<PluginConfig>`, `private readonly enableWorkspaceConfig: boolean`, `private readonly configCacheTtlMs: number`.
  - When `options.globalConfig` is passed: `baseConfig = { ...DEFAULT_CONFIG, ...options.globalConfig }`; else `baseConfig = config`.
  - `envOverrides = options.env ? toWorkspaceOverrides(parseConfigOverridesFromEnv(options.env)) : {}`.
  - Keep `public readonly config: PluginConfig = { ...this.baseConfig, ...this.envOverrides }` (if `options.globalConfig` or `options.env` provided) or `config` directly.
- Add `workspaceOverrides?: Partial<PluginConfig>` and `lastConfigFetchTime: number` on `WorkspaceContext`.
- Implement `getEffectiveConfig(workspace: WorkspaceContext, now = this.now()): PluginConfig`:
  - Refresh `workspace.workspaceOverrides = toWorkspaceOverrides(loadConfigFile(getWorkspaceConfigPath(workspace.cwd)))` when `this.enableWorkspaceConfig && workspace.key !== DEFAULT_WORKSPACE_KEY && (workspace.workspaceOverrides === undefined || now - workspace.lastConfigFetchTime > this.configCacheTtlMs)`.
  - Return `{ ...this.baseConfig, ...workspace.workspaceOverrides, ...this.envOverrides }`.
- Implement `public getActiveIdleTimeoutSeconds(): number` using `getWinningWorkspace()` + `getEffectiveConfig()`.
- Update `buildActivity()`:
  - Resolve `effectiveConfig = this.getEffectiveConfig(workspace)` and `profile = resolveEffectivePrivacyProfile(effectiveConfig)`.
  - When `profile === "stealth"`: reset `workspace.peakActiveAgents = 0` and return `{ details: "Working in Antigravity", startTimestamp: workspace.startTimestamp, largeImageKey: this.largeImageKey, largeImageText: truncateRpcText(this.largeImageText, 128) }`.
  - Otherwise: pass `profile` to `mapToolToAction()`, pass `effectiveConfig` to `getButtons(workspace, effectiveConfig)` (using `effectiveConfig.showRepoButton && profile !== "stealth"`).

- [ ] **Step 4: Run tests to verify pass**

Run: `npx tsx --test tests/state.test.ts`
Expected: PASS (all existing and new state machine tests pass).

- [ ] **Step 5: Commit**

```bash
git add src/state.ts tests/state.test.ts
git commit -m "feat: support 3-tier privacy profiles and workspace config overrides in state machine"
```

---

### Task 5: Daemon Integration, README Documentation, Build & Full Verification (`src/daemon.ts`, `README.md`, `bin/`)

**Files:**
- Modify: `src/daemon.ts:1-85,461-477,536-545`
- Modify: `tests/ipc.test.ts` (add daemon config / workspace `idleTimeoutSeconds` integration test)
- Modify: `README.md:1-137`
- Rebuild: `bin/daemon.js`, `bin/dispatch.js`

**Interfaces:**
- Consumes: `loadDaemonConfig` (`src/config.ts`), `PresenceStateMachine.getActiveIdleTimeoutSeconds()` (`src/state.ts`)
- Produces:
  - `DaemonOptions` extended with `env?`, `globalConfig?`, `enableWorkspaceConfig?`
  - `isDirectRun` uses `loadDaemonConfig()`
  - `README.md` updated with `privacyProfile`, persistent JSON config docs, `AGY_DISCORD_SUBAGENT_TTL`, and custom `AGY_DISCORD_CLIENT_ID` asset checklist.

- [ ] **Step 1: Write failing test in `tests/ipc.test.ts`**

Add a test in `tests/ipc.test.ts` verifying that `RpcDaemon` forwards `env`/`globalConfig`/`enableWorkspaceConfig` to `PresenceStateMachine` and respects workspace `.agents/discord-rpc.json` (`privacyProfile: "stealth"` suppresses `state`/`buttons`, and workspace `idleTimeoutSeconds` drives `resetIdleTimer()`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/ipc.test.ts`
Expected: FAIL (`DaemonOptions` / `resetIdleTimer` does not yet forward `env`/`globalConfig`/`enableWorkspaceConfig` or workspace `idleTimeoutSeconds`).

- [ ] **Step 3: Update `src/daemon.ts` and `README.md`**

In `src/daemon.ts`:
- Extend `DaemonOptions` with `env?: NodeJS.ProcessEnv; globalConfig?: Partial<PluginConfig>; enableWorkspaceConfig?: boolean;`.
- Pass `{ subagentTtlMs: options.subagentTtlMs, env: options.env, globalConfig: options.globalConfig, enableWorkspaceConfig: options.enableWorkspaceConfig }` to `new PresenceStateMachine(this.config, ...)`.
- In `resetIdleTimer()`: compute `const timeoutSeconds = this.stateMachine.getActiveIdleTimeoutSeconds(); const ms = Math.max(10, (timeoutSeconds ?? 300) * 1000);`.
- In `isDirectRun`: load `const loaded = loadDaemonConfig();` and pass `loaded.config` + `{ watchdogMs: loaded.watchdogMs, subagentTtlMs: loaded.subagentTtlMs, env: process.env, globalConfig: loaded.globalConfig, onWatchdogExit: () => process.exit(0) }`.

In `README.md`:
- Update Features & Configuration sections with:
  - **Privacy Profiles (`stealth`, `balanced`, `showcase`)** + `AGY_DISCORD_PRIVACY_PROFILE` and backward-compatible `AGY_DISCORD_PRIVACY_MODE`.
  - **Environment Variables Table** including `AGY_DISCORD_PRIVACY_PROFILE` (default `balanced`) and `AGY_DISCORD_SUBAGENT_TTL` (default `600`).
  - **Persistent JSON Configuration** (`~/.gemini/antigravity-discord-rpc.json` and `.agents/discord-rpc.json`), precedence (`Env Vars > Workspace Config > Global Config > Defaults`), daemon-level vs workspace-level keys, and example JSON snippet.
  - **Custom Discord Client ID & Required Asset Keys** checklist (`antigravity`, `brain`, `gear`, `hourglass`, `zzz`).

- [ ] **Step 4: Run TypeScript check, build bundles, and run full test suite**

Run: `npx tsc --noEmit && npm run build && npm test`
Expected:
- `npx tsc --noEmit` exits 0 with zero errors.
- `npm run build` rebuilds `bin/daemon.js` and `bin/dispatch.js` cleanly.
- `npm test` passes all tests (0 failures; only the existing Unix-only socket skip on Windows).

- [ ] **Step 5: Commit**

```bash
git add src/daemon.ts tests/ipc.test.ts README.md bin/daemon.js bin/dispatch.js
git commit -m "feat: integrate layered config in daemon, update README, and rebuild binaries"
```

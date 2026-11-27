# Design Document: Stage 3 — Granular Privacy Profiles & Persistent Configuration (`v1.2.0`)

- **Date:** 2026-11-27
- **Branch:** `feat/stage3-privacy-profiles-config` (from `development`)
- **Target Version:** `1.2.0`
- **Status:** Approved
- **Related Docs:**
  - [Edge Cases & Feature Options](../../2026-11-11-edge-cases-and-feature-options.md)
  - [Development Stages Roadmap](../../2026-11-11-development-stages.md)
  - [Stage 1 Stabilization Spec](./2026-11-11-stabilization-patch-v1.0.1-design.md)
  - [Stage 2 Multi-Workspace & Party Spec](./2026-11-27-stage2-multi-workspace-party-design.md)

---

## 1. Intent & The Why

With Stage 1 (`v1.0.1`) hardening and Stage 2 multi-workspace isolation + swarm `party` metrics in place, two gaps remain for day-to-day developer privacy and usability:

1. **Binary Privacy Limitation & Secondary Leaks (Option 3, Edge Case #11a):** Currently `privacyMode` is a single boolean (`true`/`false`). Users who want to share their repository and general progress on Discord without exposing `.env*`, `*.pem`, `*secret*`, `*credentials*`, `id_rsa`, or full shell command arguments have no middle ground between exposing everything and hiding everything.
2. **Environment-Only Configuration & Missing Asset Docs (Option 3, Edge Case #5):** All settings currently require `AGY_DISCORD_*` environment variables, which are cumbersome to configure per project or globally across Antigravity sessions. Additionally, users who supply a custom `AGY_DISCORD_CLIENT_ID` have no documented checklist of required Discord Developer Portal image asset keys (`antigravity`, `brain`, `gear`, `hourglass`, `zzz`).

Stage 3 (`v1.2.0`) introduces a 3-tier `privacyProfile` (`"stealth" | "balanced" | "showcase"`), automatic sensitive-filename redaction, persistent global and per-workspace JSON config loading with strict precedence (`Env Vars > Workspace Config > Global Config > DEFAULT_CONFIG`), and updated `README.md` documentation.

---

## 2. Goals, Non-Goals, and Anti-Goals

### Goals
- **3-Tier Privacy Profiles (`src/types.ts`, `src/sanitizer.ts`, `src/state.ts`):**
  - Add `PrivacyProfile = "stealth" | "balanced" | "showcase"` with default `"balanced"`.
  - `stealth`: displays only `"Working in Antigravity"` + elapsed `startTimestamp` and `largeImageKey`/`largeImageText`; omits `state` (repo/branch), tool/file info, `smallImageKey`/`smallImageText`, `buttons`, and `party` metrics.
  - `balanced` *(Default)*: displays repo, branch, repo button (when `showRepoButton` is enabled), subagent count/`party` metrics, non-sensitive filenames (e.g., `Reading foo.ts`), redacts sensitive filenames (`.env*`, `*.pem`, `*secret*`, `*credentials*`, `id_rsa`, etc.) to `Reading sensitive file` / `Editing sensitive file`, and summarizes `run_command` to base command only (`Running: npm`).
  - `showcase`: displays everything in `balanced` plus full sanitized `run_command` details (`toolSummary` or sanitized `CommandLine`), while still redacting sensitive filenames to prevent accidental credential leaks.
- **Backward Compatibility:**
  - Map `AGY_DISCORD_PRIVACY_MODE=true` (and `privacyMode: true` in config objects/files when `privacyProfile` is not explicitly overridden by a higher-precedence layer) to `"stealth"`.
  - Keep `new PresenceStateMachine()`, `new RpcDaemon()`, `loadConfigFromEnv()`, `sanitizeCommand(cmd, boolean)`, and `mapToolToAction(name, args, boolean)` compatible for existing callers.
- **Persistent JSON Config Loader (`src/config.ts`, `src/daemon.ts`, `src/state.ts`):**
  - Support optional JSON config files at global user path (`~/.gemini/antigravity-discord-rpc.json`) and workspace path (`<cwd>/.agents/discord-rpc.json`).
  - Enforce precedence `Env Vars > Workspace Config > Global Config > DEFAULT_CONFIG` per key without letting unset env vars overwrite file values.
  - Separate daemon-level startup settings (`clientId`, `watchdogTimeoutSeconds`, `subagentTtlSeconds`) from per-workspace cached overrides (`privacyProfile`, `privacyMode`, `showRepoButton`, `idleTimeoutSeconds`) inside the single-process multi-workspace daemon.
  - Gracefully ignore missing or malformed/invalid JSON files and invalid field values without crashing.
- **Documentation (`README.md`):**
  - Document `privacyProfile` (`AGY_DISCORD_PRIVACY_PROFILE`), JSON config file paths and schema, precedence rules, `AGY_DISCORD_SUBAGENT_TTL`, and the mandatory Discord asset key checklist (`antigravity`, `brain`, `gear`, `hourglass`, `zzz`) for custom `AGY_DISCORD_CLIENT_ID`.

### Non-Goals
- Contextual programming language/tech-stack icons and dual interactive buttons (deferred to Stage 4).
- Long-running task Discord webhook notifications (deferred to Stage 5).
- Hot-reloading `clientId`, `watchdogTimeoutSeconds`, or `subagentTtlSeconds` mid-process when global config changes after daemon startup.

### Anti-Goals
- Running separate daemon processes per workspace.
- Allowing unit tests to accidentally read the developer's real `~/.gemini/antigravity-discord-rpc.json` or ambient shell `AGY_DISCORD_*` variables unless explicitly injected.
- Exposing sensitive filenames (`.env`, `id_rsa`, `*.pem`, `*secret*`, `*credentials*`) even in `showcase` mode.

---

## 3. Approaches Considered

### 3.1 Privacy Tier Boundary (`balanced` vs `showcase`)
- **Option A (Chosen):** `balanced` (default) displays repo, branch, repo button, subagent/`party` metrics, and non-sensitive filenames (`Reading foo.ts`), while masking sensitive filenames and reducing `run_command` to its base executable (`Running: npm`, ignoring `toolSummary` and arguments). `showcase` adds full sanitized `run_command` details (`toolSummary` / sanitized `CommandLine`), with sensitive filenames still masked.
  - *Pros:* Preserves the existing default `Reading foo.ts` ergonomics tested by `tests/state.test.ts`, while closing `.env`/key leaks and hiding sensitive command arguments by default.
  - *Trade-off:* Users expecting zero filenames at all must select `stealth`.
- **Option B (Rejected):** `balanced` hides all filenames (`Reading file` / `Editing file`) and only `showcase` displays filenames.
  - *Pros:* Slightly stricter default.
  - *Cons:* Breaks existing default UX (`Reading foo.ts`) and requires rewriting existing default-config tests to `showcase`.

### 3.2 Multi-Workspace Config Resolution
- **Approach 1 (Chosen — 5-Second Per-Workspace Cache in `PresenceStateMachine`):** `WorkspaceContext` resolves and caches `<workspace.cwd>/.agents/discord-rpc.json` with a 5-second TTL (matching `gitInfo` caching), merging `DEFAULT_CONFIG -> Global -> Workspace -> Env`.
  - *Pros:* Edits to `.agents/discord-rpc.json` take effect within 5 seconds without restarting the daemon, and each workspace maintains independent privacy/button/idle settings.
  - *Trade-off:* One lightweight `readFileSync` check every 5 seconds per active workspace.
- **Approach 2 (Rejected — Read-Once on Workspace Registration):** Reads `.agents/discord-rpc.json` only when a `WorkspaceContext` is first created.
  - *Cons:* Changes to workspace config require killing or waiting for watchdog shutdown of the daemon.

---

## 4. Constraints

- **Runtime & Bundler:** Node.js 20+ ESM (`"type": "module"`), compiled into single-file bundles `bin/daemon.js` and `bin/dispatch.js` via `npm run build` (`scripts/build.mjs`).
- **Discord RPC Limits:** All `details`, `state`, `largeImageText`, `smallImageText`, and `party.id` fields remain strictly bounded to 2–128 characters via `truncateRpcText()`; `buttons` remain bounded to max 2 buttons, label <= 32 chars, valid `http:`/`https:` URL <= 512 chars.
- **Zero-Crash Hook Contract:** Missing, unreadable, or malformed JSON config files must never throw or stall hook dispatch.

---

## 5. Detailed Design

### 5.1 Types & Profile Helpers (`src/types.ts`)
- Define and export:
  ```ts
  export type PrivacyProfile = "stealth" | "balanced" | "showcase";
  ```
- Extend `PluginConfig` and `DEFAULT_CONFIG`:
  ```ts
  export interface PluginConfig {
      clientId: string;
      privacyMode: boolean;
      privacyProfile: PrivacyProfile;
      idleTimeoutSeconds: number;
      showRepoButton: boolean;
  }

  export const DEFAULT_CONFIG: PluginConfig = {
      clientId: "1441771215290372156",
      privacyMode: false,
      privacyProfile: "balanced",
      idleTimeoutSeconds: 300,
      showRepoButton: true
  };
  ```
- Export `parsePrivacyProfile(raw: string | undefined): PrivacyProfile | undefined` accepting `"stealth"`, `"balanced"`, or `"showcase"` (case-insensitive, trimmed).
- Export `resolveEffectivePrivacyProfile(config: Pick<PluginConfig, "privacyMode" | "privacyProfile">): PrivacyProfile`:
  - Returns `"stealth"` if `config.privacyMode === true`.
  - Else returns `config.privacyProfile` if valid (`"stealth" | "balanced" | "showcase"`), else `"balanced"`.
  - This guarantees `{ ...DEFAULT_CONFIG, privacyMode: true }` resolves to `"stealth"` automatically.
- Update `loadConfigFromEnv(env = process.env): PluginConfig`:
  - Reads `AGY_DISCORD_PRIVACY_PROFILE` and `AGY_DISCORD_PRIVACY_MODE`.
  - Precedence within env vars: if `AGY_DISCORD_PRIVACY_PROFILE` is valid, it sets `privacyProfile` and derives `privacyMode = privacyProfile === "stealth"`. Otherwise, if `AGY_DISCORD_PRIVACY_MODE` is `"true"`/`"1"`, it sets `privacyMode = true` and `privacyProfile = "stealth"`. Otherwise, `privacyMode = false` and `privacyProfile = DEFAULT_CONFIG.privacyProfile` (`"balanced"`).

### 5.2 Persistent JSON Configuration Loader (`src/config.ts`)
Create `src/config.ts` to keep file-system/OS access cleanly separated from `src/types.ts`:

- **File Paths:**
  - Global config path helper `getGlobalConfigPath(homedir = os.homedir()): string` -> `path.join(homedir, ".gemini", "antigravity-discord-rpc.json")`.
  - Workspace config path helper `getWorkspaceConfigPath(cwd: string): string` -> `path.join(path.resolve(cwd), ".agents", "discord-rpc.json")`.
- **Supported JSON Schema (all fields optional):**
  ```json
  {
    "clientId": "1441771215290372156",
    "privacyProfile": "balanced",
    "privacyMode": false,
    "idleTimeoutSeconds": 300,
    "showRepoButton": true,
    "watchdogTimeoutSeconds": 1800,
    "subagentTtlSeconds": 600
  }
  ```
- **Daemon-Level vs. Workspace-Level Scope:**
  - **Daemon-level** (resolved once at daemon startup from `Env > Global Config > Defaults`): `clientId`, `watchdogTimeoutSeconds` (ms = `* 1000`, default `1_800_000`), `subagentTtlSeconds` (ms = `* 1000`, default `600_000`). If present in `.agents/discord-rpc.json`, these three fields are ignored for workspace overrides.
  - **Workspace-level** (resolved per `WorkspaceContext` from `Env > Workspace Config > Global Config > Defaults`): `privacyProfile`, `privacyMode`, `showRepoButton`, `idleTimeoutSeconds`.
- **Defensive Parsing (`loadConfigFile(filePath: string)`):**
  - Uses `fs.readFileSync(filePath, "utf-8")` + `JSON.parse` wrapped in `try/catch`; returns `{}` if missing, directory/unreadable, non-object (e.g., `null`, array, primitive), or invalid JSON.
  - Validates each field independently:
    - `clientId`: non-empty trimmed `string`
    - `privacyProfile`: valid `"stealth" | "balanced" | "showcase"` (case-insensitive)
    - `privacyMode`: `boolean`
    - `idleTimeoutSeconds`: finite number `> 0`
    - `showRepoButton`: `boolean`
    - `watchdogTimeoutSeconds`: finite integer `> 0`
    - `subagentTtlSeconds`: finite integer `> 0`
  - **Per-Layer Privacy Normalization:** Within a single layer (global file, workspace file, or env overrides):
    - If `privacyProfile` is present and valid, set `privacyProfile` and `privacyMode: privacyProfile === "stealth"`.
    - Else if `privacyMode` is `true`, set `privacyProfile: "stealth"` and `privacyMode: true`.
    - Else if `privacyMode` is `false`, set `privacyProfile: "balanced"` and `privacyMode: false`.
    - If neither is present in that layer, omit both so the lower-precedence layer's privacy setting is preserved!
- **Explicit Env Override Extractor (`parseConfigOverridesFromEnv(env)`):**
  - Extracts only variables explicitly and validly present in `env` (`AGY_DISCORD_CLIENT_ID`, `AGY_DISCORD_PRIVACY_PROFILE`, `AGY_DISCORD_PRIVACY_MODE`, `AGY_DISCORD_IDLE_TIMEOUT`, `AGY_DISCORD_SHOW_REPO_BUTTON`, `AGY_DISCORD_WATCHDOG_TIMEOUT`, `AGY_DISCORD_SUBAGENT_TTL`).
  - Unset or invalid env vars are omitted so they never clobber JSON config values.
- **Composition Helpers:**
  - `loadDaemonConfig(options?: { env?: NodeJS.ProcessEnv; globalConfigPath?: string })`: reads `globalOverrides` + `envOverrides`, returns `{ config: PluginConfig, globalConfig: Partial<PluginConfig>, envOverrides: Partial<PluginConfig>, watchdogMs: number, subagentTtlMs: number }`.
  - `resolveWorkspaceConfig(params: { baseConfig: PluginConfig; cwd?: string; envOverrides?: Partial<PluginConfig>; enableWorkspaceConfig?: boolean }): PluginConfig`: merges `{ ...baseConfig, ...workspaceOverrides, ...envOverrides }` safely.

### 5.3 Sensitive Filename Detection & Profile-Aware Tool Mapping (`src/sanitizer.ts`)
- Export `isSensitiveFilename(filePath: string): boolean`:
  - Extracts `basename = path.basename(filePath.trim().replace(/\\/g, "/")).toLowerCase()` and also checks normalized path segments.
  - Returns `true` for:
    - Dotenv files: `/^\.env(\.|$)/i` (`.env`, `.env.local`, `.env.production`, etc.)
    - Certificates/keys by extension: `.pem`, `.key`, `.p12`, `.pfx`, `.jks`, `.keystore`, `.ppk`
    - SSH private key files: `/^id_(rsa|ed25519|ecdsa|dsa)(?:\.(?!pub$).*)?$/i` (matches `id_rsa`, `id_ed25519`, `id_rsa.bak`, etc., without flagging `.pub`? Or any `id_rsa` — wait: flagging `id_rsa` and non-`.pub` variants, plus `.ssh` directory paths if any)
    - Credential dotfiles: `.npmrc`, `.pypirc`, `.netrc`, `.htpasswd`, `.pgpass`
    - Keyword matches in basename: `*secret*` (`secrets.json`, `client_secret.yaml`), `*credential*` (`credentials.json`, `aws-credentials.toml`), `service-account*.json` / `service_account*.json` / `*serviceaccount*.json`
  - Returns `false` for normal source files like `index.ts`, `foo.ts`, `config.ts`, `tokenizer.ts`, `auth.ts`.
- Update `mapToolToAction(toolName: string, args?: Record<string, unknown>, privacy: boolean | PrivacyProfile = false): string`:
  - Map `privacy`:
    - `true` -> `"stealth"` (retaining `"Running: <baseCmd>"` / `"Running command"` when called directly at sanitizer unit level)
    - `false` -> `"showcase"` (retaining full sanitized `run_command` for existing `tests/sanitizer.test.ts` callers that omit or pass `false`)
    - `"stealth" | "balanced" | "showcase"` -> used directly.
  - For `read_file`: if `file` is detected and `isSensitiveFilename(rawPath)`, return `"Reading sensitive file"`; else `file ? "Reading " + file : "Reading file"`.
  - For `write_file` / `edit_file`: if `file` is detected and `isSensitiveFilename(rawPath)`, return `"Editing sensitive file"`; else `file ? "Editing " + file : "Editing file"`.
  - For `run_command`:
    - When effective mode is `"stealth"` or `"balanced"`: ignore `args.toolSummary`, sanitize `args.CommandLine` with `sanitizeCommand(cmd, true)` (base executable only -> `"Running: <cmd>"` or `"Running command"`).
    - When effective mode is `"showcase"` (or `false`): use sanitized `args.toolSummary` first (`sanitizeCommand(summary, false)`), else sanitized `args.CommandLine` (`sanitizeCommand(cmd, false)`).

### 5.4 Workspace Config Caching & `stealth` Output (`src/state.ts`, `src/daemon.ts`)
- Extend `PresenceStateMachineOptions`:
  ```ts
  export interface PresenceStateMachineOptions {
      subagentTtlMs?: number;
      now?: () => number;
      env?: NodeJS.ProcessEnv;
      globalConfig?: Partial<PluginConfig>;
      enableWorkspaceConfig?: boolean;
      configCacheTtlMs?: number;
  }
  ```
  - Defaults: `enableWorkspaceConfig = true`, `configCacheTtlMs = 5000`, `env = undefined` (only explicitly passed `env` acts as overrides so unit tests using `new PresenceStateMachine(config)` are immune to ambient shell env vars; `RpcDaemon` in `isDirectRun` passes `process.env`).
- Extend `WorkspaceContext`:
  - Add `workspaceOverrides?: Partial<PluginConfig>;` and `lastConfigFetchTime: number;`.
  - Helper `getEffectiveConfig(workspace: WorkspaceContext, now = this.now()): PluginConfig`:
    - Refreshes `workspace.workspaceOverrides` from `<workspace.cwd>/.agents/discord-rpc.json` when `enableWorkspaceConfig` is true and `workspace.key !== DEFAULT_WORKSPACE_KEY` (or when `workspace.cwd` is used) and `now - workspace.lastConfigFetchTime > this.configCacheTtlMs`.
    - Returns `{ ...this.config, ...workspace.workspaceOverrides, ...this.envOverrides }` (note: if `globalConfig` was provided separately and `this.config` already includes `globalConfig`, `workspaceOverrides` cleanly overrides `globalConfig` and `envOverrides` cleanly overrides `workspaceOverrides`).
    - Wait — subtle point! What if `DEFAULT_CONFIG` has `{ privacyProfile: "balanced" }`, `globalConfig` has `{ privacyProfile: "stealth" }`, `workspaceOverrides` has `{}` (empty), and `this.config` is `{ ...DEFAULT_CONFIG, ...globalConfig, ...envOverrides }`? If `envOverrides` was already baked into `this.config`, then a workspace `{ privacyProfile: "showcase" }` would be overridden if `envOverrides` wasn't applied *after* `workspaceOverrides`, which IS why applying `...this.envOverrides` LAST fixes it! Wait: what if `envOverrides` IS `{}` and `globalConfig` IS `{ privacyProfile: "stealth" }`? Then `this.baseConfig = { ...DEFAULT_CONFIG, ...globalConfig }`, `workspaceOverrides = { privacyProfile: "showcase" }`, and `{ ...this.baseConfig, ...workspaceOverrides, ...this.envOverrides }` evaluates to `"showcase"`!
    - Let's make `baseConfig` store `{ ...DEFAULT_CONFIG, ...globalConfig }` when `options.globalConfig` is passed (or `config` when constructed directly), and `this.config` remain `{ ...baseConfig, ...this.envOverrides }` for public `sm.config` compatibility.
- Update `buildActivity()` in `src/state.ts`:
  - Resolve `effectiveConfig = this.getEffectiveConfig(workspace)` and `profile = resolveEffectivePrivacyProfile(effectiveConfig)`.
  - If `profile === "stealth"`:
    - Reset `workspace.peakActiveAgents = 0`.
    - Return:
      ```ts
      {
          details: "Working in Antigravity",
          startTimestamp: workspace.startTimestamp,
          largeImageKey: this.largeImageKey,
          largeImageText: truncateRpcText(this.largeImageText, 128)
      }
      ```
      (`state`, `smallImageKey`, `smallImageText`, `buttons`, and `party` are all omitted).
  - If `profile === "balanced"` or `"showcase"`:
    - Pass `profile` into `mapToolToAction()`.
    - Pass `effectiveConfig` into `getButtons(workspace, effectiveConfig)`.
    - Build `state`, `smallImageKey`/`smallImageText`, `party`, and `buttons` as in Stage 2.
- Add `public getActiveIdleTimeoutSeconds(): number` on `PresenceStateMachine` returning the winning workspace's effective `idleTimeoutSeconds` (falling back to `this.config.idleTimeoutSeconds`), and use it in `RpcDaemon.resetIdleTimer()`.
- Update `DaemonOptions` in `src/daemon.ts` to accept `env?: NodeJS.ProcessEnv`, `globalConfig?: Partial<PluginConfig>`, `enableWorkspaceConfig?: boolean`, and update `isDirectRun` to construct `RpcDaemon` via `loadDaemonConfig()`.

### 5.5 Documentation (`README.md`)
- Replace/upgrade `privacyMode`-only documentation with:
  - **Privacy Profiles Table** (`stealth`, `balanced` default, `showcase`) + `AGY_DISCORD_PRIVACY_PROFILE` and backward-compatible `AGY_DISCORD_PRIVACY_MODE`.
  - **Persistent JSON Configuration** section documenting `~/.gemini/antigravity-discord-rpc.json` (global), `.agents/discord-rpc.json` (per-workspace), precedence (`Env Vars > Workspace Config > Global Config > Defaults`), daemon-level vs workspace-level fields, and an example JSON snippet.
  - **Environment Variables Table** including `AGY_DISCORD_PRIVACY_PROFILE` and `AGY_DISCORD_SUBAGENT_TTL` (from Stage 2, default `600`).
  - **Custom Discord Client ID & Asset Key Checklist** listing the 5 required Rich Presence asset keys (`antigravity`, `brain`, `gear`, `hourglass`, `zzz`) to upload to the Discord Developer Portal when setting `AGY_DISCORD_CLIENT_ID`.

---

## 6. What's Left to the Builder

- Exact regex ordering and helper decomposition inside `src/sanitizer.ts` and `src/config.ts`.
- Updating `tests/types.test.ts`, `tests/sanitizer.test.ts`, `tests/state.test.ts`, and `tests/ipc.test.ts` (if needed) under TDD, plus adding a dedicated `tests/config.test.ts` (or placing config loader tests in `tests/types.test.ts` / `tests/config.test.ts`) to cover JSON precedence, malformed JSON fallback, and daemon-vs-workspace field isolation.
- Rebuilding `bin/daemon.js` and `bin/dispatch.js` via `npm run build` and verifying `npx tsc --noEmit` and `npm test`.

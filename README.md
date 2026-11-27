# Antigravity Discord Rich Presence

A high-performance, privacy-conscious Discord Rich Presence plugin for **Antigravity App** (Antigravity 2.0).

This plugin displays your real-time agent activity, current project, Git branch, active tool calls, concurrent subagents, and elapsed workspace time on your Discord profile.

---

## Features

- **Smart Hybrid Architecture**:
  - **Lightweight Dispatcher (`bin/dispatch.js`)**: Executes synchronously on Antigravity lifecycle hooks, transmitting state changes over an IPC socket in under 50ms. Never stalls agent turns or tool execution.
  - **Persistent Background Daemon (`bin/daemon.js`)**: Maintains Discord RPC IPC connection, handles auto-reconnection with backoff, throttles presence updates to Discord's rate limits (2s window), and manages idle timers.
  - **Zero Manual Management**: The dispatcher automatically awakens the background daemon on `SessionStart` if it is offline.
- **Subagent Arbitration**:
  - Dynamically tracks concurrent subagents and reflects their activity in your presence status (e.g. `Working with 2 subagents`).
  - Subagent completions do not prematurely clear the primary agent session.
- **Git Metadata & Smart Links**:
  - Automatically detects Git repository name and active branch.
  - Generates clickable Discord buttons pointing to your repository (GitHub, GitLab, Bitbucket).
- **Privacy & Security First**:
  - Automatic scrubbing of sensitive tokens, bearer secrets, passwords, and private credentials from tool arguments and remote Git URLs.
  - 3-tier privacy profiles (`stealth`, `balanced`, `showcase`) with automatic redaction of sensitive filenames (`.env*`, `*.pem`, `*secret*`, `*credentials*`, `id_rsa`, etc.).
- **Idle Inactivity Detection**:
  - Transitions to `Idle (awaiting instructions)` after a configurable timeout (default: 5 minutes) when waiting for user review.

---

## Presence States

| State | Status Text | Discord Activity Details |
| :--- | :--- | :--- |
| `THINKING` | Thinking... | Reasoning & planning next action |
| `EXECUTING_TOOL` | Executing tool | Running command / reading file / tool name |
| `WAITING_REVIEW` | Waiting for review | Finished turn, awaiting user review |
| `IDLE` | Idle | Inactive in workspace |

---

## Installation

### Prerequisites
1. **Node.js**: Version 18+ must be installed and available in your `PATH`.
2. **Discord Desktop**: The native Discord desktop app (Windows, macOS, or Linux) must be running.
3. **Discord Activity Privacy**: In Discord, go to **User Settings** (`⚙`) → **Activity Privacy** → turn on **"Display current activity as a status message"**.

---

### Quick Install (Zero Build Required)

Because production binaries in `bin/` are pre-bundled, you **do not** need `npm install` or `npm run build` to use the plugin.

#### Option 1: Global Plugin (Recommended for All Projects)
Makes Discord Rich Presence active across all your Antigravity workspaces.

* **On Windows (PowerShell):**
  ```powershell
  git clone https://github.com/kyASse/antigravity-discord-rich-presence.git "$HOME\.gemini\config\plugins\antigravity-discord-presence"
  ```

* **On macOS / Linux (Bash):**
  ```bash
  git clone https://github.com/kyASse/antigravity-discord-rich-presence.git ~/.gemini/config/plugins/antigravity-discord-presence
  ```

#### Option 2: Project-Scoped Plugin
Activate the plugin only for a specific repository:

* **On Windows (PowerShell):**
  ```powershell
  New-Item -ItemType Directory -Force -Path ".agents\plugins"
  git clone https://github.com/kyASse/antigravity-discord-rich-presence.git ".agents\plugins\antigravity-discord-presence"
  ```

* **On macOS / Linux (Bash):**
  ```bash
  mkdir -p .agents/plugins
  git clone https://github.com/kyASse/antigravity-discord-rich-presence.git .agents/plugins/antigravity-discord-presence
  ```

After cloning, **restart Antigravity App** (or start a new conversation session). The plugin will automatically connect to Discord!

---

## Configuration

The plugin works out of the box with zero configuration. Settings are resolved using the following precedence (highest to lowest):

`Environment Variables > Workspace Config (.agents/discord-rpc.json) > Global Config (~/.gemini/antigravity-discord-rpc.json) > Defaults`

### Privacy Profiles (`privacyProfile`)

| Profile | Repo & Branch | Action Details | Sensitive Files (`.env*`, `*.pem`, `id_rsa`, etc.) | Repo Button & Party |
| :--- | :--- | :--- | :--- | :--- |
| `stealth` | Hidden | `"Working in Antigravity"` + timer only | Hidden | Hidden |
| `balanced` *(Default)* | Shown | Non-sensitive filenames + base command (`Running: npm`) | Redacted (`Reading/Editing sensitive file`) | Shown |
| `showcase` | Shown | Non-sensitive filenames + full sanitized command/summary | Redacted (`Reading/Editing sensitive file`) | Shown |

> [!TIP]
> Setting `AGY_DISCORD_PRIVACY_MODE=true` (or `"privacyMode": true` in JSON) automatically maps to the `stealth` profile for backward compatibility.

### Environment Variables

| Variable | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `AGY_DISCORD_CLIENT_ID` | `string` | `1441771215290372156` | Custom Discord Application Client ID *(daemon-level)* |
| `AGY_DISCORD_PRIVACY_PROFILE` | `string` | `"balanced"` | Privacy preset: `"stealth"`, `"balanced"`, or `"showcase"` |
| `AGY_DISCORD_PRIVACY_MODE` | `boolean` | `false` | Legacy flag: when `true` (and profile unset), maps to `"stealth"` |
| `AGY_DISCORD_IDLE_TIMEOUT` | `number` | `300` | Inactivity idle timeout in seconds (default: 5 minutes) |
| `AGY_DISCORD_WATCHDOG_TIMEOUT` | `number` | `1800` | Watchdog inactivity shutdown timeout in seconds *(daemon-level)* |
| `AGY_DISCORD_SUBAGENT_TTL` | `number` | `600` | Orphaned subagent expiry TTL in seconds *(daemon-level, default: 10 minutes)* |
| `AGY_DISCORD_SHOW_REPO_BUTTON` | `boolean` | `true` | Show clickable "View Repository" action button |
| `AGY_AUTO_SPAWN` | `boolean` | `true` | Set to `false` to disable auto-spawning the daemon |
| `AGY_IPC_PATH` | `string` | Auto-detected | Custom IPC pipe or socket path |

### Persistent JSON Configuration

Instead of environment variables, you can persist settings in optional JSON files:

- **Global User Config** *(daemon-level & default preferences)*: `~/.gemini/antigravity-discord-rpc.json` (Windows: `%USERPROFILE%\.gemini\antigravity-discord-rpc.json`)
- **Workspace Config** *(per-project overrides, refreshed every 5s)*: `<workspace>/.agents/discord-rpc.json`

Example JSON configuration:

```json
{
  "clientId": "1441771215290372156",
  "privacyProfile": "balanced",
  "idleTimeoutSeconds": 300,
  "showRepoButton": true,
  "watchdogTimeoutSeconds": 1800,
  "subagentTtlSeconds": 600
}
```

> [!NOTE]
> **Daemon-Level vs. Workspace-Level Keys:** `clientId`, `watchdogTimeoutSeconds`, and `subagentTtlSeconds` apply at daemon startup (from Global Config and Environment Variables) and are ignored if placed in `.agents/discord-rpc.json`. Workspace configs can override `privacyProfile`, `privacyMode`, `showRepoButton`, and `idleTimeoutSeconds` independently per repository. Missing or malformed JSON files are safely ignored.

### Custom `AGY_DISCORD_CLIENT_ID` Asset Checklist

If you use your own Discord Application ID via `AGY_DISCORD_CLIENT_ID` (or `"clientId"` in global config), upload the following **Rich Presence Art Asset** keys in the [Discord Developer Portal](https://discord.com/developers/applications) under **Rich Presence → Art Assets** so all status icons render properly:

- [ ] `antigravity` *(Large image — main Antigravity icon)*
- [ ] `brain` *(Small image — `THINKING` state)*
- [ ] `gear` *(Small image — `EXECUTING_TOOL` state)*
- [ ] `hourglass` *(Small image — `WAITING_REVIEW` state)*
- [ ] `zzz` *(Small image — `IDLE` state)*

> [!NOTE]
> **Action Buttons on Your Own Profile:** Discord Desktop intentionally disables clicking Rich Presence action buttons (such as "View Repository") when viewing your own profile preview. Other Discord users viewing your profile can click these buttons normally.

---

## Development & Testing

### Prerequisites
- Node.js >= 20.0.0
- npm

### Setup
If you wish to modify the source code or contribute:

```bash
git clone https://github.com/kyASse/antigravity-discord-rich-presence.git
cd antigravity-discord-rich-presence
npm install
```

### Build
Bundle the standalone executables in `bin/` using `esbuild`:

```bash
npm run build
```

### Run Tests
Run the automated test suite (including unit, IPC, state machine, sanitizer, and end-to-end tests):

```bash
npm test
```

---

## License

MIT License. Copyright (c) 2026 Antigravity Engineering.

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
  - Built-in `privacyMode` to hide repository links and mask command details.
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

### Option 1: Global Plugin (Recommended)

Install globally so the presence updates across all your Antigravity workspaces:

```bash
# Clone or copy into your global Antigravity plugins directory:
# On Windows: %USERPROFILE%\.gemini\config\plugins\discord-presence
# On Linux/macOS: ~/.gemini/config/plugins/discord-presence

git clone https://github.com/sanbercode/antigravity-discord-rich-presence.git ~/.gemini/config/plugins/discord-presence
cd ~/.gemini/config/plugins/discord-presence
npm install
npm run build
```

### Option 2: Project-Scoped Plugin

Install locally inside a specific project repository:

```bash
mkdir -p .agents/plugins/discord-presence
git clone https://github.com/sanbercode/antigravity-discord-rich-presence.git .agents/plugins/discord-presence
cd .agents/plugins/discord-presence
npm install
npm run build
```

---

## How It Works

Antigravity invokes the plugin hooks configured in `hooks.json` on key agent lifecycle events:

```
[Antigravity Session]
        │
        ├── SessionStart ──> bin/dispatch.js ──(Auto-spawn)──> bin/daemon.js
        ├── PreInvocation ─> bin/dispatch.js ──(Local IPC)────>       │
        ├── PreToolUse ────> bin/dispatch.js ──(Local IPC)────>       │
        ├── PostToolUse ───> bin/dispatch.js ──(Local IPC)────>       │
        ├── PostInvocation > bin/dispatch.js ──(Local IPC)────>       ▼
        └── Stop ──────────> bin/dispatch.js ──(Local IPC)──> [Discord Client]
```

1. When Antigravity starts or emits an event, `bin/dispatch.js` is triggered.
2. `dispatch.js` sends the payload over a local named pipe (Windows) or domain socket (macOS/Linux) to `daemon.js` within <50ms.
3. If `daemon.js` is not yet running, `dispatch.js` automatically spawns it in the background.
4. `daemon.js` computes state transitions, arbitrates subagents, throttles rapid updates, and pushes the rich presence activity directly to Discord via Discord RPC.

---

## Configuration

The plugin works out of the box with zero configuration. You can customize behavior using environment variables:

| Variable | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `AGY_DISCORD_CLIENT_ID` | `string` | `1347000000000000000` | Custom Discord Application Client ID |
| `AGY_DISCORD_PRIVACY_MODE` | `boolean` | `false` | When `true`, hides repository buttons and obscures command details |
| `AGY_DISCORD_IDLE_TIMEOUT` | `number` | `300` | Inactivity idle timeout in seconds (default: 5 minutes) |
| `AGY_DISCORD_SHOW_REPO_BUTTON` | `boolean` | `true` | Whether to display "View Repository" button |
| `AGY_AUTO_SPAWN` | `boolean` | `true` | Set to `false` to disable auto-spawning the daemon |
| `AGY_IPC_PATH` | `string` | Auto-detected | Custom IPC pipe or socket path |

---

## Development & Testing

### Prerequisites
- Node.js >= 20.0.0
- npm

### Build
Bundle the standalone executables in `bin/` using `esbuild`:

```bash
npm run build
```

### Run Tests
Run the comprehensive test suite (including unit, IPC, state machine, sanitizer, and end-to-end tests):

```bash
npm test
```

---

## License

MIT License. Copyright (c) 2026 Antigravity Engineering.

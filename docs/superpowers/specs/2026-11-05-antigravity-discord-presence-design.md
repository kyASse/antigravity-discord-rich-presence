# Design Document: Antigravity Discord Rich Presence Plugin

- **Date:** 2026-11-05
- **Author:** Antigravity Engineering
- **Status:** Proposed
- **Target Platform:** Google Antigravity 2.0 (Antigravity App Desktop)

---

## 1. Intent & The Why

Developers using **Antigravity App** orchestrate autonomous AI agents to code, test, research, and execute complex programming tasks. Unlike traditional code editors where activity is limited to typing files, Antigravity's workflow involves rich agentic lifecycles: agents thinking, executing terminal commands, dispatching subagents, and waiting for user reviews.

Currently, there is no direct integration between Antigravity App and Discord Desktop. Users want to display their real-time pair programming and agentic workflows on their Discord profile to share context with teammates and community members.

---

## 2. Goals, Non-Goals, and Anti-Goals

### Goals
- **Real-Time Agent Visibility:** Accurately reflect current Antigravity activity (thinking, running tools, waiting for feedback, idling) on Discord Rich Presence.
- **Native Plugin Architecture:** Seamlessly integrate as a standard Antigravity Plugin using official lifecycle hooks (`hooks.json`).
- **Smart Hybrid Presence:** Automatically transition between active agent operational status and calm high-level project milestones.
- **Privacy & Security First:** Never leak sensitive environment variables, secrets, or internal commands to Discord. Provide a configurable Privacy Mode.
- **Zero Noticeable Latency:** Hooks must execute instantaneously without stalling the agent's execution loop.

### Non-Goals
- Supporting web-only Discord (Discord Rich Presence requires Discord Desktop's local IPC named pipe / socket).
- Building an IDE-specific VS Code extension (this is exclusively designed for Antigravity App's agentic lifecycle).
- Interactive Discord bot commands (this is purely outgoing Rich Presence).

### Anti-Goals
- Spamming Discord RPC with high-frequency updates that cause rate-limiting or client crashes.
- Running heavy processes inside synchronous hook triggers that slow down agent reasoning.

---

## 3. Evaluated Approaches & Decision

### Approach 1: Native Antigravity Plugin (Lifecycle Hooks + Local Daemon) [CHOSEN]
- **Mechanism:** An Antigravity Plugin with `hooks.json` intercepting agent lifecycle events (`SessionStart`, `PreInvocation`, `PreToolUse`, `PostToolUse`, `PostInvocation`, `Stop`). A lightweight background daemon maintains the persistent Discord RPC named pipe socket. The hooks notify the daemon via quick local IPC (local HTTP/socket or state file).
- **Trade-offs:** Highly accurate and instantaneous; officially supported plugin structure; requires a small background daemon to keep the Discord socket alive.
- **Reason for Choice:** It is the cleanest, most responsive, and officially supported method in Antigravity App.

### Approach 2: Standalone Background Sidecar (Transcript File Watcher) [REJECTED]
- **Mechanism:** A standalone daemon watching `<appDataDir>/brain/<conversation-id>/.system_generated/logs/transcript.jsonl`.
- **Trade-offs:** Completely decoupled, but suffers from file I/O tailing latency, multiple concurrent conversation disambiguation issues, and potential file locking.

### Approach 3: Standalone MCP Server [REJECTED]
- **Mechanism:** Using MCP tool calls to update presence.
- **Trade-offs:** Requires the model to consciously call tools to update presence, which wastes model tokens and does not update during the thinking phase.

---

## 4. Presence State Machine (Smart Hybrid Model)

The plugin implements four primary states, managed dynamically by the daemon:

| State | Trigger Event / Condition | Discord Details | Discord State | Large / Small Icon |
| :--- | :--- | :--- | :--- | :--- |
| **Thinking** | `PreInvocation` | `🤖 Agent is thinking...` | `Project: <project_name> (<branch>)` | Antigravity Logo / Brain Icon |
| **Executing Tool** | `PreToolUse` | `⚙️ Running: <friendly_action>` | `Project: <project_name> (<branch>)` | Antigravity Logo / Gear Icon |
| **Waiting Review**| `Stop` (`terminationReason: "NO_TOOL_CALL"`) or `PostInvocation` | `⏳ Waiting for user review` | `Project: <project_name> (<branch>)` | Antigravity Logo / Hourglass |
| **Idle** | 5 mins inactivity in `Waiting Review` | `Idling in workspace` | `Project: <project_name>` | Antigravity Logo / Zzz Icon |
| **Cleared / Offline** | Session closed, user cancellation, daemon shutdown | Presence cleared | N/A | None |

### State Machine Lifecycle Contract
- **Normal Turn End:** When the agent finishes responding and requires user input, Antigravity triggers `Stop` with `terminationReason: "NO_TOOL_CALL"`. In this case, the daemon does **not** clear presence; it transitions into `Waiting Review` and starts a 5-minute inactivity countdown towards `Idle`.
- **Abnormal / Session End:** If the session is explicitly terminated or cancelled by the user, the daemon clears presence immediately.
- **Inactivity Timer:** Any new `PreInvocation` or `PreToolUse` event automatically resets the idle countdown timer.

### Multi-Session & Subagent Arbitration
To prevent race conditions when subagents (`invoke_subagent`) or multiple sessions run concurrently:
1. The daemon tracks sessions by `conversationId` in an active session registry.
2. **Precedence Hierarchy:**
   - Active Tool Execution (Root agent or Subagent) has the highest display priority.
   - Active Thinking (`PreInvocation`) has second priority.
   - When any subagent is active, the status text includes subagent indicators (e.g. `(2 subagents active)`).
   - Only when **all** active agents/subagents in the workspace transition to waiting does the presence switch to `Waiting Review`.

### Friendly Tool Mapping
Instead of raw internal tool names, actions are mapped into user-friendly descriptions:
- `run_command` -> `Running: <command_summary>` (sanitized, e.g. `npm test`, `cargo build`)
- `read_file` / `edit_file` / `write_file` -> `Editing <filename>`
- `invoke_subagent` -> `Dispatching Subagent`
- `search_web` -> `Searching documentation`

### Discord Application ID & Asset Configuration
- **Default Application ID:** Uses the pre-registered Antigravity Client ID `1568484776703299726`.
- **Configurable Fallback:** A local `config.json` allows users to specify their own `clientId` and custom image asset keys if desired.
- **Asset Fallback:** If specific asset keys are unavailable or fail to resolve on Discord's CDN, the daemon gracefully falls back to text-only presence without crashing.

### Git & Workspace Detection
- Detects the current working directory from the hook payload or workspace root.
- Uses local Git metadata (`git rev-parse --abbrev-ref HEAD` and `git config --get remote.origin.url`).
- Sanitizes remote URLs (strips credentials) to populate an optional "View Repository" action button.

---

## 5. System Architecture

```text
+----------------------------------------------------------------+
|                      Antigravity App                           |
|                                                                |
|   +-------------------+              +---------------------+   |
|   |  Agent Lifecycle  | --(hooks)--> |     hooks.json      |   |
|   +-------------------+              +----------+----------+   |
+-------------------------------------------------|--------------+
                                                  | executes CLI
                                                  v
                                       +---------------------+
                                       |   cli-dispatcher    |
                                       +----------+----------+
                                                  | local socket / HTTP
                                                  v
                                       +---------------------+
                                       |   rpc-daemon.js     |
                                       |  - State Machine    |
                                       |  - Throttler (2s)   |
                                       |  - Sanitizer        |
                                       +----------+----------+
                                                  | @xhayper/discord-rpc
                                                  | (Named Pipe / IPC)
                                                  v
                                       +---------------------+
                                       |   Discord Desktop   |
                                       +---------------------+
```

### Directory Structure of the Plugin
```text
antigravity-discord-presence/
├── plugin.json                 # Antigravity Plugin Manifest
├── hooks.json                  # Lifecycle Hooks configuration
├── package.json                # Node.js dependencies (@xhayper/discord-rpc)
├── bin/
│   ├── daemon.js               # Background RPC daemon
│   └── dispatch.js             # Fast CLI hook bridge
├── src/
│   ├── index.ts                # Entry point & exports
│   ├── daemon.ts               # Core daemon logic & IPC server
│   ├── discord.ts              # @xhayper/discord-rpc client wrapper
│   ├── state.ts                # Presence state machine & transitions
│   ├── git.ts                  # Git branch & remote URL parser
│   └── sanitizer.ts            # Privacy filter & command masking
├── tsconfig.json
└── README.md
```

---

## 6. Security & Privacy Considerations

1. **Credential Stripping:** Any Git remote URLs containing embedded tokens or basic auth credentials are strictly scrubbed (`https://token@github.com/...` -> `https://github.com/...`).
2. **Command Parameter Masking:** In privacy mode or when sensitive patterns (tokens, keys, passwords) are detected in `run_command` arguments, the details display only the base command (e.g. `Running terminal task` instead of the full command line).
3. **Local IPC Security:** Communication between `dispatch.js` and `daemon.js` occurs via an internal named pipe (`\\.\pipe\agy-discord-rpc`) or loopback unix socket with a session-scoped auth token to prevent unauthorized local process tampering.

---

## 7. What Is Left to the Builder

- Choosing between Windows Named Pipe vs local HTTP loopback port for the CLI-to-daemon bridge.
- Exact packaging script (e.g. bundling TypeScript into standalone JS via `esbuild` or `ncc` so users do not need `npm install` on first load).
- Determining idle timeout threshold (defaulting to 300 seconds / 5 minutes).

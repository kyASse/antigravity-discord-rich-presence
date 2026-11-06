import child_process from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sendIpcMessage, getIpcAddress } from "./ipc.js";
import type { HookPayload } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Parses command line arguments into a partial HookPayload.
 * Supports:
 *   --event <name>
 *   --conversationId <id>
 *   --toolName <name>
 *   --toolArgs <json_string>
 *   --terminationReason <reason>
 *   --isSubagent [true|false]
 *   --cwd <dir>
 * Handles both '--flag value' and '--flag=value'.
 */
export function parseCliArgs(argv: string[]): Partial<HookPayload> {
    const payload: Partial<HookPayload> = {};

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        let key = arg;
        let value: string | undefined = undefined;

        if (arg.startsWith("--")) {
            const eqIndex = arg.indexOf("=");
            if (eqIndex !== -1) {
                key = arg.slice(0, eqIndex);
                value = arg.slice(eqIndex + 1);
            } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
                value = argv[++i];
            }
        }

        switch (key) {
            case "--event":
                if (value) payload.event = value;
                break;
            case "--conversationId":
                if (value) payload.conversationId = value;
                break;
            case "--toolName":
                if (value) payload.toolName = value;
                break;
            case "--toolArgs":
                if (value) {
                    try {
                        payload.toolArgs = JSON.parse(value);
                    } catch {
                        payload.toolArgs = { raw: value };
                    }
                }
                break;
            case "--terminationReason":
                if (value) payload.terminationReason = value;
                break;
            case "--isSubagent":
                if (value === undefined || value === "true" || value === "1") {
                    payload.isSubagent = true;
                } else if (value === "false" || value === "0") {
                    payload.isSubagent = false;
                }
                break;
            case "--cwd":
                if (value) payload.cwd = value;
                break;
        }
    }

    return payload;
}

/**
 * Parses STDIN JSON string from Antigravity lifecycle hooks.
 */
export function parseStdin(stdinData: string): Partial<HookPayload> {
    if (!stdinData || !stdinData.trim()) return {};
    try {
        const data = JSON.parse(stdinData.trim());
        const payload: Partial<HookPayload> = {};

        if (data.event) payload.event = String(data.event);
        if (data.conversationId) payload.conversationId = String(data.conversationId);
        if (data.isSubagent !== undefined) payload.isSubagent = Boolean(data.isSubagent);
        if (data.terminationReason) payload.terminationReason = String(data.terminationReason);

        // toolCall extraction (from Antigravity PreToolUse / PostToolUse hook payload)
        if (data.toolCall) {
            if (data.toolCall.name) payload.toolName = String(data.toolCall.name);
            if (data.toolCall.args && typeof data.toolCall.args === "object") {
                payload.toolArgs = data.toolCall.args;
            }
        }
        if (data.toolName && !payload.toolName) {
            payload.toolName = String(data.toolName);
        }
        if (data.toolArgs && !payload.toolArgs && typeof data.toolArgs === "object") {
            payload.toolArgs = data.toolArgs;
        }

        // CWD extraction (from Antigravity workspacePaths)
        if (Array.isArray(data.workspacePaths) && data.workspacePaths.length > 0) {
            payload.cwd = String(data.workspacePaths[0]);
        } else if (data.cwd) {
            payload.cwd = String(data.cwd);
        }

        return payload;
    } catch {
        return {};
    }
}

/**
 * Resolves the script path and node arguments to launch the background daemon.
 */
export function resolveDaemonScript(env: NodeJS.ProcessEnv = process.env): { execPath: string; args: string[] } {
    if (env.AGY_DAEMON_PATH) {
        return { execPath: process.execPath, args: [env.AGY_DAEMON_PATH] };
    }

    // 1. Check bin/daemon.js (production bundle)
    const binDaemon = path.resolve(__dirname, "../bin/daemon.js");
    if (fs.existsSync(binDaemon)) {
        return { execPath: process.execPath, args: [binDaemon] };
    }

    const altBinDaemon = path.resolve(process.cwd(), "bin/daemon.js");
    if (fs.existsSync(altBinDaemon)) {
        return { execPath: process.execPath, args: [altBinDaemon] };
    }

    // 2. Check src/daemon.ts (development mode)
    const srcDaemon = path.resolve(__dirname, "daemon.ts");
    if (fs.existsSync(srcDaemon)) {
        return { execPath: process.execPath, args: ["--experimental-transform-types", srcDaemon] };
    }

    const altSrcDaemon = path.resolve(process.cwd(), "src/daemon.ts");
    if (fs.existsSync(altSrcDaemon)) {
        return { execPath: process.execPath, args: ["--experimental-transform-types", altSrcDaemon] };
    }

    return { execPath: process.execPath, args: [binDaemon] };
}

/**
 * Spawns the background RPC daemon detached so it runs independently.
 */
export function spawnDaemon(env: NodeJS.ProcessEnv = process.env): child_process.ChildProcess | null {
    try {
        const { execPath, args } = resolveDaemonScript(env);
        const child = child_process.spawn(execPath, args, {
            detached: true,
            stdio: "ignore",
            env: { ...process.env, ...env }
        });
        child.unref();
        return child;
    } catch {
        return null;
    }
}

/**
 * Safely reads STDIN within a tight timeout without blocking.
 */
export function readStdinSafely(timeoutMs: number = 40): Promise<string> {
    if (process.stdin.isTTY) {
        return Promise.resolve("");
    }
    return new Promise((resolve) => {
        let data = "";
        let timer: NodeJS.Timeout | null = null;

        const onData = (chunk: Buffer | string) => {
            data += chunk.toString();
        };

        const cleanup = () => {
            if (timer) clearTimeout(timer);
            process.stdin.removeListener("data", onData);
            process.stdin.removeListener("end", onEnd);
            process.stdin.removeListener("error", onEnd);
            process.stdin.pause();
        };

        const onEnd = () => {
            cleanup();
            resolve(data);
        };

        process.stdin.on("data", onData);
        process.stdin.on("end", onEnd);
        process.stdin.on("error", onEnd);

        timer = setTimeout(() => {
            cleanup();
            resolve(data);
        }, timeoutMs);

        process.stdin.resume();
    });
}

/**
 * Executes the fast CLI dispatcher:
 * - Parses CLI arguments and STDIN input
 * - Sends payload to IPC server with 50ms timeout
 * - Automatically spawns background daemon if unreachable or on SessionStart
 * - Returns hook decision response
 */
export async function runDispatch(
    argv: string[],
    env: NodeJS.ProcessEnv = process.env,
    stdinInput?: string
): Promise<{ decision?: string } | Record<string, unknown>> {
    const stdinPayload = stdinInput ? parseStdin(stdinInput) : {};
    const cliPayload = parseCliArgs(argv);

    // Merge: CLI arguments override STDIN
    const event = cliPayload.event || stdinPayload.event || "PreInvocation";
    const payload: HookPayload = {
        event,
        conversationId: cliPayload.conversationId || stdinPayload.conversationId,
        isSubagent: cliPayload.isSubagent !== undefined ? cliPayload.isSubagent : stdinPayload.isSubagent,
        toolName: cliPayload.toolName || stdinPayload.toolName,
        toolArgs: cliPayload.toolArgs || stdinPayload.toolArgs,
        terminationReason: cliPayload.terminationReason || stdinPayload.terminationReason,
        cwd: cliPayload.cwd || stdinPayload.cwd || process.cwd()
    };

    const targetSocket = env.AGY_IPC_PATH || env.AGY_DISCORD_RPC_PIPE || getIpcAddress();

    // Fast 50ms IPC delivery to avoid stalling Antigravity
    const delivered = await sendIpcMessage(payload, 50, targetSocket);

    // If unreachable (or on SessionStart if daemon is not running), auto-spawn background daemon
    if (!delivered) {
        const autoSpawnAllowed = env.AGY_AUTO_SPAWN !== "false" && process.env.AGY_AUTO_SPAWN !== "false";
        if (autoSpawnAllowed) {
            spawnDaemon(env);
            // Brief wait for daemon socket initialization to deliver the initial event
            await new Promise((r) => setTimeout(r, 200));
            await sendIpcMessage(payload, 200, targetSocket);
        }
    }

    // Standard hook response contract
    if (event === "PreToolUse") {
        return { decision: "allow" };
    }

    return {};
}

// Standalone CLI execution entry point
const isDirectRun = Boolean(
    process.argv[1] &&
    (process.argv[1].endsWith("dispatch.js") || process.argv[1].endsWith("dispatch.ts")) &&
    !process.argv[1].includes("test")
);

if (isDirectRun) {
    readStdinSafely()
        .then(async (stdinData) => {
            const result = await runDispatch(process.argv.slice(2), process.env, stdinData);
            process.stdout.write(JSON.stringify(result ?? {}) + "\n", () => {
                process.exit(0);
            });
        })
        .catch(() => {
            process.stdout.write("{}\n", () => {
                process.exit(0);
            });
        });
}

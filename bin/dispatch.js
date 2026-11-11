#!/usr/bin/env node


// src/dispatch.ts
import child_process from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// src/ipc.ts
import net from "node:net";
function getIpcAddress() {
  if (process.env.AGY_IPC_PATH) {
    return process.env.AGY_IPC_PATH;
  }
  if (process.env.AGY_DISCORD_RPC_PIPE) {
    return process.env.AGY_DISCORD_RPC_PIPE;
  }
  return process.platform === "win32" ? "\\\\.\\pipe\\agy-discord-rpc" : "/tmp/agy-discord-rpc.sock";
}
function sendIpcMessage(payload, timeoutMs = 1e3, socketPath) {
  return new Promise((resolve) => {
    const targetPath = socketPath || getIpcAddress();
    let settled = false;
    let client;
    try {
      client = net.createConnection(targetPath);
    } catch {
      resolve(false);
      return;
    }
    const finish = (result) => {
      if (!settled) {
        settled = true;
        try {
          client.destroy();
        } catch {
        }
        resolve(result);
      }
    };
    client.setTimeout(timeoutMs);
    client.on("connect", () => {
      const data = JSON.stringify(payload) + "\n";
      client.write(data, "utf-8");
    });
    client.on("data", () => {
      finish(true);
    });
    client.on("end", () => {
      finish(true);
    });
    client.on("timeout", () => {
      finish(false);
    });
    client.on("error", () => {
      finish(false);
    });
  });
}

// src/types.ts
function encodeInitialPayload(payload) {
  return Buffer.from(JSON.stringify(payload), "utf-8").toString("base64");
}

// src/dispatch.ts
var __filename = fileURLToPath(import.meta.url);
var __dirname = path.dirname(__filename);
function parseCliArgs(argv) {
  const payload = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    let key = arg;
    let value = void 0;
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
        if (value === void 0 || value === "true" || value === "1") {
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
function parseStdin(stdinData) {
  if (!stdinData || !stdinData.trim()) return {};
  try {
    const data = JSON.parse(stdinData.trim());
    const payload = {};
    if (data.event) payload.event = String(data.event);
    if (data.conversationId) payload.conversationId = String(data.conversationId);
    if (data.isSubagent !== void 0) payload.isSubagent = Boolean(data.isSubagent);
    if (data.terminationReason) payload.terminationReason = String(data.terminationReason);
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
function resolveDaemonScript(env = process.env) {
  if (env.AGY_DAEMON_PATH) {
    return { execPath: process.execPath, args: [env.AGY_DAEMON_PATH] };
  }
  const binDaemon = path.resolve(__dirname, "../bin/daemon.js");
  if (fs.existsSync(binDaemon)) {
    return { execPath: process.execPath, args: [binDaemon] };
  }
  const altBinDaemon = path.resolve(process.cwd(), "bin/daemon.js");
  if (fs.existsSync(altBinDaemon)) {
    return { execPath: process.execPath, args: [altBinDaemon] };
  }
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
function spawnDaemon(env = process.env, initialPayload) {
  try {
    const { execPath, args } = resolveDaemonScript(env);
    const childEnv = {
      ...process.env,
      ...env,
      ...initialPayload ? { AGY_INITIAL_PAYLOAD: encodeInitialPayload(initialPayload) } : {}
    };
    const child = child_process.spawn(execPath, args, {
      detached: true,
      stdio: "ignore",
      env: childEnv
    });
    child.unref();
    return child;
  } catch {
    return null;
  }
}
function readStdinSafely(timeoutMs = 40) {
  if (process.stdin.isTTY) {
    return Promise.resolve("");
  }
  return new Promise((resolve) => {
    let data = "";
    let timer = null;
    const onData = (chunk) => {
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
async function runDispatch(argv, env = process.env, stdinInput) {
  const stdinPayload = stdinInput ? parseStdin(stdinInput) : {};
  const cliPayload = parseCliArgs(argv);
  const event = cliPayload.event || stdinPayload.event || "PreInvocation";
  const payload = {
    event,
    conversationId: cliPayload.conversationId || stdinPayload.conversationId,
    isSubagent: cliPayload.isSubagent !== void 0 ? cliPayload.isSubagent : stdinPayload.isSubagent,
    toolName: cliPayload.toolName || stdinPayload.toolName,
    toolArgs: cliPayload.toolArgs || stdinPayload.toolArgs,
    terminationReason: cliPayload.terminationReason || stdinPayload.terminationReason,
    cwd: cliPayload.cwd || stdinPayload.cwd || process.cwd()
  };
  const targetSocket = env.AGY_IPC_PATH || env.AGY_DISCORD_RPC_PIPE || getIpcAddress();
  const delivered = await sendIpcMessage(payload, 50, targetSocket);
  if (!delivered) {
    const autoSpawnAllowed = env.AGY_AUTO_SPAWN !== "false" && process.env.AGY_AUTO_SPAWN !== "false";
    if (autoSpawnAllowed) {
      spawnDaemon(env, payload);
    }
  }
  if (event === "PreToolUse") {
    return { decision: "allow" };
  }
  return {};
}
var isDirectRun = Boolean(
  process.argv[1] && (process.argv[1].endsWith("dispatch.js") || process.argv[1].endsWith("dispatch.ts")) && !process.argv[1].includes("test")
);
if (isDirectRun) {
  readStdinSafely().then(async (stdinData) => {
    const result = await runDispatch(process.argv.slice(2), process.env, stdinData);
    process.stdout.write(JSON.stringify(result ?? {}) + "\n", () => {
      process.exit(0);
    });
  }).catch(() => {
    process.stdout.write("{}\n", () => {
      process.exit(0);
    });
  });
}
export {
  parseCliArgs,
  parseStdin,
  readStdinSafely,
  resolveDaemonScript,
  runDispatch,
  spawnDaemon
};

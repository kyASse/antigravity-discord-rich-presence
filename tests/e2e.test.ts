import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

describe("E2E Integration & Build Verification", () => {
    it("ensures build script generates standalone bin/daemon.js and bin/dispatch.js", () => {
        execFileSync("node", ["scripts/build.mjs"], { stdio: "pipe" });
        const daemonPath = path.resolve("bin/daemon.js");
        const dispatchPath = path.resolve("bin/dispatch.js");
        assert.ok(fs.existsSync(daemonPath), "bin/daemon.js should exist");
        assert.ok(fs.existsSync(dispatchPath), "bin/dispatch.js should exist");

        const daemonContent = fs.readFileSync(daemonPath, "utf-8");
        const dispatchContent = fs.readFileSync(dispatchPath, "utf-8");
        assert.ok(daemonContent.startsWith("#!/usr/bin/env node"), "bin/daemon.js must include shebang");
        assert.ok(dispatchContent.startsWith("#!/usr/bin/env node"), "bin/dispatch.js must include shebang");
    });

    it("validates plugin.json and hooks.json manifests", () => {
        const plugin = JSON.parse(fs.readFileSync("plugin.json", "utf-8"));
        const hooks = JSON.parse(fs.readFileSync("hooks.json", "utf-8"));
        assert.equal(plugin.name, "antigravity-discord-presence");
        assert.ok(hooks["discord-presence"] !== undefined, "hooks.json must contain discord-presence group");
    });

    it("verifies bin/dispatch.js responds correctly as a hook command", () => {
        const output = execFileSync("node", ["bin/dispatch.js", "--event", "PreToolUse"], {
            encoding: "utf-8",
            env: { ...process.env, AGY_AUTO_SPAWN: "false" }
        });
        const parsed = JSON.parse(output.trim());
        assert.equal(parsed.decision, "allow");
    });

    it("validates package.json contains required build and prepack scripts", () => {
        const pkg = JSON.parse(fs.readFileSync("package.json", "utf-8"));
        assert.equal(pkg.scripts?.build, "node scripts/build.mjs");
        assert.equal(pkg.scripts?.prepack, "npm run build");
    });
});

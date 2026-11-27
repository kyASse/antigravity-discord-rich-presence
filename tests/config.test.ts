import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    getGlobalConfigPath,
    getWorkspaceConfigPath,
    loadConfigFile,
    parseConfigOverridesFromEnv,
    toWorkspaceOverrides,
    loadDaemonConfig,
    resolveWorkspaceConfig
} from "../src/config";
import { DEFAULT_CONFIG, DEFAULT_SUBAGENT_TTL_MS } from "../src/types";

describe("Persistent Config Loader", () => {
    it("resolves canonical global and workspace config file paths", () => {
        assert.equal(
            getGlobalConfigPath("/home/alice"),
            path.join("/home/alice", ".gemini", "antigravity-discord-rpc.json")
        );
        assert.equal(
            getWorkspaceConfigPath("/projects/my-app"),
            path.join(path.resolve("/projects/my-app"), ".agents", "discord-rpc.json")
        );
    });

    it("returns empty overrides safely for missing, non-object, or malformed JSON files", () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "config-loader-test-"));
        try {
            assert.deepEqual(loadConfigFile(path.join(tmpDir, "missing.json")), {});
            assert.deepEqual(loadConfigFile(tmpDir), {});

            const malformedPath = path.join(tmpDir, "malformed.json");
            fs.writeFileSync(malformedPath, "{ invalid json", "utf-8");
            assert.deepEqual(loadConfigFile(malformedPath), {});

            const arrayPath = path.join(tmpDir, "array.json");
            fs.writeFileSync(arrayPath, "[1, 2, 3]", "utf-8");
            assert.deepEqual(loadConfigFile(arrayPath), {});

            const nullPath = path.join(tmpDir, "null.json");
            fs.writeFileSync(nullPath, "null", "utf-8");
            assert.deepEqual(loadConfigFile(nullPath), {});

            const bomPath = path.join(tmpDir, "bom.json");
            fs.writeFileSync(bomPath, "\uFEFF" + JSON.stringify({ privacyProfile: "stealth" }), "utf-8");
            assert.deepEqual(loadConfigFile(bomPath), { privacyProfile: "stealth", privacyMode: true });
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it("validates individual JSON fields without discarding valid sibling fields", () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "config-partial-test-"));
        try {
            const partialPath = path.join(tmpDir, "partial.json");
            fs.writeFileSync(
                partialPath,
                JSON.stringify({
                    clientId: "   ",
                    privacyProfile: "invalid",
                    idleTimeoutSeconds: -10,
                    showRepoButton: false,
                    watchdogTimeoutSeconds: 0,
                    subagentTtlSeconds: "120"
                }),
                "utf-8"
            );

            assert.deepEqual(loadConfigFile(partialPath), {
                showRepoButton: false
            });
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it("enforces Env > Workspace > Global > DEFAULT_CONFIG precedence and daemon vs workspace scope", () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "config-precedence-test-"));
        try {
            const globalPath = path.join(tmpDir, "global.json");
            const workspaceDir = path.join(tmpDir, "workspace");
            const workspaceConfigPath = getWorkspaceConfigPath(workspaceDir);
            fs.mkdirSync(path.dirname(workspaceConfigPath), { recursive: true });

            fs.writeFileSync(
                globalPath,
                JSON.stringify({
                    clientId: "111222333",
                    privacyProfile: "stealth",
                    showRepoButton: false,
                    idleTimeoutSeconds: 200,
                    watchdogTimeoutSeconds: 900,
                    subagentTtlSeconds: 120
                }),
                "utf-8"
            );

            fs.writeFileSync(
                workspaceConfigPath,
                JSON.stringify({
                    clientId: "999-ignored-at-workspace",
                    privacyProfile: "showcase",
                    idleTimeoutSeconds: 45,
                    watchdogTimeoutSeconds: 5,
                    subagentTtlSeconds: 5
                }),
                "utf-8"
            );

            // Unset or invalid env vars must not clobber JSON values
            const invalidEnv = {
                AGY_DISCORD_PRIVACY_PROFILE: "bogus",
                AGY_DISCORD_IDLE_TIMEOUT: "abc",
                AGY_DISCORD_WATCHDOG_TIMEOUT: "-5",
                AGY_DISCORD_SUBAGENT_TTL: "invalid"
            };
            const daemonLoaded = loadDaemonConfig({ env: invalidEnv, globalConfigPath: globalPath });
            assert.equal(daemonLoaded.config.clientId, "111222333");
            assert.equal(daemonLoaded.config.privacyProfile, "stealth");
            assert.equal(daemonLoaded.config.privacyMode, true);
            assert.equal(daemonLoaded.config.showRepoButton, false);
            assert.equal(daemonLoaded.config.idleTimeoutSeconds, 200);
            assert.equal(daemonLoaded.watchdogMs, 900_000);
            assert.equal(daemonLoaded.subagentTtlMs, 120_000);

            const wsResolved = resolveWorkspaceConfig({
                baseConfig: { ...DEFAULT_CONFIG, ...daemonLoaded.globalConfig },
                cwd: workspaceDir,
                envOverrides: daemonLoaded.envOverrides
            });
            assert.equal(wsResolved.clientId, "111222333");
            assert.equal(wsResolved.privacyProfile, "showcase");
            assert.equal(wsResolved.privacyMode, false);
            assert.equal(wsResolved.showRepoButton, false);
            assert.equal(wsResolved.idleTimeoutSeconds, 45);

            // Explicit env overrides workspace showcase back to stealth via legacy AGY_DISCORD_PRIVACY_MODE
            const envOverridesLegacy = toWorkspaceOverrides(
                parseConfigOverridesFromEnv({ AGY_DISCORD_PRIVACY_MODE: "true" })
            );
            const wsWithLegacyEnv = resolveWorkspaceConfig({
                baseConfig: { ...DEFAULT_CONFIG, ...daemonLoaded.globalConfig },
                cwd: workspaceDir,
                envOverrides: envOverridesLegacy
            });
            assert.equal(wsWithLegacyEnv.privacyProfile, "stealth");
            assert.equal(wsWithLegacyEnv.privacyMode, true);

            // Explicit AGY_DISCORD_PRIVACY_PROFILE=showcase overrides global stealth & legacy env
            const daemonWithEnvProfile = loadDaemonConfig({
                env: {
                    AGY_DISCORD_PRIVACY_PROFILE: "showcase",
                    AGY_DISCORD_WATCHDOG_TIMEOUT: "300",
                    AGY_DISCORD_SUBAGENT_TTL: "30"
                },
                globalConfigPath: globalPath
            });
            assert.equal(daemonWithEnvProfile.config.privacyProfile, "showcase");
            assert.equal(daemonWithEnvProfile.config.privacyMode, false);
            assert.equal(daemonWithEnvProfile.watchdogMs, 300_000);
            assert.equal(daemonWithEnvProfile.subagentTtlMs, 30_000);

            // Workspace privacyMode: false overrides global stealth to balanced
            fs.writeFileSync(workspaceConfigPath, JSON.stringify({ privacyMode: false }), "utf-8");
            const wsResetFromGlobalStealth = resolveWorkspaceConfig({
                baseConfig: { ...DEFAULT_CONFIG, ...daemonLoaded.globalConfig },
                cwd: workspaceDir,
                envOverrides: {}
            });
            assert.equal(wsResetFromGlobalStealth.privacyProfile, "balanced");
            assert.equal(wsResetFromGlobalStealth.privacyMode, false);

            // Missing global config falls back cleanly to defaults
            const missingDaemon = loadDaemonConfig({
                env: {},
                globalConfigPath: path.join(tmpDir, "does-not-exist.json")
            });
            assert.deepEqual(missingDaemon.config, DEFAULT_CONFIG);
            assert.equal(missingDaemon.watchdogMs, 1_800_000);
            assert.equal(missingDaemon.subagentTtlMs, DEFAULT_SUBAGENT_TTL_MS);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

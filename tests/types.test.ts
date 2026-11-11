// tests/types.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    PresenceStatus,
    DEFAULT_CONFIG,
    loadConfigFromEnv,
    loadWatchdogTimeoutMsFromEnv,
    encodeInitialPayload,
    decodeInitialPayload
} from "../src/types";

describe("Types & Defaults", () => {
    it("exports valid PresenceStatus enum and DEFAULT_CONFIG", () => {
        assert.equal(PresenceStatus.THINKING, "THINKING");
        assert.equal(PresenceStatus.EXECUTING_TOOL, "EXECUTING_TOOL");
        assert.equal(PresenceStatus.WAITING_REVIEW, "WAITING_REVIEW");
        assert.equal(PresenceStatus.IDLE, "IDLE");
        assert.equal(PresenceStatus.STOPPED, "STOPPED");
        assert.equal(DEFAULT_CONFIG.clientId, "1441771215290372156");
        assert.equal(DEFAULT_CONFIG.idleTimeoutSeconds, 300);
        assert.equal(DEFAULT_CONFIG.privacyMode, false);
    });

    it("loads PluginConfig and watchdog timeout from env vars with safe fallbacks", () => {
        assert.deepEqual(loadConfigFromEnv({}), DEFAULT_CONFIG);

        const custom = loadConfigFromEnv({
            AGY_DISCORD_CLIENT_ID: " 999888777 ",
            AGY_DISCORD_PRIVACY_MODE: "true",
            AGY_DISCORD_IDLE_TIMEOUT: "120",
            AGY_DISCORD_SHOW_REPO_BUTTON: "false"
        });
        assert.deepEqual(custom, {
            clientId: "999888777",
            privacyMode: true,
            idleTimeoutSeconds: 120,
            showRepoButton: false
        });

        const invalid = loadConfigFromEnv({
            AGY_DISCORD_CLIENT_ID: "   ",
            AGY_DISCORD_PRIVACY_MODE: "maybe",
            AGY_DISCORD_IDLE_TIMEOUT: "-5",
            AGY_DISCORD_SHOW_REPO_BUTTON: "0"
        });
        assert.equal(invalid.clientId, DEFAULT_CONFIG.clientId);
        assert.equal(invalid.privacyMode, false);
        assert.equal(invalid.idleTimeoutSeconds, 300);
        assert.equal(invalid.showRepoButton, false);

        assert.equal(loadWatchdogTimeoutMsFromEnv({}), 1_800_000);
        assert.equal(loadWatchdogTimeoutMsFromEnv({ AGY_DISCORD_WATCHDOG_TIMEOUT: "90" }), 90_000);
        assert.equal(loadWatchdogTimeoutMsFromEnv({ AGY_DISCORD_WATCHDOG_TIMEOUT: "abc" }), 1_800_000);

        // Verify default process.env usage
        const defaultFromProcessEnv = loadConfigFromEnv();
        assert.ok(defaultFromProcessEnv.clientId);
        assert.equal(typeof defaultFromProcessEnv.idleTimeoutSeconds, "number");
        assert.equal(typeof loadWatchdogTimeoutMsFromEnv(), "number");
    });

    it("encodes and decodes AGY_INITIAL_PAYLOAD defensively", () => {
        const encoded = encodeInitialPayload({ event: "SessionStart", conversationId: "c-init" });
        assert.deepEqual(decodeInitialPayload(encoded), { event: "SessionStart", conversationId: "c-init" });
        assert.equal(decodeInitialPayload(undefined), null);
        assert.equal(decodeInitialPayload("not-valid-base64-json!!!"), null);
        assert.equal(decodeInitialPayload(Buffer.from(JSON.stringify({ missingEvent: true })).toString("base64")), null);
        assert.equal(decodeInitialPayload(Buffer.from(JSON.stringify("not-an-object")).toString("base64")), null);
    });
});


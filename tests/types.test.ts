// tests/types.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PresenceStatus, DEFAULT_CONFIG, resolveConfig } from "../src/types";

describe("Types & Defaults", () => {
    it("exports valid PresenceStatus enum and DEFAULT_CONFIG", () => {
        assert.equal(PresenceStatus.THINKING, "THINKING");
        assert.equal(PresenceStatus.EXECUTING_TOOL, "EXECUTING_TOOL");
        assert.equal(PresenceStatus.WAITING_REVIEW, "WAITING_REVIEW");
        assert.equal(PresenceStatus.IDLE, "IDLE");
        assert.equal(PresenceStatus.STOPPED, "STOPPED");
        assert.equal(DEFAULT_CONFIG.clientId, "1568484776703299726");
        assert.equal(DEFAULT_CONFIG.idleTimeoutSeconds, 300);
        assert.equal(DEFAULT_CONFIG.privacyMode, false);
    });

    it("resolves config overrides from environment variables", () => {
        const mockEnv = {
            AGY_DISCORD_CLIENT_ID: "999999999999999999",
            AGY_DISCORD_PRIVACY_MODE: "true",
            AGY_DISCORD_IDLE_TIMEOUT: "600",
            AGY_DISCORD_SHOW_REPO_BUTTON: "false"
        };
        const resolved = resolveConfig(undefined, mockEnv as any);
        assert.equal(resolved.clientId, "999999999999999999");
        assert.equal(resolved.privacyMode, true);
        assert.equal(resolved.idleTimeoutSeconds, 600);
        assert.equal(resolved.showRepoButton, false);
    });
});

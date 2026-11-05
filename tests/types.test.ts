// tests/types.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PresenceStatus, DEFAULT_CONFIG } from "../src/types";

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
});

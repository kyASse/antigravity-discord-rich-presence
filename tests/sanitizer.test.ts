import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeGitUrl, sanitizeCommand, mapToolToAction } from "../src/sanitizer";

describe("Sanitizer", () => {
    it("strips credentials from HTTP/HTTPS/SSH git remote urls", () => {
        assert.equal(
            sanitizeGitUrl("https://x-access-token:ghp_123456789@github.com/owner/repo.git"),
            "https://github.com/owner/repo"
        );
        assert.equal(
            sanitizeGitUrl("git@github.com:owner/repo.git"),
            "https://github.com/owner/repo"
        );
        assert.equal(sanitizeGitUrl("not-a-url"), undefined);
        assert.equal(sanitizeGitUrl(""), undefined);
        assert.equal(
            sanitizeGitUrl("ssh://git@github.com/owner/repo.git"),
            "https://github.com/owner/repo"
        );
    });

    it("sanitizes commands and masks passwords in privacy mode", () => {
        assert.equal(sanitizeCommand("npm test -- --grep auth"), "npm test -- --grep auth");
        assert.equal(sanitizeCommand("git commit -m 'secret password=123'", true), "git");
        assert.equal(sanitizeCommand("export TOKEN=abcdef && run", false), "export TOKEN=*** && run");
        assert.equal(sanitizeCommand("export PASSWORD=supersecret && run"), "export PASSWORD=*** && run");
        assert.equal(sanitizeCommand(""), "");

        // Issue 1: CLI flag regex with whitespace and = syntax
        assert.equal(sanitizeCommand("tool --token ghp_secret123"), "tool --token ***");
        assert.equal(sanitizeCommand("tool --password='my secret'"), "tool --password=***");
        assert.equal(sanitizeCommand("cmd --secret=xyz --api-key 123"), "cmd --secret=*** --api-key ***");

        // Issue 3: Quoted secrets with spaces
        assert.equal(sanitizeCommand('export PASSWORD="my super secret" && run'), "export PASSWORD=*** && run");
        assert.equal(sanitizeCommand("export SECRET='another secret phrase' && run"), "export SECRET=*** && run");

        // Issue 4: Inline URLs with token-only auth
        assert.equal(
            sanitizeCommand("git clone https://ghp_token123@github.com/org/repo.git"),
            "git clone https://github.com/org/repo.git"
        );
        assert.equal(
            sanitizeCommand("git clone https://user:pass@github.com/org/repo.git"),
            "git clone https://github.com/org/repo.git"
        );
    });

    it("maps tools into human-friendly actions", () => {
        assert.equal(mapToolToAction("read_file", { Path: "/project/src/index.ts" }), "Reading index.ts");
        assert.equal(mapToolToAction("write_file", { Path: "/project/src/app.ts" }), "Editing app.ts");
        assert.equal(mapToolToAction("edit_file", { Path: "C:\\project\\src\\config.ts" }), "Editing config.ts");
        assert.equal(mapToolToAction("run_command", { toolSummary: "Unit test execution" }), "Running: Unit test execution");
        assert.equal(mapToolToAction("run_command", { CommandLine: "npm test" }), "Running: npm test");

        // Issue 2: mapToolToAction ignores toolSummary when privacyMode is true
        assert.equal(
            mapToolToAction("run_command", { toolSummary: "Private Task", CommandLine: "git commit -m 'secret'" }, true),
            "Running: git"
        );
        assert.equal(
            mapToolToAction("run_command", { toolSummary: "Private Task" }, true),
            "Running command"
        );

        assert.equal(mapToolToAction("invoke_subagent", {}), "Dispatching Subagent");
        assert.equal(mapToolToAction("search_web", {}), "Searching web documentation");
        assert.equal(mapToolToAction("unknown_tool", {}), "Executing unknown_tool");
    });
});

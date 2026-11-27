import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    sanitizeGitUrl,
    sanitizeCommand,
    isSensitiveFilename,
    mapToolToAction,
    truncateRpcText,
    validateRpcButtonUrl
} from "../src/sanitizer";

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
        assert.equal(
            sanitizeGitUrl("https://user:pass@gitlab.corp.net:8080/group/project.git"),
            "https://gitlab.corp.net:8080/group/project"
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

    it("truncates RPC fields cleanly by Unicode codepoints and enforces >= 2 chars", () => {
        assert.equal(truncateRpcText("a", 128), undefined);
        assert.equal(truncateRpcText("  ", 128), undefined);
        assert.equal(truncateRpcText("ab", 128), "ab");
        assert.equal(truncateRpcText("abc", 1), undefined);
        assert.equal(truncateRpcText("abc", 0), undefined);
        assert.equal(truncateRpcText("abc", -5), undefined);
        assert.equal(truncateRpcText("abc", Number.NaN), undefined);
        assert.equal(truncateRpcText("abcd", 2), "ab");

        const longEmoji = "🚀".repeat(140);
        const truncated = truncateRpcText(longEmoji, 128)!;
        assert.equal(Array.from(truncated).length, 128);
        assert.ok(truncated.endsWith("..."));
        assert.ok(!truncated.includes("\uFFFD"));

        const mixed = "a".repeat(126) + "🚀".repeat(3);
        const truncatedMixed = truncateRpcText(mixed, 128)!;
        assert.equal(Array.from(truncatedMixed).length, 128);
        assert.ok(truncatedMixed.endsWith("..."));
        assert.ok(!truncatedMixed.includes("\uFFFD"));
    });

    it("validates RPC button URL scheme and 512-char limit", () => {
        assert.equal(validateRpcButtonUrl("https://github.com/org/repo"), "https://github.com/org/repo");
        assert.equal(validateRpcButtonUrl("ftp://example.com/repo"), undefined);
        assert.equal(validateRpcButtonUrl("https://github.com/" + "a".repeat(500)), undefined);
    });

    it("sanitizes toolSummary secrets when privacyMode is false", () => {
        assert.equal(
            mapToolToAction("run_command", { toolSummary: "Deploy using TOKEN=ghp_1234567890abcdef" }, false),
            "Running: Deploy using TOKEN=***"
        );
    });

    it("detects sensitive filenames while allowing normal source files", () => {
        const sensitive = [
            ".env",
            ".env.local",
            "/app/.env.production",
            "C:\\keys\\server.pem",
            "private.key",
            "cert.p12",
            "bundle.pfx",
            "keystore.jks",
            "app.keystore",
            "putty.ppk",
            "/home/user/.ssh/id_rsa",
            "id_ed25519",
            "id_ecdsa",
            "id_dsa",
            ".npmrc",
            ".pypirc",
            ".netrc",
            ".htpasswd",
            ".pgpass",
            "secrets.json",
            "client_secret.yaml",
            "credentials.json",
            "aws-credentials.toml",
            "service-account-prod.json"
        ];
        for (const file of sensitive) {
            assert.equal(isSensitiveFilename(file), true, `Expected sensitive: ${file}`);
        }

        const safe = [
            "src/index.ts",
            "src/config.ts",
            "src/tokenizer.ts",
            "src/auth.ts",
            "/home/user/.ssh/id_rsa.pub",
            ""
        ];
        for (const file of safe) {
            assert.equal(isSensitiveFilename(file), false, `Expected non-sensitive: ${file}`);
        }
    });

    it("applies balanced vs showcase vs stealth rules in mapToolToAction", () => {
        assert.equal(mapToolToAction("read_file", { Path: "/app/.env.production" }, "balanced"), "Reading sensitive file");
        assert.equal(mapToolToAction("edit_file", { Path: "C:\\repo\\secrets.json" }, "balanced"), "Editing sensitive file");
        assert.equal(mapToolToAction("read_file", { Path: "src/index.ts" }, "balanced"), "Reading index.ts");
        assert.equal(
            mapToolToAction("run_command", { toolSummary: "Deploy app", CommandLine: "npm run deploy --token=abc" }, "balanced"),
            "Running: npm"
        );
        assert.equal(mapToolToAction("run_command", { toolSummary: "Deploy app" }, "balanced"), "Running command");

        assert.equal(mapToolToAction("read_file", { Path: "/app/.env" }, "showcase"), "Reading sensitive file");
        assert.equal(mapToolToAction("write_file", { Path: "/app/id_rsa" }, "showcase"), "Editing sensitive file");
        assert.equal(
            mapToolToAction("run_command", { toolSummary: "Deploy using TOKEN=ghp_123456" }, "showcase"),
            "Running: Deploy using TOKEN=***"
        );
        assert.equal(
            mapToolToAction("run_command", { CommandLine: "npm test -- --grep auth" }, "showcase"),
            "Running: npm test -- --grep auth"
        );

        assert.equal(
            mapToolToAction("run_command", { toolSummary: "Secret", CommandLine: "git status" }, "stealth"),
            "Running: git"
        );
    });
});

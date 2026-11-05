import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getGitInfo } from "../src/git";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";

describe("Git Info Reader", () => {
    it("extracts git metadata for the current workspace", async () => {
        const info = await getGitInfo(process.cwd());
        assert.ok(info.branch !== undefined || info.repoName !== undefined);
        if (info.remoteUrl) {
            assert.ok(!info.remoteUrl.includes("@"));
        }
    });

    it("returns empty object gracefully for non-git directories", async () => {
        const tempRoot = path.parse(process.cwd()).root;
        const info = await getGitInfo(tempRoot);
        assert.deepEqual(info, {});
    });

    it("extracts and sanitizes metadata from a repo with remote credentials", async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-info-test-"));
        try {
            execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
            execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tmpDir, stdio: "ignore" });
            execFileSync("git", ["config", "user.name", "Test User"], { cwd: tmpDir, stdio: "ignore" });
            execFileSync(
                "git",
                ["config", "remote.origin.url", "https://oauth2:ghp_secretToken12345@github.com/my-org/my-project.git"],
                { cwd: tmpDir, stdio: "ignore" }
            );
            fs.writeFileSync(path.join(tmpDir, "README.md"), "# Test");
            execFileSync("git", ["add", "."], { cwd: tmpDir, stdio: "ignore" });
            execFileSync("git", ["commit", "-m", "initial commit"], { cwd: tmpDir, stdio: "ignore" });

            const info = await getGitInfo(tmpDir);
            assert.ok(info.branch);
            assert.equal(info.repoName, "my-project");
            assert.equal(info.remoteUrl, "https://github.com/my-org/my-project");
            assert.ok(!info.remoteUrl.includes("ghp_secretToken12345"));
            assert.ok(!info.remoteUrl.includes("@"));
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it("returns empty object gracefully for invalid, empty, or non-existent paths", async () => {
        assert.deepEqual(await getGitInfo(""), {});
        // @ts-expect-error testing invalid type
        assert.deepEqual(await getGitInfo(null), {});
        // @ts-expect-error testing invalid type
        assert.deepEqual(await getGitInfo(undefined), {});
        assert.deepEqual(await getGitInfo(path.join(os.tmpdir(), "non-existent-dir-123456789")), {});
    });
});

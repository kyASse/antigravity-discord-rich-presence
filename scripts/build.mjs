import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";

const binDir = path.resolve("bin");
if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir, { recursive: true });
}

const commonOptions = {
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    sourcemap: false,
    banner: {
        js: "#!/usr/bin/env node\n"
    }
};

try {
    await Promise.all([
        esbuild.build({
            ...commonOptions,
            entryPoints: ["src/daemon.ts"],
            outfile: "bin/daemon.js"
        }),
        esbuild.build({
            ...commonOptions,
            entryPoints: ["src/dispatch.ts"],
            outfile: "bin/dispatch.js"
        })
    ]);
    console.log("Successfully built bin/daemon.js and bin/dispatch.js");
} catch (error) {
    console.error("Build failed:", error);
    process.exit(1);
}

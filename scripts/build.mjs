// Builds the package twice from one source: ESM (dist/esm) for bundlers and `import`, CommonJS
// (dist/cjs) for `require`. Each output folder gets a package.json naming its module format, so
// Node reads the .js files correctly whatever the root package says.
import { execFileSync } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"

const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc")
const builds = [
    { out: "dist/esm", type: "module", args: ["--module", "ESNext", "--moduleResolution", "Bundler"] },
    { out: "dist/cjs", type: "commonjs", args: ["--module", "CommonJS", "--moduleResolution", "Node10"] },
]

rmSync("dist", { recursive: true, force: true })
for (const build of builds) {
    execFileSync(process.execPath, [tsc, "-p", "tsconfig.build.json", "--outDir", build.out, ...build.args], {
        stdio: "inherit",
    })
    mkdirSync(build.out, { recursive: true })
    writeFileSync(`${build.out}/package.json`, JSON.stringify({ type: build.type }) + "\n")
}

// Bundles the extension and the relay it ships. `--production` minifies and drops source maps.

import * as fs from "node:fs"
import * as esbuild from "esbuild"

const production = process.argv.includes("--production")
if (production) {
  fs.rmSync("dist", { recursive: true, force: true })
  // The package needs its license next to it; the source of truth is the repository's.
  fs.copyFileSync("../../LICENSE", "LICENSE")
}

const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  minify: production,
  sourcemap: !production,
  logLevel: "warning",
  // jsonc-parser's `main` is a UMD build whose requires esbuild can't follow; its ES module build bundles.
  mainFields: ["module", "main"],
}

await esbuild.build({ ...common, entryPoints: ["src/extension.ts"], external: ["vscode"], outfile: "dist/extension.js" })
// The relay tells agents the extension's version.
const { version } = JSON.parse(fs.readFileSync("package.json", "utf8"))
await esbuild.build({
  ...common,
  entryPoints: ["../relay/src/main.ts"],
  loader: { ".md": "text" },
  define: { AI_PAIR_VERSION: JSON.stringify(version) },
  outfile: "dist/relay.js",
})

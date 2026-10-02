// Bundles the host into one file the IntelliJ plugin ships and runs with Node. `--production` minifies.

import * as esbuild from "esbuild"

const production = process.argv.includes("--production")

await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  minify: production,
  sourcemap: !production,
  logLevel: "warning",
  outfile: "dist/intellij-host.cjs",
})

// The relay (pair-mcp), shipped with the plugin for agents to launch.
await esbuild.build({
  entryPoints: ["../relay/src/main.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  minify: production,
  sourcemap: !production,
  logLevel: "warning",
  loader: { ".md": "text" },
  outfile: "dist/relay.cjs",
})

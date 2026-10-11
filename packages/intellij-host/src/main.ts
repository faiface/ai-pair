// The IntelliJ plugin runs this with Node and talks to it over stdio; see wire.ts.

import { runHost } from "./host"

runHost(process.stdin, process.stdout).then(
  () => process.exit(0),
  (e: unknown) => {
    console.error(e)
    process.exit(1)
  },
)

// The panel's page is a template literal holding a script: an escape lost in the template (a `\b`
// in a regex, say) only shows as a panel that stays blank. Parse the script as the webview would.

import { expect, it } from "vitest"
import { panelHtml, SPEEDS } from "../src/panelHtml"

it("has a page script that parses", () => {
  const html = panelHtml("vscode-resource:")
  const scripts = [...html.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)].map((m) => m[1]!)
  expect(scripts).toHaveLength(1)
  expect(() => new Function(scripts[0]!)).not.toThrow()
})

it("offers the speeds with one decimal, so they line up", () => {
  const html = panelHtml("vscode-resource:")
  for (const s of SPEEDS) expect(html).toContain(`data-speed="${s}">${s.toFixed(1)}×</button>`)
})

it("gives controls the panel's own tooltips, since native ones show unreliably in a webview", () => {
  const html = panelHtml("vscode-resource:")
  expect(html).not.toMatch(/\stitle=|\.title = /)
  expect(html).toContain('data-tip="Interrupt"')
})

// Releases the extension: checks, bumps the version, builds the .vsix once, publishes that file to
// the Marketplace, then commits, tags, pushes, and makes a GitHub release with it.
//
//   npm run release -- patch | minor | major | <x.y.z> [--yes]
//
// The new version needs a section in packages/vscode/CHANGELOG.md, `## <version>`, which can be
// written just before: CHANGELOG.md is the one file that may have uncommitted changes, and it goes
// into the release commit.

import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { createInterface } from "node:readline/promises"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const EXTENSION = "packages/vscode"
const CHANGELOG = `${EXTENSION}/CHANGELOG.md`
const MANIFEST = `${EXTENSION}/package.json`

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: ROOT, stdio: "inherit", ...opts })
const read = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8" }).trim()
const manifest = () => JSON.parse(fs.readFileSync(path.join(ROOT, MANIFEST), "utf8"))

function fail(message) {
  console.error(`\n✕ ${message}`)
  process.exit(1)
}

function step(message) {
  console.log(`\n▸ ${message}`)
}

const parts = (v) => v.split(".").map(Number)

/** The version after `bump`, from `current`. An exact one may be the current, for its first release. */
function next(current, bump) {
  if (/^\d+\.\d+\.\d+$/.test(bump)) {
    const order = parts(bump).map((n, i) => n - parts(current)[i]).find((d) => d !== 0) ?? 0
    if (order < 0) fail(`${bump} is older than the current ${current}.`)
    return bump
  }
  const [major, minor, patch] = parts(current)
  if (bump === "major") return `${major + 1}.0.0`
  if (bump === "minor") return `${major}.${minor + 1}.0`
  if (bump === "patch") return `${major}.${minor}.${patch + 1}`
  fail("Say which version: patch, minor, major, or an exact x.y.z.")
}

/** The body of the changelog's section for `version`, without its heading. */
function notes(version) {
  const text = fs.readFileSync(path.join(ROOT, CHANGELOG), "utf8")
  const sections = text.split(/^## /m).slice(1)
  const section = sections.find((s) => s.split("\n", 1)[0].trim() === version)
  return section?.slice(section.indexOf("\n") + 1).trim()
}

const args = process.argv.slice(2)
const yes = args.includes("--yes")
const bump = args.find((a) => !a.startsWith("--"))
if (!bump) fail("Usage: npm run release -- patch | minor | major | <x.y.z> [--yes]")

const { publisher, name, version: current } = manifest()
const version = next(current, bump)
const tag = `v${version}`
const vsix = `${name}-${version}.vsix`

step("Checking the repository and accounts")
if (read("git", ["branch", "--show-current"]) !== "main") fail("Release from main.")
// Not `read`: trimming would take the first line's leading status column.
const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean)
const unexpected = dirty.filter((line) => line.slice(3) !== CHANGELOG)
if (unexpected.length) fail(`Commit or stash these first; only ${CHANGELOG} may have changes:\n${unexpected.join("\n")}`)
run("git", ["fetch", "--quiet", "--tags", "origin", "main"])
if (read("git", ["rev-parse", "HEAD"]) !== read("git", ["rev-parse", "origin/main"])) fail("main isn't the same as origin/main: pull or push first.")
if (read("git", ["tag", "--list", tag])) fail(`${tag} is already tagged.`)
if (!notes(version)) fail(`${CHANGELOG} has no section for ${version}: add "## ${version}" with what changed.`)
if (!read("vsce", ["ls-publishers"]).split("\n").includes(publisher)) fail(`vsce has no token for the publisher ${publisher}: run \`vsce login ${publisher}\`.`)
run("gh", ["auth", "status"], { stdio: "ignore" })

step("Testing")
run("npm", ["test"])
run("npm", ["run", "typecheck"])
run("npm", ["run", "test:integration"])

if (version !== current) {
  step(`Bumping ${current} → ${version}`)
  run("npm", ["version", version, "-w", EXTENSION, "--no-git-tag-version"], { stdio: ["inherit", "ignore", "inherit"] })
}

step(`Building ${vsix}`)
run("npm", ["run", "package"])

if (!yes) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question(`\nPublish ${publisher}.${name} ${version} to the Marketplace? A version can't be published twice. [y/N] `)
  rl.close()
  if (answer.trim().toLowerCase() !== "y") fail(`Not published. To undo the bump: git checkout ${MANIFEST} package-lock.json`)
}

step("Committing and tagging")
run("git", ["add", MANIFEST, "package-lock.json", CHANGELOG])
// Releasing the current version with its changelog already committed leaves nothing to commit.
const committed = read("git", ["diff", "--cached", "--name-only"]) !== ""
if (committed) run("git", ["commit", "--quiet", "-m", `Release ${version}`])
run("git", ["tag", "-a", tag, "-m", `Release ${version}`])

step("Publishing to the Marketplace")
try {
  run("vsce", ["publish", "--packagePath", vsix])
} catch {
  // Nothing has left this machine: take the commit and tag back, keeping the changes.
  run("git", ["tag", "-d", tag], { stdio: "ignore" })
  if (committed) run("git", ["reset", "--soft", "HEAD~1"])
  fail(`Publishing failed; the commit and tag are undone, the bump is kept. Fix it, then: npm run release -- ${version}`)
}

// Published: from here on, a failure is finished by hand.
step("Pushing")
try {
  run("git", ["push", "--quiet", "origin", "main", tag])
} catch {
  fail(`${version} is published, but pushing failed. Finish with:\n  git push origin main ${tag}\n  gh release create ${tag} ${vsix} --title ${version} --notes-file <its changelog section>`)
}

step("Making the GitHub release")
try {
  run("gh", ["release", "create", tag, vsix, "--title", version, "--notes", notes(version)])
} catch {
  fail(`${version} is published and pushed, but the GitHub release failed. Finish with:\n  gh release create ${tag} ${vsix} --title ${version} --notes-file <its changelog section>`)
}

console.log(`\n✓ Released ${version}: https://marketplace.visualstudio.com/items?itemName=${publisher}.${name}`)

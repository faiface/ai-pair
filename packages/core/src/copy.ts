import { execFile as execFileCallback } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"
import { merge3 } from "./merge"
import type { CopyFactory, CopyPort, StageChange } from "./ports"

const execFile = promisify(execFileCallback)

// How much git output a single call may produce: diffs of whole workspaces must fit.
const maxBuffer = 256 * 1024 * 1024

// Every git call runs non-interactively, so a stray credential prompt can never hang the agent.
const baseGitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" }

async function gitText(cwd: string, args: string[], extraEnv?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFile("git", args, {
    cwd,
    env: { ...baseGitEnv, ...extraEnv },
    maxBuffer,
    encoding: "utf8",
  })
  return stdout as string
}

async function gitBytes(cwd: string, args: string[], extraEnv?: NodeJS.ProcessEnv): Promise<Buffer> {
  const { stdout } = await execFile("git", args, {
    cwd,
    env: { ...baseGitEnv, ...extraEnv },
    maxBuffer,
    encoding: "buffer",
  })
  return stdout as Buffer
}

// Splits -z git output, where entries end in NUL and the last one leaves a trailing empty piece.
function splitZero(stdout: string): string[] {
  return stdout.split("\0").filter((entry) => entry !== "")
}

/** `file` under `to` instead of `from`, when it's under `from`; any other file as it is. */
function respell(file: string, from: string, to: string): string {
  const rel = path.relative(from, file)
  return rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) ? file : path.join(to, rel)
}

// Folders too heavy to duplicate into the private copy, linked as symlinks instead.
const heavyDirs: Record<string, true> = {
  node_modules: true,
  ".venv": true,
  venv: true,
  __pycache__: true,
  dist: true,
  build: true,
  target: true,
  ".next": true,
  ".gradle": true,
}

// Snapshots stage through their own index, beside the copy rather than in it, where the author
// would see it as a stray file.
const indexName = "index"

export const createCopy: CopyFactory = async (root) => {
  // Temp fixture repos often sit under symlinked dirs (/var -> /private/var), so resolve every path
  // before comparing or joining them; otherwise relative-path math silently points nowhere. Files
  // still cross the port as the editor spells them, under `given`: the editor takes the real path
  // for another document than the one the programmer has open.
  const given = path.resolve(root)
  const workspaceRoot = await fs.realpath(given)
  const stat = await fs.stat(workspaceRoot)
  if (!stat.isDirectory()) {
    throw new Error(`not a folder: ${root}`)
  }
  try {
    await gitText(workspaceRoot, ["--version"])
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      throw new Error("git is needed for staged pairing")
    }
    throw error
  }

  const repoTop = await findRepoTop(workspaceRoot)
  const gitMode = repoTop !== undefined && (await hasCommits(repoTop))

  const tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ai-pair-copy-")))
  // The copy's checkout: `worktree add` wants a folder that doesn't exist yet.
  const copyDir = path.join(tempDir, "copy")
  const linked = new Set<string>()
  let worktree = false
  let copyRoot: string
  let workspaceBase: string
  let toWorkspace: (rel: string) => string
  let toCopy: (file: string) => string

  try {
    if (gitMode && repoTop !== undefined) {
      // A detached worktree starts from a clean HEAD without touching the user's checkout, index, or branch.
      await gitText(repoTop, ["worktree", "add", "--detach", copyDir, "HEAD"])
      worktree = true
      await bringRepoState(repoTop, copyDir)
      await linkIgnored(repoTop, copyDir, linked)
      const relRoot = path.relative(repoTop, workspaceRoot)
      copyRoot = relRoot === "" ? copyDir : path.join(copyDir, relRoot)
      toWorkspace = (rel) => respell(path.join(repoTop, rel), workspaceRoot, given)
      toCopy = (file) => path.join(copyDir, path.relative(repoTop, respell(file, given, workspaceRoot)))
      workspaceBase = repoTop
    } else {
      await fs.mkdir(copyDir)
      await copyFolder(workspaceRoot, copyDir, linked)
      // The copy is its own throwaway repo, so snapshots never reach anything the user owns.
      await gitText(copyDir, ["init", "-q"])
      copyRoot = copyDir
      toWorkspace = (rel) => path.join(given, rel)
      toCopy = (file) => path.join(copyDir, path.relative(given, file))
      workspaceBase = workspaceRoot
    }
  } catch (error) {
    // Setup never leaves a stray worktree registration or temp dir behind when it fails halfway.
    if (worktree && repoTop !== undefined) {
      await gitText(repoTop, ["worktree", "remove", "--force", copyDir]).catch(() => "")
    }
    await fs.rm(tempDir, { recursive: true, force: true })
    throw error
  }

  const indexPath = path.join(tempDir, indexName)
  // Snapshots share one temp index file, so they must run one at a time; the queue keeps that promise.
  let queue: Promise<void> = Promise.resolve()
  let previous: string | undefined

  // Asked at each snapshot, since the author may change `.gitignore` in the copy.
  const ignoredLinks = async (): Promise<Set<string>> => {
    if (linked.size === 0) return new Set()
    try {
      // `-z` works only with `--stdin`, so paths come one per line; quotepath off keeps them as given.
      const out = await gitText(copyDir, ["-c", "core.quotepath=off", "check-ignore", "--no-index", "--", ...linked])
      return new Set(out.split("\n").filter((line) => line !== ""))
    } catch (error) {
      // check-ignore exits with 1 when none of the paths is ignored.
      if (typeof error === "object" && error !== null && "code" in error && error.code === 1) return new Set()
      throw error
    }
  }

  const takeSnapshot = async (): Promise<string> => {
    // Linked folders are excluded by name: `.gitignore` patterns like `node_modules/` match only
    // folders, not symlinks to them. Those `.gitignore` already covers, by a pattern like `.venv`,
    // are left out of the excludes: `git add` refuses a pathspec that names an ignored path.
    const ignored = await ignoredLinks()
    const excludes = [...linked].filter((rel) => !ignored.has(rel)).map((rel) => `:(exclude,literal)${rel}`)
    await gitText(copyDir, ["-c", "core.hooksPath=/dev/null", "add", "-A", "--", ".", ...excludes], {
      GIT_INDEX_FILE: indexPath,
    })
    const tree = (await gitText(copyDir, ["write-tree"], { GIT_INDEX_FILE: indexPath })).trim()
    // commit-tree writes no refs and runs no hooks, so neither the user's nor the copy's HEAD can move.
    const commitArgs = [tree, ...(previous === undefined ? [] : ["-p", previous]), "-m", "stage"]
    const id = (
      await gitText(
        copyDir,
        [
          "-c",
          "user.name=ai-pair",
          "-c",
          "user.email=ai-pair@localhost",
          "-c",
          "commit.gpgsign=false",
          "-c",
          "core.hooksPath=/dev/null",
          "commit-tree",
          ...commitArgs,
        ],
        { GIT_INDEX_FILE: indexPath },
      )
    ).trim()
    previous = id
    return id
  }

  const snapshot = async (): Promise<string> => {
    const run = queue.then(takeSnapshot)
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  const changes = async (from: string, to: string): Promise<StageChange[]> => {
    const statusOut = await gitText(copyDir, [
      "-c",
      "core.quotepath=off",
      "diff",
      "--no-renames",
      "-z",
      "--name-status",
      from,
      to,
    ])
    const numstatOut = await gitText(copyDir, [
      "-c",
      "core.quotepath=off",
      "diff",
      "--no-renames",
      "-z",
      "--numstat",
      from,
      to,
    ])
    const binary = new Set<string>()
    for (const entry of splitZero(numstatOut)) {
      // numstat prints `<added>\t<deleted>\t<path>`; binary files show `-\t-`.
      const tab = entry.indexOf("\t")
      const rest = tab === -1 ? entry : entry.slice(tab + 1)
      const tab2 = rest.indexOf("\t")
      const counts = tab === -1 ? [] : [entry.slice(0, tab), rest.slice(0, tab2)]
      const file = tab2 === -1 ? rest : rest.slice(tab2 + 1)
      if (counts.length === 2 && counts[0] === "-" && counts[1] === "-") {
        binary.add(file)
      }
    }
    const result: StageChange[] = []
    const tokens = splitZero(statusOut)
    for (let i = 0; i + 1 < tokens.length; i += 2) {
      const status = tokens[i]
      const rel = tokens[i + 1] as string
      if (status === undefined || rel === undefined) {
        continue
      }
      if (binary.has(rel)) {
        result.push({ file: toWorkspace(rel), binary: true })
        continue
      }
      // Blobs read straight from the snapshot commit, exactly as recorded, with no worktree involved.
      result.push({
        file: toWorkspace(rel),
        before: status === "A" ? undefined : await gitText(copyDir, ["-c", "core.quotepath=off", "show", `${from}:${rel}`]),
        after: status === "D" ? undefined : await gitText(copyDir, ["-c", "core.quotepath=off", "show", `${to}:${rel}`]),
      })
    }
    return result
  }

  const restore = async (snapshotId: string, file: string): Promise<void> => {
    const rel = path.relative(workspaceBase, respell(file, given, workspaceRoot)).split(path.sep).join("/")
    let bytes: Buffer | undefined
    try {
      bytes = await gitBytes(copyDir, ["-c", "core.quotepath=off", "show", `${snapshotId}:${rel}`])
    } catch {
      // The snapshot has no such file, so the workspace should not have it either.
      await fs.rm(file, { force: true })
      return
    }
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, bytes)
  }

  const carry = async (file: string, before: string, after: string): Promise<boolean> => {
    const copyPath = toCopy(file)
    let copyText: string
    try {
      copyText = await fs.readFile(copyPath, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error
      }
      // The author never made the file, so a brand-new workspace file lands as is.
      if (before !== "") {
        return false
      }
      await fs.mkdir(path.dirname(copyPath), { recursive: true })
      await fs.writeFile(copyPath, after)
      return true
    }
    // The texts given may use different line endings than the copy, so match the copy's before merging.
    const eol = copyText.includes("\r\n") ? "\r\n" : "\n"
    const base = normalizeEol(before, eol)
    const theirs = normalizeEol(after, eol)
    // The author's copy is `ours`, so its lines win every conflict and conflicts report false.
    const merged = merge3(base, copyText, theirs, "ours")
    if (merged.text !== copyText) {
      await fs.writeFile(copyPath, merged.text)
    }
    return merged.conflicts.length === 0
  }

  let disposed = false
  const dispose = async (): Promise<void> => {
    if (disposed) {
      return
    }
    disposed = true
    try {
      if (worktree && repoTop !== undefined) {
        await gitText(repoTop, ["worktree", "remove", "--force", copyDir])
        await gitText(repoTop, ["worktree", "prune"])
      }
    } finally {
      // rm removes symlinks themselves without following them, so linked folders stay intact.
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  }

  let base: string
  try {
    base = await takeSnapshot()
  } catch (error) {
    // A copy that can't take its first snapshot is never handed out, so nothing else would remove it.
    await dispose()
    throw error
  }

  const port: CopyPort = {
    root: copyRoot,
    base,
    snapshot,
    changes,
    restore,
    carry,
    dispose,
  }
  return port
}

async function findRepoTop(dir: string): Promise<string | undefined> {
  try {
    const top = (await gitText(dir, ["rev-parse", "--show-toplevel"])).trim()
    return await fs.realpath(top)
  } catch {
    return undefined
  }
}

async function hasCommits(repoTop: string): Promise<boolean> {
  try {
    await gitText(repoTop, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])
    return true
  } catch {
    // An unborn HEAD cannot seed a worktree, so the plain-copy fallback handles it instead.
    return false
  }
}

// Copies the workspace's uncommitted state over the clean HEAD checkout: tracked changes by bytes
// (binary-safe, unlike patching text through stdout) and deletions by removing them from the copy.
async function bringRepoState(repoTop: string, copyDir: string): Promise<void> {
  const statusOut = await gitText(repoTop, [
    "-c",
    "core.quotepath=off",
    "diff",
    "HEAD",
    "--no-renames",
    "-z",
    "--name-status",
  ])
  const tokens = splitZero(statusOut)
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const status = tokens[i]
    const rel = tokens[i + 1] as string
    if (status === undefined || rel === undefined) {
      continue
    }
    const dest = path.join(copyDir, rel)
    if (status === "D") {
      await fs.rm(dest, { force: true })
      continue
    }
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.copyFile(path.join(repoTop, rel), dest, fs.constants.COPYFILE_FICLONE)
  }
  const untrackedOut = await gitText(repoTop, ["-c", "core.quotepath=off", "ls-files", "-o", "--exclude-standard", "-z"])
  for (const rel of splitZero(untrackedOut)) {
    const dest = path.join(copyDir, rel)
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.copyFile(path.join(repoTop, rel), dest, fs.constants.COPYFILE_FICLONE)
  }
}

// Links ignored entries (dependencies, build outputs, secrets), each at its own path, nested ones
// too, as in a monorepo's packages: the author can build and test in the copy without duplicating
// gigabytes, and none of it ends up in a snapshot.
async function linkIgnored(repoTop: string, copyDir: string, linked: Set<string>): Promise<void> {
  const ignoredOut = await gitText(repoTop, ["-c", "core.quotepath=off", "ls-files", "-o", "-i", "--exclude-standard", "--directory", "-z"])
  for (const entry of splitZero(ignoredOut)) {
    // Folders come with a trailing slash.
    const rel = entry.replace(/\/$/, "")
    if (rel === "" || rel === ".git" || rel.startsWith(".git/")) continue
    await linkEntry(path.join(repoTop, rel), path.join(copyDir, rel), linked, rel)
  }
}

/** Links `source` at `dest`; a linked folder is added to `linked`, by its path in the copy. */
async function linkEntry(source: string, dest: string, linked: Set<string>, rel: string): Promise<void> {
  try {
    await fs.lstat(dest)
    return
  } catch {
    // The copy has no such entry yet, so linking proceeds below.
  }
  let isDir = false
  try {
    isDir = (await fs.stat(source)).isDirectory()
  } catch {
    return
  }
  await fs.mkdir(path.dirname(dest), { recursive: true })
  // Junctions are the only symlink kind Windows allows without privileges; elsewhere dirs link as dirs.
  const kind = isDir ? (process.platform === "win32" ? "junction" : "dir") : "file"
  await fs.symlink(source, dest, kind)
  if (isDir) linked.add(rel.split(path.sep).join("/"))
}

// Plain-copy fallback for folders outside git (or with no commits yet): everything is duplicated
// except heavy top-level dirs, which are linked just like ignored entries in the git case.
async function copyFolder(workspaceRoot: string, copyDir: string, linked: Set<string>): Promise<void> {
  const entries = await fs.readdir(workspaceRoot, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === ".git") {
      continue
    }
    const source = path.join(workspaceRoot, entry.name)
    const dest = path.join(copyDir, entry.name)
    if (heavyDirs[entry.name] === true) {
      try {
        await linkEntry(source, dest, linked, entry.name)
        continue
      } catch {
        // Linking failed, so fall through and copy the folder instead.
      }
    }
    // The OS clones blocks where the filesystem allows, so this stays cheap on APFS and Btrfs.
    await fs.cp(source, dest, { recursive: true, dereference: false, preserveTimestamps: true })
  }
}

function normalizeEol(text: string, eol: string): string {
  return eol === "\r\n" ? text.replace(/\r?\n/g, "\r\n") : text.replace(/\r\n/g, "\n")
}

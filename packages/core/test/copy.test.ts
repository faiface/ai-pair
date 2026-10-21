import { execFile as execFileCallback } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { createCopy } from "../src/copy"
import type { CopyPort } from "../src/ports"

const execFile = promisify(execFileCallback)

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    encoding: "utf8",
  })
  return stdout as string
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.stat(file)
    return true
  } catch {
    return false
  }
}

const copies: CopyPort[] = []
const dirs: string[] = []

afterEach(async () => {
  try {
    await Promise.all(copies.splice(0).map((copy) => copy.dispose()))
  } finally {
    await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
  }
})

async function freshDir(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ai-pair-copy-test-")))
  dirs.push(dir)
  return dir
}

// A repo with one committed file, one ignored dependency dir, and every kind of uncommitted state.
async function makeRepo(): Promise<{ dir: string; hello: string; modified: string }> {
  const dir = await freshDir()
  await git(dir, ["init", "-q", "-b", "main"])
  await git(dir, ["config", "user.name", "test"])
  await git(dir, ["config", "user.email", "test@localhost"])
  await git(dir, ["config", "commit.gpgsign", "false"])
  await fs.writeFile(path.join(dir, ".gitignore"), "node_modules/\n")
  await fs.writeFile(path.join(dir, "hello.txt"), "one\ntwo\n")
  await fs.writeFile(path.join(dir, "gone.txt"), "doomed\n")
  await git(dir, ["add", "-A"])
  await git(dir, ["commit", "-qm", "initial"])
  const modified = "one\ntwo modified\n"
  await fs.writeFile(path.join(dir, "hello.txt"), modified)
  await fs.rm(path.join(dir, "gone.txt"))
  await fs.writeFile(path.join(dir, "fresh.txt"), "fresh\n")
  await fs.mkdir(path.join(dir, "node_modules", "dep"), { recursive: true })
  await fs.writeFile(path.join(dir, "node_modules", "dep", "index.js"), "module.exports = 1\n")
  return { dir, hello: path.join(dir, "hello.txt"), modified }
}

async function repoState(dir: string): Promise<string> {
  const status = await git(dir, ["status", "--porcelain"])
  const head = await git(dir, ["rev-parse", "HEAD"])
  const branch = await git(dir, ["branch", "--show-current"])
  const stash = await git(dir, ["stash", "list"])
  return JSON.stringify({ status, head, branch, stash })
}

async function track<T extends CopyPort>(copy: T): Promise<T> {
  copies.push(copy)
  return copy
}

describe("private copy", { timeout: 30_000 }, () => {
  it("mirrors uncommitted state and links ignored dirs without touching the user repo", async () => {
    const { dir, hello, modified } = await makeRepo()
    const before = await repoState(dir)
    const copy = await track(await createCopy(dir))
    expect(await repoState(dir)).toBe(before)

    expect(await fs.readFile(path.join(copy.root, "hello.txt"), "utf8")).toBe(modified)
    expect(await exists(path.join(copy.root, "gone.txt"))).toBe(false)
    expect(await fs.readFile(path.join(copy.root, "fresh.txt"), "utf8")).toBe("fresh\n")
    const link = path.join(copy.root, "node_modules")
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true)
    expect(await fs.readlink(link)).toBe(path.join(dir, "node_modules"))
    expect(await repoState(dir)).toBe(before)

    await copy.snapshot()
    expect(await repoState(dir)).toBe(before)
    // The temp index lives in the copy, which snapshots must never report as a change.
    expect(await copy.changes(copy.base, await copy.snapshot())).toEqual([])

    await copy.dispose()
    expect(await repoState(dir)).toBe(before)
  })

  it("lists exactly the staged text and binary changes, never linked dirs", async () => {
    const { dir, modified } = await makeRepo()
    const copy = await track(await createCopy(dir))
    await fs.writeFile(path.join(copy.root, "hello.txt"), `${modified}three\n`)
    await fs.writeFile(path.join(copy.root, "new.txt"), "new\n")
    const bytes = Buffer.from([0, 1, 2, 3, 255, 254, 253])
    await fs.writeFile(path.join(copy.root, "image.bin"), bytes)

    const snap = await copy.snapshot()
    const staged = await copy.changes(copy.base, snap)
    expect(staged.map((change) => path.basename(change.file)).sort()).toEqual(["hello.txt", "image.bin", "new.txt"])
    expect(staged.every((change) => !change.file.includes("node_modules"))).toBe(true)

    const hello = staged.find((change) => change.file === path.join(dir, "hello.txt"))
    expect(hello?.binary).toBeUndefined()
    expect(hello?.before).toBe(modified)
    expect(hello?.after).toBe(`${modified}three\n`)
    const added = staged.find((change) => change.file === path.join(dir, "new.txt"))
    expect(added?.before).toBeUndefined()
    expect(added?.after).toBe("new\n")
    const binary = staged.find((change) => change.file === path.join(dir, "image.bin"))
    expect(binary?.binary).toBe(true)
    expect(binary?.before).toBeUndefined()
    expect(binary?.after).toBeUndefined()
  })

  it("snapshots when .gitignore names a linked folder without a trailing slash", async () => {
    const { dir } = await makeRepo()
    await fs.writeFile(path.join(dir, ".gitignore"), "node_modules/\n.venv\n")
    await fs.mkdir(path.join(dir, ".venv", "bin"), { recursive: true })
    await fs.writeFile(path.join(dir, ".venv", "bin", "python"), "#!/bin/sh\n")
    const copy = await track(await createCopy(dir))
    expect((await fs.lstat(path.join(copy.root, ".venv"))).isSymbolicLink()).toBe(true)
    await fs.writeFile(path.join(copy.root, "new.txt"), "new\n")

    const staged = await copy.changes(copy.base, await copy.snapshot())
    expect(staged.map((change) => path.basename(change.file)).sort()).toEqual(["new.txt"])
  })

  it("maps a subfolder workspace to its counterpart in the copy", async () => {
    const { dir } = await makeRepo()
    await fs.mkdir(path.join(dir, "sub"), { recursive: true })
    await fs.writeFile(path.join(dir, "sub", "inner.txt"), "inner\n")
    await git(dir, ["add", "-A"])
    await git(dir, ["commit", "-qm", "sub"])
    const copy = await track(await createCopy(path.join(dir, "sub")))

    expect(path.basename(await fs.realpath(copy.root))).toBe("sub")
    expect(await fs.readFile(path.join(copy.root, "inner.txt"), "utf8")).toBe("inner\n")

    await fs.writeFile(path.join(copy.root, "inner.txt"), "inner edited\n")
    const staged = await copy.changes(copy.base, await copy.snapshot())
    expect(staged).toHaveLength(1)
    expect(staged[0]?.file).toBe(path.join(dir, "sub", "inner.txt"))
    expect(staged[0]?.before).toBe("inner\n")
    expect(staged[0]?.after).toBe("inner edited\n")
  })

  it("names files the way the workspace was given, when it's opened through a symlink", async () => {
    const plain = await freshDir()
    await fs.writeFile(path.join(plain, "hello.txt"), "hello\n")
    for (const dir of [(await makeRepo()).dir, plain]) {
      const alias = path.join(await freshDir(), "alias")
      await fs.symlink(dir, alias)
      const copy = await track(await createCopy(alias))
      await fs.writeFile(path.join(copy.root, "hello.txt"), "edited\n")
      const staged = await copy.changes(copy.base, await copy.snapshot())
      expect(staged.map((c) => c.file)).toEqual([path.join(alias, "hello.txt")])
      // A programmer's edit, named the editor's way, lands in the copy.
      expect(await copy.carry(path.join(alias, "new.txt"), "", "new\n")).toBe(true)
      expect(await fs.readFile(path.join(copy.root, "new.txt"), "utf8")).toBe("new\n")
    }
  })

  it("merges workspace changes around author edits, and keeps author lines on conflict", async () => {
    const { dir, hello } = await makeRepo()
    await fs.writeFile(hello, "a\nb\nc\nd\n")
    await git(dir, ["add", "-A"])
    await git(dir, ["commit", "-qm", "lines"])
    const copy = await track(await createCopy(dir))
    const base = "a\nb\nc\nd\n"
    await fs.writeFile(path.join(copy.root, "hello.txt"), "a\nB\nc\nd\n")

    expect(await copy.carry(hello, base, "a\nb\nc\nD\n")).toBe(true)
    expect(await fs.readFile(path.join(copy.root, "hello.txt"), "utf8")).toBe("a\nB\nc\nD\n")

    expect(await copy.carry(hello, base, "a\nb2\nc\nd\n")).toBe(false)
    expect(await fs.readFile(path.join(copy.root, "hello.txt"), "utf8")).toBe("a\nB\nc\nD\n")
  })

  it("restores a snapshot binary into the workspace, or deletes when absent", async () => {
    const { dir } = await makeRepo()
    const copy = await track(await createCopy(dir))
    const bytes = Buffer.from([137, 80, 78, 71, 0, 1, 2, 3])
    await fs.writeFile(path.join(copy.root, "image.bin"), bytes)
    const snap = await copy.snapshot()

    const target = path.join(dir, "image.bin")
    expect(await exists(target)).toBe(false)
    await copy.restore(snap, target)
    expect((await fs.readFile(target)).equals(bytes)).toBe(true)

    await copy.restore(copy.base, target)
    expect(await exists(target)).toBe(false)
  })

  it("removes the temp dir and the worktree entry on dispose", async () => {
    const { dir } = await makeRepo()
    const copy = await track(await createCopy(dir))
    const tempRoot = await fs.realpath(copy.root)
    await copy.dispose()

    expect(await exists(tempRoot)).toBe(false)
    const list = await git(dir, ["worktree", "list", "--porcelain"])
    expect(list.trim().split("\n").filter((line) => line.startsWith("worktree "))).toHaveLength(1)
  })

  it("falls back to a plain copy with linked heavy dirs outside git", async () => {
    const dir = await freshDir()
    await fs.writeFile(path.join(dir, "a.txt"), "a\n")
    await fs.mkdir(path.join(dir, "node_modules", "big"), { recursive: true })
    await fs.writeFile(path.join(dir, "node_modules", "big", "lib.js"), "x\n")

    const copy = await track(await createCopy(dir))
    const link = path.join(copy.root, "node_modules")
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true)
    expect(await fs.readlink(link)).toBe(path.join(dir, "node_modules"))
    expect(await fs.readFile(path.join(copy.root, "a.txt"), "utf8")).toBe("a\n")

    await fs.writeFile(path.join(copy.root, "b.txt"), "b\n")
    const staged = await copy.changes(copy.base, await copy.snapshot())
    expect(staged).toHaveLength(1)
    expect(staged[0]?.file).toBe(path.join(dir, "b.txt"))
    expect(staged[0]?.before).toBeUndefined()
    expect(staged[0]?.after).toBe("b\n")
  })
})

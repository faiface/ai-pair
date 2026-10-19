// The agents pair-mcp can be set up in, and how: each one's MCP configuration, edited in place so
// the programmer's own settings, comments and other servers stay as they were. No VS Code here, so
// it can be tested on its own. See "Starting a session" in ARCHITECTURE.md.

import { execFile } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"

/** Where the agents keep their configuration, and how to run their CLIs: the real machine, or a test's. */
export type Host = {
  home: string
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  /** Runs a program, rejecting if it exits nonzero. */
  exec(file: string, args: string[]): Promise<void>
}

export type Agent = {
  id: string
  label: string
  /** The command that starts it in a terminal, where it has one: Cursor is an editor, so it hasn't. */
  run?: string
  /** Its CLI is on the PATH, or its configuration is there. */
  detect(host: Host): boolean
  /** Configured to run `command` as the pair server. */
  isSetUp(host: Host, command: string): boolean
  /** Configures the pair server to run `command`. Returns what it changed, for the programmer. */
  setUp(host: Host, command: string): Promise<string>
}

/** The name the server goes by in every agent. */
export const SERVER = "pair"

export const AGENTS: Agent[] = [
  {
    id: "omp",
    label: "OMP",
    run: "omp",
    detect: (host) => !!findOmp(host) || exists(path.join(host.home, ".omp")),
    isSetUp: (host, command) => {
      const data = readJson(ompFile(host))
      const entry = data?.mcpServers?.[SERVER]
      if (entry?.command !== command) return false
      // OMP turns a server off three ways: its own `enabled: false`, the user allowlist that can
      // force it back on, and the denylist, which wins over both.
      if (Array.isArray(data?.disabledServers) && data.disabledServers.includes(SERVER)) return false
      if (entry.enabled === false && !(Array.isArray(data?.enabledServers) && data.enabledServers.includes(SERVER))) return false
      // Pair calls block while the programmer watches and replies, far past OMP's 30s MCP default.
      return entry.timeout === 0
    },
    async setUp(host, command) {
      const file = ompFile(host)
      if (!exists(file)) {
        write(file, `{\n  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json"\n}\n`)
      }
      editJson(file, ["mcpServers", SERVER], { type: "stdio", command, args: [], enabled: true, timeout: 0 })
      const data = readJson(file)
      if (Array.isArray(data?.disabledServers) && data.disabledServers.includes(SERVER)) {
        editJson(file, ["disabledServers"], data.disabledServers.filter((name: unknown) => name !== SERVER))
      }
      return file
    },
  },
  {
    id: "claude",
    label: "Claude Code",
    run: "claude",
    detect: (host) => !!which(host, "claude", [path.join(host.home, ".local", "bin")]) || exists(claudeFile(host)),
    isSetUp: (host, command) => readJson(claudeFile(host))?.mcpServers?.[SERVER]?.command === command,
    async setUp(host, command) {
      // Claude Code rewrites its file all the time, so its own CLI is the safer writer, when it's there.
      const cli = which(host, "claude", [path.join(host.home, ".local", "bin")])
      if (!cli) {
        editJson(claudeFile(host), ["mcpServers", SERVER], { type: "stdio", command, args: [], env: {} })
        return claudeFile(host)
      }
      // `add` refuses a name that's taken, so a stale entry goes first.
      await run(host, cli, ["mcp", "remove", "--scope", "user", SERVER]).catch(() => {})
      await run(host, cli, ["mcp", "add", "--scope", "user", SERVER, "--", command])
      return "claude mcp add"
    },
  },
  {
    id: "codex",
    label: "Codex",
    run: "codex",
    detect: (host) => !!which(host, "codex") || exists(codexDir(host)),
    isSetUp: (host, command) => {
      const text = readText(path.join(codexDir(host), "config.toml"))
      return text !== undefined && tomlTable(text, SERVER)?.includes(`command = ${tomlString(command)}`) === true
    },
    async setUp(host, command) {
      // Written directly rather than with `codex mcp add`: the npm shim's binary goes missing easily.
      const file = path.join(codexDir(host), "config.toml")
      const text = readText(file) ?? ""
      write(file, withTomlTable(text, SERVER, [`command = ${tomlString(command)}`, "args = []"]))
      return file
    },
  },
  {
    id: "opencode",
    label: "OpenCode",
    run: "opencode",
    detect: (host) => !!which(host, "opencode", [path.join(host.home, ".opencode", "bin")]) || exists(opencodeDir(host)),
    isSetUp: (host, command) =>
      ["config.json", "opencode.json", "opencode.jsonc"].some(
        (name) => readJson(path.join(opencodeDir(host), name))?.mcp?.[SERVER]?.command?.[0] === command,
      ),
    async setUp(host, command) {
      const dir = opencodeDir(host)
      const file = ["opencode.jsonc", "opencode.json"].map((name) => path.join(dir, name)).find(exists)
      const target = file ?? path.join(dir, "opencode.json")
      if (!file) write(target, `{\n  "$schema": "https://opencode.ai/config.json"\n}\n`)
      editJson(target, ["mcp", SERVER], { type: "local", command: [command], enabled: true })
      return target
    },
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    run: "gemini",
    detect: (host) => !!which(host, "gemini") || exists(path.join(host.home, ".gemini")),
    isSetUp: (host, command) => readJson(geminiFile(host))?.mcpServers?.[SERVER]?.command === command,
    async setUp(host, command) {
      editJson(geminiFile(host), ["mcpServers", SERVER], { command, args: [] })
      return geminiFile(host)
    },
  },
  {
    id: "cursor",
    label: "Cursor",
    detect: (host) => !!which(host, "cursor") || exists(path.join(host.home, ".cursor")),
    isSetUp: (host, command) => readJson(cursorFile(host))?.mcpServers?.[SERVER]?.command === command,
    async setUp(host, command) {
      editJson(cursorFile(host), ["mcpServers", SERVER], { type: "stdio", command, args: [] })
      return cursorFile(host)
    },
  },
]

function claudeFile(host: Host): string {
  return path.join(host.env.CLAUDE_CONFIG_DIR || host.home, ".claude.json")
}

function codexDir(host: Host): string {
  return host.env.CODEX_HOME || path.join(host.home, ".codex")
}

/** Under `~/.config` on every OS, Windows included. */
function opencodeDir(host: Host): string {
  return path.join(host.env.XDG_CONFIG_HOME || path.join(host.home, ".config"), "opencode")
}

function geminiFile(host: Host): string {
  return path.join(host.home, ".gemini", "settings.json")
}

function cursorFile(host: Host): string {
  return path.join(host.home, ".cursor", "mcp.json")
}

/**
 * OMP's own MCP file: in its agent folder, which `PI_CODING_AGENT_DIR` moves, and a named
 * profile (`OMP_PROFILE`) keeps apart from the default one.
 */
export function ompFile(host: Host): string {
  if (host.env.PI_CODING_AGENT_DIR) return path.join(host.env.PI_CODING_AGENT_DIR, "mcp.json")
  const profile = host.env.OMP_PROFILE || host.env.PI_PROFILE
  const dir =
    profile && !profile.includes("/") && !profile.includes("\\") && profile !== ".."
      ? path.join(host.home, ".omp", "profiles", profile, "agent")
      : path.join(host.home, ".omp", "agent")
  return path.join(dir, "mcp.json")
}

/** The `omp` program: on the PATH, or where its installers put it off the PATH. */
export function findOmp(host: Host): string | undefined {
  return which(host, "omp", [path.join(host.home, ".local", "bin"), path.join(host.home, ".bun", "bin")])
}

// ---- Programs --------------------------------------------------------------

/** The program `name` on the PATH, or in one of `extra` (where installers put it off the PATH). */
export function which(host: Host, name: string, extra: string[] = []): string | undefined {
  const windows = host.platform === "win32"
  const dirs = [...(pathVar(host) ?? "").split(windows ? ";" : ":"), ...extra].filter(Boolean)
  const exts = windows ? (host.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""]
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext)
      try {
        if (fs.statSync(file).isFile()) return file
      } catch {
        // Not here.
      }
    }
  }
  return undefined
}

function pathVar(host: Host): string | undefined {
  // Windows names it `Path`, and a copy of the environment is no longer case-insensitive.
  const key = Object.keys(host.env).find((k) => k.toUpperCase() === "PATH")
  return key && host.env[key]
}

/** Runs `file`; on Windows, a `.cmd` or `.bat` (an npm shim) only runs through the shell. */
function run(host: Host, file: string, args: string[]): Promise<void> {
  if (host.platform === "win32" && /\.(cmd|bat)$/i.test(file)) {
    return host.exec(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${[file, ...args].map(cmdQuoted).join(" ")}"`])
  }
  return host.exec(file, args)
}

function cmdQuoted(arg: string): string {
  return /[\s"&|<>^()]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg
}

/** The real machine's `exec`. */
export function execProgram(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsVerbatimArguments: /cmd(\.exe)?$/i.test(file), timeout: 30_000 }, (error, _out, stderr) =>
      error ? reject(new Error(stderr.trim() || error.message)) : resolve(),
    )
  })
}

// ---- Files -----------------------------------------------------------------

function exists(file: string): boolean {
  return fs.existsSync(file)
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

function readJson(file: string): any {
  const text = readText(file)
  return text === undefined ? undefined : parse(text, [], { allowTrailingComma: true })
}

/** Sets `value` at `keys` in a JSON (or JSONC) file, leaving the rest of its text as it was. */
export function editJson(file: string, keys: string[], value: unknown): void {
  const text = readText(file)
  if (text === undefined || text.trim() === "") {
    write(file, JSON.stringify(setIn({}, keys, value), null, 2) + "\n")
    return
  }
  const errors: ParseError[] = []
  parse(text, errors, { allowTrailingComma: true })
  if (errors.length) throw new Error(`${file} isn't valid JSON, so it was left alone.`)
  const indent = /^([ \t]+)"/m.exec(text)?.[1] ?? "  "
  const edits = modify(text, keys, value, {
    formattingOptions: {
      insertSpaces: !indent.includes("\t"),
      tabSize: indent.includes("\t") ? 1 : indent.length,
      eol: text.includes("\r\n") ? "\r\n" : "\n",
    },
  })
  write(file, applyEdits(text, edits))
}

function setIn(object: Record<string, unknown>, keys: string[], value: unknown): Record<string, unknown> {
  const [key, ...rest] = keys
  object[key!] = rest.length ? setIn({}, rest, value) : value
  return object
}

// ---- TOML ------------------------------------------------------------------
// Codex's config.toml: only the `[mcp_servers.<name>]` table (and its subtables) is touched, as
// text, so comments and formatting elsewhere survive. A full TOML round trip would drop them.

const HEADER = /^\s*\[\[?\s*([^\]]*?)\s*\]\]?\s*(#.*)?$/

/** The dotted key of a table header, unquoted: `[mcp_servers."pair".env]` → `mcp_servers.pair.env`. */
function headerKey(line: string): string | undefined {
  const key = HEADER.exec(line)?.[1]
  return key?.split(/\s*\.\s*/).map((part) => part.replace(/^(["'])(.*)\1$/, "$2")).join(".")
}

function ownTable(key: string | undefined, name: string): boolean {
  return key === `mcp_servers.${name}` || key?.startsWith(`mcp_servers.${name}.`) === true
}

/** The text of the server's table and its subtables, if it has one. */
export function tomlTable(text: string, name: string): string | undefined {
  const lines = text.split(/\r?\n/)
  let inside = false
  const own: string[] = []
  for (const line of lines) {
    const key = headerKey(line)
    if (key !== undefined) inside = ownTable(key, name)
    if (inside) own.push(line)
  }
  return own.length ? own.join("\n") : undefined
}

/**
 * Replaces the server's table with one holding `body`, where the old one was, or adds it at the end.
 * Throws if the server is defined some other way (an inline table, dotted keys) it can't safely replace.
 */
export function withTomlTable(text: string, name: string, body: string[]): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n"
  const lines = text === "" ? [] : text.split(/\r?\n/)
  if (text.endsWith("\n")) lines.pop()
  const table = [`[mcp_servers.${name}]`, ...body]

  const out: string[] = []
  let current = "" // the table the line is in, "" before any header
  let replaced = false
  let skipping = false
  let tail: string[] = [] // blank lines and comments at the end of a skipped table: the next one's
  for (const line of lines) {
    const key = headerKey(line)
    if (key !== undefined) {
      current = key
      if (ownTable(key, name)) {
        if (!replaced) out.push(...table)
        replaced = true
        skipping = true
        tail = []
        continue
      }
      if (skipping) out.push(...tail)
      skipping = false
    } else if (!skipping && definesInline(current, line, name)) {
      throw new Error(`The ${name} server is defined in a way this can't update. Remove it from config.toml, and try again.`)
    }
    if (skipping) {
      if (line.trim() === "" || line.trim().startsWith("#")) tail.push(line)
      else tail = []
      continue
    }
    out.push(line)
  }
  if (skipping) out.push(...tail)
  if (!replaced) {
    while (out.length && out[out.length - 1]!.trim() === "") out.pop()
    if (out.length) out.push("")
    out.push(...table)
  }
  return out.join(eol) + eol
}

/** A key line defining the server outside its own table: `mcp_servers.pair = …`, or `pair = …` in `[mcp_servers]`. */
function definesInline(table: string, line: string, name: string): boolean {
  const key = /^\s*([^=#]+?)\s*=/.exec(line)?.[1]
  if (!key) return false
  const full = [table, key.split(/\s*\.\s*/).map((p) => p.replace(/^(["'])(.*)\1$/, "$2")).join(".")]
    .filter(Boolean)
    .join(".")
  return full === "mcp_servers" || full === `mcp_servers.${name}` || full.startsWith(`mcp_servers.${name}.`)
}

/** A TOML basic string: JSON's escapes are all valid TOML. */
function tomlString(s: string): string {
  return JSON.stringify(s)
}

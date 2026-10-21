// Turning a `say` into words worth speaking. The agent writes a `say` for the ear when the voice is
// on — "req dot body", "dunder add" — so this is only a safety net: what slips through for the
// eyes (markup, links, a name in backticks) is dropped or said the way a programmer would, and
// words a speech model mispronounces get its spelling. Then it's split into sentences, so the
// first sound comes fast and stale lines can be dropped whole.

/** A `say` as a programmer would say it: markup and links dropped, code slipped in as spoken words. */
export function spokenText(text: string): string {
  return text
    .replace(/```[a-z]*\n?[\s\S]*?```/g, " ") // a code block is for the eyes
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/`([^`]+)`/g, (_, code: string) => ` ${spokenCode(code)} `)
    .replace(/\*\*|__|[*#~>]/g, "")
    .replace(/(^|\s)_([^_\s][^_]*)_(?=[\s.,;:!?]|$)/g, "$1$2") // _emphasis_, not snake_case
    .replace(/\b[A-Za-z]+\b/g, (word) => WORDS[word] ?? WORDS[word.toLowerCase()] ?? word)
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
}

/** How a piece of code is said: dots, slashes and operators as words, names split into theirs. */
function spokenCode(code: string): string {
  return code
    .replace(/\(\)/g, "") // `express.json()` is "express dot json"
    .replace(/\b[A-Z][A-Z\d]*(?:_[A-Z\d]+)+\b/g, (name) => name.toLowerCase()) // MAX_RETRIES is a name, not letters
    .replace(/(^|\s)--(?=\s|$)/g, "$1") // `npm test -- --watch`: the bare `--` isn't said
    .replace(/(^|\s)(--?)(?=[a-z])/g, (_, before: string, dashes: string) => before + (dashes.length === 2 ? "dash dash " : "dash "))
    .replace(/!==|===|!=|==|=>|->|>=|<=|&&|\|\||\?\?|\+\+|\+=|-=|::/g, (op) => ` ${OPERATORS[op]} `)
    .replace(/(^|[\s/]):(?=\w)/g, "$1") // a route's `:id` is "id"
    .replace(/(\w)\.([A-Za-z]+)\b/g, (_, before: string, after: string) => `${before} dot ${EXTENSIONS[after] ?? after}`)
    .replace(/\//g, " slash ")
    .replace(/[(){}[\]<>;,"'`=]/g, " ")
    .replace(/(\w)[_-](?=\w)/g, "$1 ")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2") // createTodo
    .replace(/([A-Z]+)([A-Z][a-z]{2,})/g, "$1 $2") // XMLHttp
    .replace(/\b[A-Z]{5,}\b/g, (word) => word.toLowerCase()) // a long all-caps name is a word
    .replace(/_/g, " ")
}

const OPERATORS: Record<string, string> = {
  "!==": "not equals",
  "===": "equals",
  "!=": "not equals",
  "==": "equals",
  "=>": "arrow",
  "->": "arrow",
  ">=": "at least",
  "<=": "at most",
  "&&": "and",
  "||": "or",
  "??": "or else",
  "++": "plus plus",
  "+=": "plus equals",
  "-=": "minus equals",
  "::": "colon colon",
}

/** File extensions as they're said: most are letters, a few are words. */
const EXTENSIONS: Record<string, string> = {
  ts: "T S",
  tsx: "T S X",
  js: "J S",
  jsx: "J S X",
  mjs: "M J S",
  cjs: "C J S",
  json: "json",
  md: "M D",
  css: "C S S",
  scss: "S C S S",
  html: "H T M L",
  py: "pie",
  rs: "R S",
  rb: "R B",
  sh: "S H",
  yml: "yaml",
  txt: "text",
  env: "env",
}

/** Words a speech model says wrong, spelled the way a programmer says them. */
const WORDS: Record<string, string> = {
  id: "I D",
  ID: "I D",
  ids: "I Ds",
  IDs: "I Ds",
  db: "D B",
  ui: "U I",
  api: "A P I",
  apis: "A P Is",
  url: "U R L",
  urls: "U R Ls",
  uri: "U R I",
  uuid: "U U I D",
  sql: "sequel",
  cli: "C L I",
  npm: "N P M",
  cwd: "C W D",
  src: "source",
  ctx: "context",
  cfg: "config",
  msg: "message",
  btn: "button",
  async: "a sync",
  stdin: "standard in",
  stdout: "standard out",
  stderr: "standard error",
  // Said one way by every programmer, read another by a speech model that has only seen them written.
  req: "rec",
  res: "rez",
  todo: "to-do",
  todos: "to-do's",
}

const MAX_CHUNK = 200

/** Sentences of a text, long ones cut at a comma or a space, so no chunk runs past a breath. */
export function splitSentences(text: string): string[] {
  // A sentence ends where its stop meets a space: a dot inside a word, or after "etc.", is no end.
  const parts = text.split(/(?<!\b(?:etc|vs)\.)(?<=[.!?…]["')\]]*)\s+/)
  const out: string[] = []
  for (const part of parts) {
    let rest = part.trim()
    while (rest.length > MAX_CHUNK) {
      const cut = Math.max(rest.lastIndexOf(", ", MAX_CHUNK), rest.lastIndexOf(" ", MAX_CHUNK))
      const at = cut > 40 ? cut + 1 : MAX_CHUNK
      out.push(rest.slice(0, at).trim())
      rest = rest.slice(at).trim()
    }
    if (rest) out.push(rest)
  }
  return out.filter(Boolean)
}

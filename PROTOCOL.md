# Pair Programmer Interaction Protocol

This document specifies how a coding agent and the editor extension interact
during a pair programming session. The agent talks to the extension over MCP;
the extension renders the agent's actions (a second cursor, typing, a narration
panel) and reports back what happened, including everything the programmer did.

This document covers only what the agent can do and observe. How the extension
presents it to the programmer is in [DESIGN.md](DESIGN.md), and how the tool is
built and connected is in [ARCHITECTURE.md](ARCHITECTURE.md).

Status: **draft**. Numbers marked *tunable* are initial guesses to be adjusted
by feel.

## Goals

- The programmer can follow everything the agent does, at a pace they can absorb.
- Narration is synchronized with the actions it describes.
- The programmer can interrupt, steer, or take over at any moment, and the
  agent always knows exactly what happened.
- Thinking time of the agent is hidden behind playback, so there are no awkward
  pauses between "think" and "act".

## Principles

1. **The extension is the source of truth.** The agent submits *intentions*;
   the extension reports what *actually happened*. The agent's picture of the
   world is always reconciled through reports.
2. **The programmer always preempts the agent.** Anything the programmer does
   takes effect immediately on their side. The agent learns about it on its
   next call.
3. **Events are delivered exactly once**, in the reports of `step` and `listen`.
4. **No stale plans.** A batch never plays if it was planned without knowledge
   of an interrupting event.
5. **During a session, the agent never ends its turn.** When it has nothing to
   do, it calls `listen` and waits for the programmer.

## Concepts

**Agent cursor.** A position (and optional selection) in a file, rendered as a
second cursor. The extension tracks it through the programmer's edits, like a
marker.

**Action.** A single visible operation: say something, move, select, type,
delete, point, run a command.

**Batch.** An ordered list of actions submitted in one `step` call. A batch is
the unit of planning: one idea, typically one narration plus the few edits it
describes.

**Playback.** The extension plays batches from a queue, at human speed.

**Report.** The result of a `step` or `listen` call: the outcome of finished
batches, plus events that happened since the last report.

**Turn.** Either the agent's turn (it drives, the programmer watches) or the
programmer's turn (the programmer drives, the agent can only comment). Turns
change only explicitly.

**Session.** One stretch of pairing, from `start` to its end. One harness
conversation can contain many sessions, one after another: the programmer
works with the agent as usual, pairs for a while, ends the session, and may
pair again later. Outside a session, all tools except `start` fail with
`no_session`.

## Timing model

In the normal case, the contract is:

> **Every `step` call submits a new batch and returns the report for the
> previous batch.**

Concretely:

1. The first `step` call returns immediately. Its batch starts playing and the
   agent goes on to think about the next batch.
2. The second `step` call queues its batch and **blocks until the first batch
   finishes playing**. It then returns the first batch's report, and the second
   batch starts playing.
3. And so on. The agent is always planning batch N+1 while the programmer
   watches batch N. It can never get more than one batch ahead.
4. After its last batch, the agent calls `listen`, which collects that batch's
   report and then waits for the programmer.

```
agent:      [think 1] step(1) [think 2] step(2)·····blocked·····  [think 3] step(3)····
playback:                     [==== batch 1 ====][==== batch 2 ====][==== batch 3 ====]
                                                  ^ step(2) returns report of batch 1
```

### Precise rules

The extension keeps a queue of batches. Each batch gets an id and ends with
one of these statuses:

| Status        | Meaning                                                              |
|---------------|----------------------------------------------------------------------|
| `completed`   | All actions played.                                                  |
| `interrupted` | Playback was stopped by an interrupting event partway through.       |
| `failed`      | An action could not be performed (e.g. an anchor didn't resolve).    |
| `discarded`   | Never started, because an earlier batch didn't complete or an interrupting event arrived first. |

Rules:

- **Blocking.** `step` enqueues its batch and blocks until the queue holds only
  that batch (i.e. everything before it finished), or until an interrupting
  event occurs.
- **Continuity.** A batch only starts playing if the batch before it
  `completed`. Otherwise it is `discarded`: it was planned assuming the previous
  batch's outcome, which didn't happen.
- **No stale plans.** If an interrupting event has occurred that the agent
  hasn't yet received in a report, a newly submitted batch is `discarded`
  immediately and the call returns right away.
- **Nothing is lost.** Unplayed actions of `interrupted`, `failed`, and
  `discarded` batches are returned verbatim, so the agent can resubmit them
  unchanged, modify them, or drop them. An action cut off partway through
  comes back reduced to what it didn't do yet.
- **Anchors resolve at play time.** Anchors in a batch are resolved when the
  action plays, not when the batch is submitted. A batch may therefore refer to
  text that an earlier, still-queued batch is going to type. (The agent's own
  typing is deterministic; only the programmer can break that prediction, and
  that is an interrupting event, covered by the rules above.)
- **Timeouts.** Any blocking call returns after at most `MAX_BLOCK` (*tunable*,
  ~45 s, safely below common MCP client timeouts) even if nothing has finished,
  saying so. Nothing is lost: the agent simply carries on as if the
  call had returned normally, submitting its next batch with `step`, or
  calling `listen` if it has nothing more. This covers long playbacks and
  paused playback.

### Pause and follow mode

During the agent's turn, the programmer's view **follows the agent cursor**,
so every `move` is visible to them, or, right after a `point`, the pointed
code.

Playback pauses when the programmer presses Pause, navigates away, or starts
typing a reply, until they resume. **Pausing is not an event**: the agent isn't told,
its blocked call just waits longer (subject to `MAX_BLOCK`).

## Tools

### `start(task?: string) -> Report`

Starts a session in the editor window for the current project. `task` is a
short description shown in the narration panel. Fails if a session is already
active in that window, or if no editor window has the project open.

Besides the report, the result includes the [agent guide](AGENT_GUIDE.md),
which the agent follows for the whole session.

File paths given to and returned by all tools are relative to the agent's
working directory (absolute paths work too).

The session starts in the agent's turn, with no agent cursor until the first
`move`.

### `end(summary?: string) -> Report`

Ends the session. Anything still queued plays out first. `summary` is shown as
the closing message in the narration panel. Returns the final report.

### `step(actions: Action[]) -> Report`

Submits a batch. Blocks as described in [Timing model](#timing-model).

**A batch works in one file.** It may name a file (in `move` or `point`) only
before its first edit, and all the files it names must be the same one. So
every batch edits exactly one file, and its report shows one piece of code. A
batch that breaks this is rejected when it's submitted, as an error of the
call: nothing is queued.

An empty batch isn't a batch: `step([])` waits for the queued batches to
finish, without waiting for the programmer, and reports them.

### `listen() -> Report`

Collects the reports of all queued batches, then waits for the programmer.
Returns when:

- all batches have finished and a programmer event arrives (message, turn
  change, …), or
- a batch finishes with a status other than `completed`, or
- `MAX_BLOCK` elapses.

`listen` is how the agent "ends its turn" without actually ending it.

### `read(file: string, from_line?: number, to_line?: number) -> text`

Returns the contents of a file **as it is in the editor buffer**, including
unsaved changes and everything played so far (but not text still queued for
playback). Falls back to disk for files that aren't open. The result is the
file's name, whether it has unsaved changes, and its lines, numbered. Does not
block and does not deliver events.

## Actions

```ts
type Action =
  | { say: string }
  | { move: (Spot | { to: "end" | "file_start" | "file_end" } | { lines: number } | {})
            & { file?: string } }
  | { select: Span }
  | { type: [before: string, after: string] }
  | { type_fast: [before: string, after: string] }
  | { delete: true }
  | { point: Span & { file?: string } }
  | { run: string, wait?: number }
```

Each action is an object with exactly one of these keys. Anything else is
rejected, including two actions in one object (`{ move: …, type: … }`): they
are separate actions, played in order.

Each editing action (`type`, `type_fast`, `delete`) is **one undo stop** in the
programmer's undo stack, not one per character. If the programmer undoes an
agent action, that is an edit like any other (and interrupts).

### `say`

Shows the text as the current message in the narration panel. It stays current
until the next `say`, then moves into the history. Inline code in backticks is
rendered as code.

After a `say`, playback **pauses for a reading time** proportional to the
message length, so the programmer can read most of it before the actions it
describes begin.

Keep messages short: one to three sentences. Split longer explanations across
batches.

### `move`

Moves the agent cursor. If `file` is given, switches to that file (opening it
if needed, and creating it empty if it doesn't exist); otherwise the move is
in the current file. Clears any selection. The cursor goes to one of:

- a **spot**: the place between `before` and `after`, two texts that occur
  together, exactly (see [Anchors](#anchors)).
  `{ before: "import { ", after: "type Context" }` lands right before
  `type Context`.
- `to: "end"`: the end of the cursor's line. It's how the agent steps past
  the closing end of a pair it has filled.
- `to: "file_start"` or `"file_end"`.
- `lines: n`: n lines down (negative: up) from the agent cursor, to the end of
  that line, like arrow keys.

With only `file`, the cursor goes to the start of that file. Anything else,
such as a spot with only `before`, or both a spot and `to`, is rejected.

### `select`

Selects the anchor's match, or the range from the start of `from` to the end
of the first match of `to` after it. Rendered as a visible agent selection.
The cursor ends at the end of the selection.

### `type` and `type_fast`

Types `[before, after]` at the agent cursor, replacing the selection if there
is one: first `before`, then `after`, then the cursor steps back to between
them. It's how a pair is typed with both its ends before its contents:

```jsonc
{ "type": ["update(", ")"] }   // update(|)
{ "type": ["ctx, dt", ""] }    // update(ctx, dt|)
```

The step back plays like a move nearby, with its pause. When `after` is
empty, there's nothing to step back over, and no pause.

- `type` is the default: for anything the programmer should read and
  understand. It plays at a human-like pace.
- `type_fast` is for boilerplate the programmer doesn't need to read:
  `public static void Main`, closing braces, imports. It plays several times
  faster, but changes only the speed: blocks are still closed before their
  bodies are typed.

Text is inserted **literally**: no auto-closing brackets, no auto-indent, no
completions. The agent must include indentation itself. Newlines are
inserted as the document's line ending (LF or CRLF) as the editor reports it,
which it does even for an empty file.

### `delete`

Deletes the current selection. Fails if there is no selection. (To delete, the
agent selects first, which makes deletions visible before they happen.)

### `point`

Highlights a range without editing it and without moving the agent cursor,
for talking about code: "this function is called from two places…". The
highlight persists until the next `point` or the next editing action.

**Point, then say.** During the agent's turn, the view follows the pointed
code, switching to its `file` if needed, so the `say` right after it plays
while the programmer is looking at it. The next action at the cursor (`move`,
`select`, `type`, `type_fast`, `delete`) brings the view back to the cursor;
`say` and `run` don't. If the pointed code was in another file or far from
the cursor, that return pauses like a far move before the action.

During the programmer's turn, the view never switches; the narration panel
shows a clickable reference instead.

### `run`

Runs a shell command in an integrated terminal the programmer can see, in the
agent's working directory. For commands whose outcome the programmer should
witness: tests, builds, starting the app, a request to it. Purely mechanical
commands can still run in the background with the agent's native tools.

- **Confirmation.** By default the narration panel asks the programmer to
  allow each command first (the `aiPair.confirmCommands` setting), or to allow
  that exact command for the rest of the session. Declining fails the batch
  with `command_declined`. Without this, `run` would bypass
  the harness's own permission prompt for shell commands.
- **Waiting.** Playback waits for the command to finish, for at most `wait`
  seconds (default 120, at most 600). A command still going after that, such
  as a server or a watcher, is reported with `running: true` and keeps
  running in its terminal.
- **Result.** The batch's report shows each `run`: the exit code, the last
  ~12,000 characters of output as plain text, and the terminal's shell
  (`pwsh`, `zsh`, …) so the agent can write commands for it.
- **Failure.** A nonzero exit fails the batch with `command_failed`, since the
  rest of the batch, and the next one, were planned assuming success. A `run`
  counts as played once its command has started, so it is never returned as
  unplayed; the same holds when the programmer interrupts while it runs:
  playback stops waiting, and the command keeps running.
- The output needs shell integration in the terminal. Without it, the command
  is typed into the terminal and the entry says the output wasn't captured.
- Not allowed during the programmer's turn.

## Anchors

Locations are identified by **exact text**. `select` and `point` take an
anchor, the text itself; `move` takes a spot, the place between two texts.

```ts
type Anchor = {
  text: string                  // exact match, may span lines
  near_line?: number            // tie-breaker: the match closest to this line
}

type Spot = {
  before: string                // exact text right before the spot
  after: string                 // exact text right after it; either may be empty, not both
  near_line?: number
}

type Span = Anchor | { from: Anchor, to: { text: string } }  // `to`: its first match after `from`
```

Resolution:

1. Find all exact matches of `text`, or of `before + after` together.
2. Exactly one match: done.
3. Several matches: if `near_line` is given, pick the match closest to that
   line.
4. Otherwise the action fails with `anchor_not_found` or `anchor_ambiguous`,
   listing candidates (line number plus a line of context).

The way to avoid ambiguity is a longer text: a whole line, or a spot with
context on both sides. Line numbers are poor addresses (the programmer's edits
shift them) but acceptable tie-breakers: a hint that is off by a few lines
still selects the right match.

## Reports

A report is **text**, written for the agent to read: code appears as numbered
lines, not as JSON strings full of escapes. It says, in order:

1. **What the programmer did** since the last report: the [events](#events).
2. **Each batch that finished** since the last report, in order: its id and
   status, and
   - **its code**: the lines it changed, as they read when it ended, from the
     first changed line to the last, extended to the cursor's line, with the
     agent cursor marked `▌`. A batch that only moved shows the cursor's line;
     one that only said something shows no code. Long code skips lines in the
     middle. This is how the agent checks that the batch did what it meant,
     in the place it meant, even when it `completed`.
   - the commands it ran, with their exit code and output,
   - for a failed batch, the error, with candidates for an ambiguous anchor,
   - **what didn't play**, verbatim, one action per line, ready to resubmit.
     An interrupted action comes first, reduced to what it didn't do yet; a
     failed batch's failing action comes first.
3. **The batch this `step` submitted**, if it hasn't finished: playing or
   queued.
4. **The agent cursor**, only when it isn't where the agent last saw it in a
   report, e.g. because the programmer's edits moved it.
5. Whether the call returned because `MAX_BLOCK` elapsed, whether it's the
   programmer's turn, and whether the session has ended.

For example, a batch interrupted by a message, and the batch queued behind it:

```
The programmer said:
> use zod for validation

Batch 6 interrupted, in src/server.ts:
13    const title = req.body.title;
14    res.sta▌
Not played:
  {"type":["tus(",")"]}
  {"type":["201",""]}

Batch 7 discarded.
Not played:
  {"say":"Now the GET route."}
```

**Anchors ignore the cursor marker**, so text can be copied from a report's
code as it is.

**What counts as played.** A `say` counts once it's shown, even if its
reading pause is cut short. A `move` or `select` counts once the cursor has
moved. A `run` counts once its command has started. A batch interrupted
before any of its actions had a visible effect is reported as `discarded`.

**A cut-off `type`** leaves what it typed in the buffer, and comes back
reduced to the rest: cut in `before`, it's the rest of `before`, then `after`,
which finishes it exactly. Cut in `after`, it's `["", rest of after]`, which
restores the text but leaves the cursor as many characters past the inside of
the pair as `after` had typed; the code shows where the cursor is.

Internally, the editor produces a structured report, which the relay renders:

```ts
type Report = {
  batches: BatchResult[]      // finished since the last report, in order
  submitted?: { id: number, status: "queued" | "playing" }  // step only, while unfinished
  events: Event[]             // since the last report, in order
  turn: "agent" | "user"
  cursor?: Code               // only when it isn't where the agent last saw it
  waiting?: true              // returned due to MAX_BLOCK
}

type BatchResult = {
  id: number
  status: "completed" | "interrupted" | "failed" | "discarded"
  code?: Code
  error?: {                   // for a command's failure, about its `run`; else the first unplayed action
    kind: "anchor_not_found" | "anchor_ambiguous" | "no_selection" | "no_file"
        | "not_your_turn" | "invalid_action" | "command_failed" | "command_declined"
    message: string
    candidates?: { line: number, context: string }[]
  }
  unplayed?: Action[]
  runs?: {                    // one per `run` that started
    command: string
    exit_code?: number        // absent while running, or if it couldn't be observed
    output: string            // plain text, the tail if long
    truncated?: true
    running?: true            // still running in its terminal
    shell?: string
  }[]
}

type Code = {                 // the cursor marked with ▌ in its line
  file: string
  lines: { number: number, text: string }[]
}
```

## Events

```ts
type Event =
  | { kind: "message", text: string, selection?: Excerpt }
  | { kind: "edit", file: string, diff: string }
  | { kind: "interrupt" }
  | { kind: "turn", to: "agent" | "user", message?: string, selection?: Excerpt }
  | { kind: "end" }

type Excerpt = {              // code the programmer had selected
  file: string
  from: { line: number, column: number }
  to: { line: number, column: number }
  text: string                // cut off at 8,000 characters
  truncated?: true
}
```

During the agent's turn, **every event interrupts**: it stops playback and
triggers the no-stale-plans rule. This includes any edit by the programmer,
anywhere. (A finer rule, such as only edits near the agent cursor, may come
later.)

- `message`: the programmer sent a message from the narration panel. If they
  had code selected in the editor, it comes along as `selection`, unless they
  dismissed it in the panel: "what does this do?" is about that code.
- `interrupt`: the Interrupt button.
- `turn`: see [Turns](#turns).
- `edit`: the programmer changed a file. Edits are coalesced per file into a
  single diff per report.
- `end`: the programmer ended the session. Playback stops and the session is
  over: this is its final report, and further calls fail with `no_session`.

Pause is not an event; see [Pause and follow mode](#pause-and-follow-mode).

## Turns

Turns change only explicitly.

**Programmer takes the turn** ("My turn" button). This interrupts playback.
The agent receives `{ kind: "turn", to: "user" }`.

**During the programmer's turn**, the agent is the navigator:

- It may only `say` and `point`. Any other action fails with `not_your_turn`.
- It calls `listen` to follow along. `listen` returns on a message, on the turn
  change back, or when the programmer has made edits and then paused typing
  for a few seconds (*tunable*), so the agent can comment as a navigator
  would ("you'll want to handle the empty case there").

**Programmer hands the turn back** ("Your turn" button, optionally with a
message). The agent receives the programmer's edits since the last report and
`{ kind: "turn", to: "agent", message? }`.

## Files, saving, and native tools

- Files the agent edits via the protocol are **saved automatically** when a
  batch completes, so that tools reading from disk (tests, compilers, the
  agent's native file tools) see the current state.
- The agent may still use its native file tools. The rule is: anything the
  programmer should follow goes through the protocol; purely mechanical changes
  (generated files, lockfiles, bulk renames) may be done natively, announced in
  one `say`.
- The extension makes changes outside the protocol visible to the programmer,
  so a slip never goes unnoticed.
- The agent should not natively edit files that have unsaved changes in the
  editor; `read` reports `dirty` for this reason.
- **Terminal commands** that matter to the programmer go through `run`, so
  they see the command and its output. Background commands run with the
  agent's native tools; the protocol doesn't show them, so the agent narrates
  them instead: `say` what it's about to run and why, and `say` what came out
  of it afterwards.

## Guidance for the agent

How the agent should use this protocol to give the programmer a good
experience (order of work, narration, background vs. visible work) is in
[AGENT_GUIDE.md](AGENT_GUIDE.md), which `start` returns to the agent.

## Examples

### Normal flow

```
→ step
[{ "say": "Let's add the POST handler. Signature first." },
 { "move": { "file": "src/server.ts", "before": "app.use(express.json());", "after": "\n" } },
 { "type": ["\n\napp.post('/todos', async (req, res) => {\n", "\n});"] }]
← returns immediately
Batch 1 is playing.

→ step (blocks until batch 1 finishes)
[{ "say": "We need a title from the body." },
 { "type": ["  const title = req.body.title;", ""] }]
←
Batch 1 completed, in src/server.ts:
4  app.use(express.json());
5
6  app.post('/todos', async (req, res) => {
7  ▌
8  });

Batch 2 is playing.
```

### Interrupt mid-typing

```
Batch 2 is playing; the agent has already submitted batch 3 and is blocked.
The programmer replies in the narration panel: "use zod for validation".
← step returns immediately
The programmer said:
> use zod for validation

Batch 2 interrupted, in src/server.ts:
7    const ti▌
Not played:
  {"type":["tle = req.body.title;",""]}

Batch 3 discarded.
Not played:
  {"say":"..."}
  {"type":["...",""]}

→ step
[{ "select": { "text": "  const ti" } },
 { "say": "Good call. Let me define a schema instead." },
 { "delete": true }, ...]
```

### Ambiguous anchor

```
← report
Batch 7 failed, in src/server.ts:
18  ▌
anchor_ambiguous: 2 matches for "  return res.json("; make it longer to be unique, or add near_line
  line 12: return res.json(todos);
  line 31: return res.json(todo);
Not played, starting with the one that failed:
  {"move":{"before":"  return res.json(","after":""}}
  ...
```

### Turn handoff

```
Programmer presses "My turn".
← The programmer took the turn.

  It's the programmer's turn: you're the navigator. ...
→ listen
... programmer writes a loop, pauses typing ...
← The programmer edited src/server.ts:
  @@ -20,2 +20,4 @@
  ...
→ step
[{ "point": { "text": "for (let i = 0; i <= todos.length; i++)" } },
 { "say": "Careful: `<=` will go one past the end." }]
→ listen
... programmer fixes it, presses "Your turn" ...
← The programmer edited src/server.ts:
  ...
  The programmer handed the turn back to you:
  > ok, finish the handler
```

## Open questions

- **Navigator reporting.** How eagerly should `listen` report the programmer's
  edits during their turn? Too eager is noisy and costly; too lazy makes the
  navigator useless.
- **Sharing context.** Messages carry the programmer's selection. Sharing the
  cursor alone (no selection: "here") is still open.
- **Interrupting edits.** Every edit interrupts for now. If that turns out too
  disruptive (e.g. fixing a typo in another file), narrow it to edits near the
  agent cursor or the region the current batch touched.

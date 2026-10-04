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
| `failed`      | An action could not be performed (e.g. a command exited nonzero).    |
| `discarded`   | Never started, because an earlier batch didn't complete or an interrupting event arrived first. |

Rules:

- **Rejection.** A batch that would fail, as far as the extension can tell
  when it's submitted (text that isn't on its line, a malformed action, a
  second file, an edit during the programmer's turn), is **rejected**: `step` returns at once
  with the action that would fail, the error, and the code as it would read
  then. Nothing of it is queued, and the batches queued before it are
  unaffected.
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
- **Places resolve at play time.** Places and spans in a batch are resolved
  when the action plays, not when the batch is submitted. A batch may therefore refer to
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

### `start(task?: string, cwd?: string) -> Report`

Starts a session in the editor window for the current project. `task` is a
short description shown in the narration panel. `cwd` is the agent's working
directory, absolute: the agent should always give it, since not every harness
starts the MCP server there. Without it, or if no editor window has it open,
the harness's MCP roots and then the server's own working directory are tried.
Fails if a session is already active in that window, or if no editor window
has the project open.

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

**A batch works in one file.** It may name a file (in `move`, `select` or
`point`) only before its first edit, and all the files it names must be the
same one. So every batch edits exactly one file, and its report shows one
piece of code. A batch that breaks this is rejected, like any batch that
would fail, with `invalid_action` at the action that names a second file.

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

Returns the contents of a file **as the agent's batches will leave it**: the
editor buffer, including unsaved changes, with what the playing and queued
batches will still type already in it (as they played in memory when they
were queued). So its line numbers are the ones the next batch starts from.
After an interruption, until it's reported, it's just the buffer: the
batches queued behind the interruption won't play. Falls back to disk for
files that aren't open. The result is the
file's name, whether it has unsaved changes, and its lines, numbered. Like a
report's code, it says where the lines reach the end of the file, and whether
a newline ends its last line. Does not block and does not deliver events.

## Actions

```ts
type Action =
  | { say: string }
  | { move: Place }
  | { select: Span }
  | { type: string }          // with one ▌: where the cursor ends
  | { type_fast: string }
  | { delete: true }
  | { point: Span }
  | { run: string, wait?: number }
```

Each action is an object with exactly one of these keys. Anything else is
rejected, including two actions in one object (`{ move: …, type: … }`): they
are separate actions, played in order.

`move`, `select` and `point` say where they act the same way, as a
[place or a span](#places) on a line.

Each editing action (`type`, `type_fast`, `delete`) is **one undo stop** in the
programmer's undo stack, not one per character. If the programmer undoes an
agent action, that is an edit like any other (and interrupts).

### `say`

Shows the text as the current message in the narration panel. It stays current
until the next `say`, then moves into the history. Inline code in backticks is
rendered as code.

After a `say`, playback **pauses for a reading time** proportional to the
message length, so the programmer can read it before the actions it describes
begin.

Keep messages short: one to three sentences. Split longer explanations across
batches.

### `move`

Moves the agent cursor to a [place](#places): a spot, `at`, the exact text
around it with the cursor marker `▌` where the cursor goes, or `to:
"line_end"`, the end of the line, before its newline.
`{ line: 3, at: "import { ▌type Context" }` lands right before
`type Context`, on line 3. It's the marker reports use for the cursor, so a
spot reads the way a report shows the cursor there.

A move to a `file` that doesn't exist creates it, empty. A move clears any
selection. Without `line`, it's on the cursor's line: that's how the agent
steps past a close it just typed without knowing its line's number.

### `select`

Selects a [span](#places), rendered as a visible agent selection: its `text`,
or the range `from` one text `through` the first match of another after it.
The cursor ends at the end of the selection, in the span's file.

### `type` and `type_fast`

Types the text at the agent cursor, replacing the selection if there is one.
The text marks where the cursor ends with `▌`: everything is typed, the text
before the `▌` and then the text after it, and the cursor steps back to the
`▌`. It's how something with a close is typed with its close before its
contents:

```jsonc
{ "type": "update(▌)" }   // update(▌)
{ "type": "ctx, dt▌" }    // update(ctx, dt▌)
```

The text has exactly one `▌`, even when nothing follows it, so a literal `▌`
can't be typed. The step back plays like a move nearby, with its beat before
and its pause after. With nothing after the `▌`, there's nothing to step back
over, and no pause.

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

Highlights a [span](#places), as `select` takes it, without editing it and
without moving the agent cursor, for talking about code: "this function is
called from two places…". The highlight persists until the next `point` or
the next editing action.

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

## Places

`move` goes to a **place**, and `select` and `point` take a **span** of code.
Both are found by **exact text, on a line**:

```ts
type Place = {
  file?: string
  line?: number     // the line the cursor lands on, exactly; omitted: the cursor's line
  at?: string       // a spot: the exact text around it, with one ▌ where the cursor goes; may span lines
  to?: "line_end"   // instead of `at`: the end of the line
}

type Span = {
  file?: string
  line?: number     // the line the code starts on, exactly; omitted: the cursor's line
  text?: string     // the code's exact text; may go on past its line
  from?: string     // instead of `text`, a range: from this text, on the line,
  through?: string  //   through the first match of this one after it
}
```

- **`file`** switches to that file, only before the batch's first edit (see
  [`step`](#stepactions-action---report)). Without it, the action is in the
  cursor's file.
- **`line`** is exact. Lines are numbered as `read` and reports show them: a
  newline at the end of a file doesn't start another line, and an empty file
  has one, line 1. A line the file doesn't have fails with `no_line`. Without
  `line`, it's the cursor's line, which needs the cursor to be in the file.
- **The text** must be on the line (a span's text or `from` must start on
  it) and occur there only once. It only has to be unique on its line, so a
  spot can be as short as `"}▌"`. Text that isn't on the line fails with
  `not_found`, saying what the line reads and listing the lines where the text
  does occur; text that occurs more than once on it fails with `ambiguous`.
  A `through` that doesn't follow `from` fails with `not_found` too.

The line is exact because text alone can match somewhere the agent didn't
mean: a closing brace one block too far. Giving the line the agent read the
code at turns that slip into an error it sees at once. The agent takes line
numbers only from `read` and reports, never counts them; that's why an action
on the cursor's line needs none.

**Only numbers the agent has been shown.** A line number worked out instead
of read is easily off, and with `to: "line_end"` nothing would catch it. So a
`line` must be the number the agent was last shown that line at, and the line
must still be there: nothing since may have added or removed lines above it,
whether its own batches, earlier in the same batch or queued before it, the
programmer, or anything else. Lines are shown by `read`, by a report's code
and cursor, and by errors that list lines; not by edit diffs, whose line
numbers would have to be counted. A change to the line itself doesn't matter,
only its number. Line 1 of an empty file needs no showing.

An action on any other line is rejected with `line_not_seen`, saying what the
line reads now, and the lines where its text is. Those count as shown, so the
agent can fix the batch without a `read`.

**Text copied from a report** may carry the cursor marker. A span ignores it.
In a spot, `▌` is where the cursor goes, so text copied into `at` leaves the
report's old `▌` out.

## Reports

A report is **text**, written for the agent to read: code appears as numbered
lines, not as JSON strings full of escapes. It says, in order:

1. **What the programmer did** since the last report: the [events](#events).
2. **Each batch that finished** since the last report, in order: its id and
   status, and
   - **its code**: the lines it changed, as they read when it ended, from the
     first changed line to the last, extended to the cursor's line, with the
     agent cursor marked `▌`, and 3 lines of context above and below. A batch
     that only moved shows the cursor's line, with its context; one that only
     said something shows no code. Long code skips lines in the middle. This
     is how the agent checks that the batch did what it meant, in the place it
     meant, even when it `completed`.

     Where the code reaches the end of the file, it says so, and whether a
     newline ends the file's last line. A newline at the end of the file isn't
     shown as an empty line after the last one, unless the cursor is there, so
     an empty line shown at the end is a blank line in the file.
   - the commands it ran, with their exit code and output,
   - for a failed batch, the error, with the lines where the text it looked
     for is,
   - **what didn't play**, verbatim, one action per line, ready to resubmit.
     An interrupted action comes first, reduced to what it didn't do yet; a
     failed batch's failing action comes first.
3. **The batch this `step` submitted**, if it hasn't finished: playing or
   queued. Or, if it was rejected, the action that would fail, the error, and
   the code as it would read then.
4. **The agent cursor**, only when it isn't where the agent last saw it in a
   report, e.g. because the programmer's edits moved it.
5. Whether the call returned because `MAX_BLOCK` elapsed, whether it's the
   programmer's turn, and whether the session has ended.

For example, a batch interrupted by a message, and the batch queued behind it:

```
The programmer said:
> use zod for validation

Batch 6 interrupted, in src/server.ts:
10  app.use(express.json());
11
12  app.post('/todos', (req, res) => {
13    const title = req.body.title;
14    res.sta▌
15  });
16
17  app.listen(3000);
    (end of file)
Not played:
  {"type":"tus(▌)"}
  {"type":"201▌"}

Batch 7 discarded.
Not played:
  {"say":"Now the GET route."}
```

**What counts as played.** A `say` counts once it's shown, even if its
reading pause is cut short. A `move` or `select` counts once the cursor has
moved. A `run` counts once its command has started. A batch interrupted
before any of its actions had a visible effect is reported as `discarded`.

**A cut-off `type`** leaves what it typed in the buffer, and comes back
reduced to the rest, with its `▌` where it was: cut before the `▌`, it's the
rest of the text before it, then the `▌` and all that follows it, which
finishes it exactly. Cut after the `▌`, it's `▌` and the rest after it, which
restores the text but leaves the cursor as many characters past the inside of
the pair as had been typed after the `▌`; the code shows where the cursor is.

Internally, the editor produces a structured report, which the relay renders:

```ts
type Report = {
  batches: BatchResult[]      // finished since the last report, in order
  submitted?: { id: number, status: "queued" | "playing" }  // step only, while unfinished
  rejected?: {                // step only: the batch wasn't queued, because it would fail
    index: number             // of the action that would fail, from 1
    action: Action
    error: BatchError
    code?: Code               // how the code would read then
  }
  events: Event[]             // since the last report, in order
  turn: "agent" | "user"
  cursor?: Code               // only when it isn't where the agent last saw it
  waiting?: true              // returned due to MAX_BLOCK
}

type BatchResult = {
  id: number
  status: "completed" | "interrupted" | "failed" | "discarded"
  code?: Code
  error?: BatchError          // for a command's failure, about its `run`; else the first unplayed action
  unplayed?: Action[]
  runs?: {                    // one per `run` that started
    command: string
    exit_code?: number        // absent while running, or if it couldn't be observed
    output: string            // plain text, the tail if long
    truncated?: true
    running?: true            // still running in its terminal
    shell?: string
  }[]
  unsaved?: { file: string, error: string }[]  // edited files that couldn't be saved
}

type BatchError = {
  kind: "no_line" | "not_found" | "ambiguous" | "line_not_seen" | "no_selection" | "no_cursor"
      | "not_your_turn" | "invalid_action" | "command_failed" | "command_declined"
      | "save_failed"
  message: string
  candidates?: { line: number, context: string }[]
}

type Code = {                 // the cursor marked with ▌ in its line
  file: string
  lines: { number: number, text: string }[]
  end?: { final_newline: boolean }  // when the lines reach the end of the file
}
```

## Events

```ts
type Event =
  | { kind: "message", text: string, selection?: Excerpt }
  | { kind: "edit", file: string, diff: string, by: "programmer" | "other" }
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
anywhere. The one exception is a change the programmer didn't make (an edit
`by: "other"`) to a file no playing or queued batch edits: it's reported,
without interrupting. (A finer rule for the programmer's edits, such as only
edits near the agent cursor, may come later.)

- `message`: the programmer sent a message from the narration panel. If they
  had code selected in the editor, it comes along as `selection`, unless they
  dismissed it in the panel: "what does this do?" is about that code.
- `interrupt`: the Interrupt button.
- `turn`: see [Turns](#turns).
- `edit`: a file changed. Edits are coalesced per file into a single diff per
  report. `by` says whether the programmer made them, or something else did: a
  tool or a command writing to disk (including the agent's own), or a
  formatter when the file is saved. A diff with any edit by the programmer is
  theirs. A change by others to a file the playing or queued batches edit
  interrupts, since they were planned against the text before it: a
  formatter when a batch saves, say. Changes by others to any other file
  don't interrupt, and don't make `listen` return.
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
  batch ends, and before each `run`, so that tools reading from disk (tests,
  compilers, the agent's native file tools) see the current state.
- A save can fail, when the file changed on disk meanwhile, say. The buffer
  still has the agent's edits, but the file on disk doesn't: the batch's
  report says which files it couldn't save (`unsaved`), and a `run` after such
  a save doesn't run, failing the batch with `save_failed`, since the command
  would read the old file. The agent doesn't overwrite the other version: it
  asks the programmer to resolve it in the editor, which offers to compare the
  two or overwrite, and resubmits the `run` after.
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
 { "move": { "file": "src/server.ts", "line": 4, "at": "app.use(express.json());▌" } },
 { "type": "\n\napp.post('/todos', async (req, res) => {\n▌\n});" }]
← returns immediately
Batch 1 is playing.

→ step (blocks until batch 1 finishes)
[{ "say": "We need a title from the body." },
 { "type": "  const title = req.body.title;▌" }]
←
Batch 1 completed, in src/server.ts:
 1  import express from 'express';
 2
 3  const app = express();
 4  app.use(express.json());
 5
 6  app.post('/todos', async (req, res) => {
 7  ▌
 8  });
 9
10  app.listen(3000);
    (end of file)

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
  {"type":"tle = req.body.title;▌"}

Batch 3 discarded.
Not played:
  {"say":"..."}
  {"type":"...▌"}

→ step
[{ "select": { "text": "  const ti" } },
 { "say": "Good call. Let me define a schema instead." },
 { "delete": true }, ...]
```

### A spot on the wrong line

```
→ step
[{ "say": "Now the response." },
 { "move": { "line": 30, "at": "  return res.json(▌" } }, ...]
← returns immediately
Your batch was rejected: its action 2 would fail:
  {"move":{"line":30,"at":"  return res.json(▌"}}
not_found: The spot isn't on line 30: line 30 reads "  const todo = findTodo(id);". It's on these lines:
  line 12: return res.json(todos);
  line 31: return res.json(todo);
The code would read then, in src/server.ts:
18  ▌
Nothing of it was queued. Fix it and submit the whole batch again.
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
→ read src/server.ts, from line 20: the loop is on line 21
→ step
[{ "point": { "line": 21, "text": "for (let i = 0; i <= todos.length; i++)" } },
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

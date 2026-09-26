# Extension Design

How the extension looks and behaves for the programmer. The contract with the
agent is in [PROTOCOL.md](PROTOCOL.md), and the components and how they
connect are in [ARCHITECTURE.md](ARCHITECTURE.md). This document covers what
the programmer experiences.

Status: **draft**. Numbers marked *tunable* are initial guesses to be adjusted
by feel.

## Agent cursor

Rendered with decorations: a thin vertical bar in the agent's color, plus a
small name label. The agent's selection gets a background in the same color;
`point` highlights get a softer, distinct background.

The cursor's appearance shows the agent's state:

| State     | When                                               | Appearance                  |
|-----------|----------------------------------------------------|-----------------------------|
| typing    | playing `type`, `type_fast`, `move`, `select`, `delete` | agent color            |
| read      | reading pause after `say`                          | accent color, pulsing       |
| thinking  | queue empty, agent hasn't called yet               | dimmed                      |
| paused    | playback paused                                    | dimmed, pause marker        |
| listening | agent is in `listen`                               | outline only                |
| navigator | programmer's turn                                  | outline only, name label    |

The **read** state is the important one: it tells the programmer to look at the
narration panel. Decorations can't animate, so the pulse is done by swapping
decoration types on a timer.

Colors are contributed as theme colors, so themes and users can override them.

## Narration panel

A webview in the secondary side bar (right), so its top lines up with the top
of the editor. Some eye travel is acceptable, since the cursor's color change
and the reading pause lead the eye there, but the current message must be
highly visible and nothing in the panel may move unexpectedly.

Layout, top to bottom:

1. **Controls and reply box.** A status line of its own (so its changing text
   never moves anything), then Pause/Resume, Interrupt, My turn / Your turn,
   End. The status line also holds the Slow / Normal / Fast toggle,
   right-aligned so the status text never moves it. The reply box is slim and
   low-contrast until focused, so it doesn't compete with the message. These
   sit above the message so their position never changes.
2. **Current message.** Large text (≈1.4× the editor font, *tunable*), high
   contrast. Its **top edge is fixed**; its height grows downward with the
   message length. A new message briefly flashes in, in sync with the cursor's
   read state.
3. **Reading-pause bar** along the bottom edge of the current message. It fills
   during the reading pause, so the pause feels intentional, and is hidden
   otherwise.
4. **History**, newest first, in smaller, muted text. Besides the agent's
   messages it shows the programmer's replies, turn changes, interrupts, and
   changes made outside the protocol. File references are clickable.

Behavior:

- **Typing in the reply box pauses playback**, the way a pair stops when you
  start talking. Clearing it resumes. Sending the reply delivers a `message`
  event (which interrupts) and ends any pause, so the agent's answer plays
  right away. (Pausing on focus alone would leave playback paused after
  sending, while the box still has focus.)
- With text in the reply box, "Your turn" hands back the turn with it as the
  message.
- **Sharing a selection.** While the programmer has code selected in the
  editor, a line under the reply box says *With selection
  `src/server.ts:12–18`*: the reply (or "Your turn") takes the selection
  along. × leaves it out; the next selection brings the line back. The
  selection is sent once. *Ask the Agent About the Selection* in the editor's
  context menu focuses the reply box.
- **Commands.** When the agent plays a `run`, a box under the current message
  shows the command with **Run**, **Allow for session** (the same command
  won't ask again until the session ends) and **Skip** (unless
  `aiPair.confirmCommands` is off), with the cursor in its read state. The
  command then runs in an *AI Pair* terminal, revealed without taking focus,
  and the history records its exit code.
- The command *AI Pair: Reply to the Agent* focuses the reply box from the
  editor; bind it to a key of your choice.
- During the programmer's turn the panel shows "Your turn" prominently; the
  agent's comments appear as the current message as usual.

## Playback

### Timing

Every number lives in one place, [`timing.ts`](packages/core/src/timing.ts),
for calibration. The `aiPair.timing` setting overrides any of them without a
rebuild. All are milliseconds at normal speed (*tunable*).

**Typing.** Quick within words, a small pause as each word starts, longer
after punctuation, brackets and newlines, the way people actually type:

| Moment                                               | Pause          |
|------------------------------------------------------|----------------|
| between characters within a word                     | 55, ±25%       |
| extra as a word starts (non-alphanumeric → alphanumeric) | +110       |
| extra after `,` `;` `:`                              | +90            |
| extra after an opening `(` `[` `{`                   | +70            |
| extra after a newline                                | +350           |
| leading indentation                                  | instant        |

`type_fast` plays the same rhythm at a quarter of the delays. Leading
indentation appears instantly because that's what the programmer's own editor
would do; watching spaces being typed is noise.

**Cognitive switches.** The pause comes *after* a change, so the programmer
can take it in before anything happens there:

| After…                                           | Pause | Why                          |
|--------------------------------------------------|-------|------------------------------|
| a move within 15 lines in the same file          | 450   | eyes find the cursor again   |
| a move farther, or to another file               | 900   | the view changed: re-orient  |
| a selection appears                              | 700   | read what's about to change  |
| a deletion                                       | 300   | register what's gone         |
| a `point` highlight                              | 400   | find the highlighted code    |

Plus a 150 ms beat *before* a move or a selection, so it doesn't look
instantaneous.

When a `type` has two parts, the cursor steps back between them after typing
both: the pause of a nearby move, without the beat before it, since the
programmer just watched that spot being typed. `type_fast` shortens the pause
by the same factor as its typing. With nothing in the second part, the cursor
is already in place and there's no pause.

**Reading.** After a `say`: `clamp(words × 180, 1000, 6000)`. Enough to read
most of the message, not all of it.

**Speed.** The panel's Slow / Normal / Fast (0.6×, 1×, 1.6×) scales all of it
together, immediately, even mid-typing. It's the `aiPair.speed` setting.

### Undo

Each editing action is one undo stop: characters are applied as successive
edits without undo stops between them, with stops at the action's boundaries.

### Follow mode

During the agent's turn:

- The view follows the agent cursor across files.
- The agent cursor is kept in the **upper third of the viewport**, so it sits
  roughly level with the narration panel's current message. The view scrolls
  only when the cursor leaves a comfortable band, not on every keystroke.
- Playback **pauses automatically** when the programmer switches to another
  editor or scrolls the agent cursor out of view. Scrolling caused by follow
  mode itself is ignored.
- **Resume always brings the view back to the agent cursor** first, then
  playback continues.

### Saving

Files edited through the protocol are saved when a batch completes.

## Changes outside the protocol

Files that change on disk without going through the protocol (the agent's
native tools, or anything else) are marked:

- a badge on the file in the explorer,
- an entry in the narration history ("`package.json` changed outside the
  editor") with a link to the diff.

The mark clears when the programmer opens the file or the diff. The extension
can't tell the agent's native edits from other tools (git, formatters), so the
wording stays neutral.

## Open questions

- **Setup flow.** Discovery file vs. a command that writes the harness's MCP
  config directly. How to make the first run trivial.
- **Panel placement.** Secondary side bar by default; is it wide enough for
  large text, or should the panel be an editor-group webview?
- **Type-to-pause.** Does pausing when the programmer starts typing a reply
  feel natural, or does it surprise?
- **Bulk changes outside the protocol.** A bulk rename marks many files at
  once; the history entry should probably group them.

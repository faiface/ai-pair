# Extension Design

How the extension looks and behaves for the programmer. The contract with the
agent is in [PROTOCOL.md](PROTOCOL.md), and the components and how they
connect are in [ARCHITECTURE.md](ARCHITECTURE.md). This document covers what
the programmer experiences. It describes VS Code; the JetBrains plugin follows
the same design, and where it differs is in
[In JetBrains IDEs](#in-jetbrains-ides) at the end.

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
The agent's color and the read color differ clearly in every kind of theme, so
the pulse is visible, and so is the difference between a selection and a
`point`. The name label's text has its own pair of colors, one for each
color the label takes, like a badge's foreground: dark on the bright colors of
dark themes, white on light themes' deeper orange.

## Narration panel

A webview in the secondary side bar (right), so its top lines up with the top
of the editor. Some eye travel is acceptable, since the cursor's color change
and the reading pause lead the eye there, but the current message must be
highly visible and nothing in the panel may move unexpectedly.

Layout, top to bottom:

1. **The band**, a full-width area on the editor's background, holding
   everything about now:
   - **Its header**: the agent's state (a colored dot and a few words: *Agent
     is typing*, *Read this*, *Needs you*, *Your turn*), and the controls,
     compact and quiet, as icons without fills: Pause/Resume, Interrupt, My
     turn, the speed, End. During the programmer's turn, Pause and Interrupt
     give way to Hand back, the one labeled control, since it's the main
     action then. The speed opens a menu of 0.4× to 3.0×. The agent's color
     is on the dot only, never on the controls.
   - **The current message**, in large text (≈1.3× the editor font,
     *tunable*), high contrast. Its **top edge is fixed**, right under the
     header; its height grows downward with the message length. A new message
     fades in, in sync with the cursor's read state. It stays at full
     strength while paused, since a pause is often for reading it. The code
     the agent pointed at before it is linked under it.
   - **The reading pause** fills a thin ring around the status dot, so the
     pause feels intentional, while the dot takes the read color. The ring's
     rest is the same color, faded. Otherwise
     the dot shows no ring. In the read state after it, the dot breathes
     slowly. One cue, in one place, right above the message: no flash, no bar.
   - **A command to allow**, when the agent plays a `run` (see Commands).
   - **The reply box**, under the message. It's where the eye goes after
     reading, which is when the programmer replies. The band has room for
     two lines of message, so the reply box moves only for a longer one.
2. **History**, below the band, newest first. The agent's messages in muted
   text; the programmer's replies as neutral bubbles on the right; commands
   as soft terminal rows with their outcome (✓ exit 0, ✕ exit 1, skipped,
   still running, which changes to how it ended when it does); turn changes,
   interrupts and session starts and ends as faint dividers.

Without a session, the band has no header: it says there's no session and
how to start one, and after a session, how it ended, with the agent's
summary. In every message, code spans that name a file (`game.ts`,
`src/server.ts`) open it, found by name if it isn't a path from the
workspace's root, and URLs open in the browser. File and code references are
mono and quietly underlined, taking the link color only on hover.

**The panel follows whatever theme is set**, today's or a future one, without
knowing any theme. Every color is one of the theme's tokens (the editor's and
side bar's backgrounds, its buttons, inputs, links and borders), or the
theme's foreground mixed into what's behind it: muted text, hairlines, soft
fills and code are the foreground at fixed strengths, so they recede the same
way on a dark theme and a light one. It doesn't rely on how a theme relates
its tokens: the editor's background may be lighter, darker or the same as the
side bar's (the band's hairline marks it either way), and some themes set
`descriptionForeground` to the foreground. High contrast themes get text at
full strength and their contrast border in place of hairlines. The controls
are the theme's too: icon buttons hover like its toolbar icons, and Run and
Allow for session are its primary and secondary buttons, with their hover
colors and borders. Their tooltips are the panel's own, in the theme's hover
colors, shown after a moment's hover or on keyboard focus, since native
tooltips show unreliably in a webview. The agent's colors are theme colors too (see Agent
cursor).

Behavior:

- **Typing in the reply box pauses playback**, the way a pair stops when you
  start talking. Clearing it resumes. Sending the reply delivers a `message`
  event (which interrupts) and ends any pause, so the agent's answer plays
  right away. (Pausing on focus alone would leave playback paused after
  sending, while the box still has focus.)
- With text in the reply box, "Hand back" hands back the turn with it as the
  message.
- **Sharing a selection.** While the programmer has code selected in the
  editor, a line above the reply box says *With selection
  `src/server.ts:12–18`*: the reply (or "Hand back") takes the selection
  along. × leaves it out; the next selection brings the line back. The
  selection is sent once. *Ask the Agent About the Selection* in the editor's
  context menu focuses the reply box.
- **Commands.** When the agent plays a `run`, the band shows the command under
  the current message, with **Run**, **Allow for session** (the same command
  won't ask again until the session ends) and **Skip** (unless
  `aiPair.confirmCommands` is off), with the cursor in its read state and the
  status *Needs you*. The
  command then runs in an *AI Pair* terminal, revealed without taking focus,
  and the history records its exit code.
- **Space pauses and resumes** while the panel has focus, except in the reply
  box. It never presses the focused button (after a click, that could be
  End); Enter still does.
- The command *AI Pair: Reply to the Agent* focuses the reply box from the
  editor; bind it to a key of your choice.
- During the programmer's turn the band's header says *Your turn*, and the
  agent navigates: its comments appear as the current message as usual.

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

When text follows the `▌` in a `type`, the cursor steps back to the `▌` after
typing it all, like a nearby move: the beat before it, so the programmer sees
the close typed before the cursor leaves it, and the pause after it.
`type_fast` shortens both by the same factor as its typing. With nothing
after the `▌`, the cursor is already in place and there's neither.

**Reading.** After a `say`: `clamp(words × 270, 1500, 9000)`. Enough to read
the message at an ordinary pace, about 220 words a minute.

**Speed.** The panel's speed menu (0.4×, 0.6×, 1.0×, 1.5×, 2.0×, 3.0×) scales
all of it together, immediately, even mid-typing. It's the `aiPair.speed`
setting, which takes any value from 0.25 to 4.

### Undo

Each editing action is one undo stop: characters are applied as successive
edits without undo stops between them, with stops at the action's boundaries.

### Follow mode

During the agent's turn:

- The view follows the agent cursor across files, as the agent types,
  deletes, moves, selects and points. Nothing else moves the view: not a
  `say`, and not the programmer's edits shifting the cursor.
- **After a `point`, it follows the pointed code instead**, so the narration
  about it plays while it's in view. The next action at the cursor (a move, a
  selection, typing or a deletion) brings the view back to the cursor; after
  a far `point`, with the pause of a far move first.
- What the view follows is kept in the **middle half of the viewport**. When
  it gets into the top or bottom quarter, or out of view, the view scrolls to
  put it **a third of the way down**, roughly level with the narration
  panel's current message. So typing downward scrolls every 40% of a
  viewport or so, not on every keystroke, and every jump lands in the same
  place. At the top of a file, it sits as low as the file lets it.
- The view **glides** there, easing out over half a second, however far it
  goes, so the programmer sees which way the code went. It moves a line at a
  time, since that's how the extension API scrolls. With
  `editor.smoothScrolling` on, VS Code animates it instead.
- The viewport's height comes from the lines VS Code shows. Near the end of a
  file those stop at its last line, short of the viewport's bottom, and a
  zoom or a resize there changes nothing VS Code reports. So a scroll there
  first centers the target, which VS Code can do knowing its viewport, and
  measures the height from where it landed, then goes on to a third.
- Playback **pauses automatically** when the programmer switches to another
  editor or scrolls what the view follows out of view. Scrolling caused by
  follow mode itself is ignored.
- **Resume always brings the view back** to what it follows first, then
  playback continues.

### Saving

Files edited through the protocol are saved when a batch ends, and before a
command the batch runs, so the command sees them.

## Changes outside the protocol

Files that change on disk without going through the protocol (the agent's
native tools, or anything else) are marked:

- a badge on the file in the explorer,
- an entry in the narration history ("`package.json` changed outside the
  editor") with a link to the diff.

The mark clears when the programmer opens the file or the diff. The extension
can't tell the agent's native edits from other tools (git, formatters), so the
wording stays neutral.

## In JetBrains IDEs

The same session, timing and panel, with these differences:

- **The cursor** is drawn by the plugin over the editor's text, with the same
  states and pulse. Its colors are the plugin's own for now, not yet colors
  that themes and users can override, and they don't follow VS Code's
  latest tuning.
- **The panel** is the same page, in the *AI Pair* tool window, on the right
  by default. It takes its colors and fonts from the IDE's theme and editor
  color scheme, and restyles in place when either changes, keeping a
  half-typed reply.
- **The settings** are on *Settings → Tools → AI Pair*: speed, agent name,
  confirming commands, and timing as JSON, for all projects, and a project's
  own speed, agent name and timing.
- **The commands** are in *Tools → AI Pair*, and *Ask the Agent About the
  Selection* is in the editor's right-click menu.
- **Saves are verbatim.** IntelliJ strips trailing spaces on save by default,
  and VS Code doesn't. Stripping a line the agent is about to type on would
  count as an edit the agent didn't make, so the agent's own saves, and any
  save of the file it's typing in during a session, keep the text as typed.
- **`run`** plays in an *AI Pair* tab of the Terminal tool window. When the
  terminal's shell is cmd.exe, which has no shell integration to capture
  output, that tab runs PowerShell instead.

## Open questions

- **Setup flow.** Discovery file vs. a command that writes the harness's MCP
  config directly. How to make the first run trivial.
- **Panel placement.** Secondary side bar by default; is it wide enough for
  large text, or should the panel be an editor-group webview?
- **Type-to-pause.** Does pausing when the programmer starts typing a reply
  feel natural, or does it surprise?
- **Bulk changes outside the protocol.** A bulk rename marks many files at
  once; the history entry should probably group them.

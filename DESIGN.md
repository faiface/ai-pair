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
     is typing_, _Read this_, _Needs you_, _Your turn_), the session's
     pairing mode after them as its small icon and word in muted text,
     and the controls,
     compact and quiet, as icons without fills: Pause/Resume, Interrupt, My
     turn, the speed, End. During the programmer's turn, Pause and Interrupt
     give way to Hand back, the one labeled control, since it's the main
     action then. The speed opens a menu of 0.4× to 3.0×. The agent's color
     is on the dot only, never on the controls. In a narrow panel the
     controls drop to a line of their own under the state, right-aligned,
     rather than crowd it: the state keeps room for its words, and the
     mode's word gives way (to "…") before the state's.
     The words say what the wait is: while the agent thinks, the dot
     breathes and a clock counts (_Agent is thinking · 8s_, and _no word from
     it yet_ past a minute and a half), so a long think reads as work and a
     stuck agent as stuck; while it plays, how many batches are written and
     ready behind this one, and _writing more_ while the agent is at it.
     With the voice on, a think after news isn't silent either. When a batch
     ends on a run with nothing queued after it, the voice reads the result
     off the screen at once, as a person at the desk would: a short output
     whole (_It printed 5.0._), a long one by its length and last line, a
     failure by its last line (_It failed: NameError: name 'x' is not
     defined._). The agent's report quotes it, so its answer goes on from
     it. Then, six seconds into the think after a run (three after something
     the programmer said or did, five when the editor just ran out of written
     batches), the voice makes the small sound a person would, fitted to it
     (_Mm. Let me see._, _Let me look at why._, _One sec._), and once more
     fifteen seconds later if the think goes on (_Still working it out._).
     The extension says all of these, not the agent, so they cost no model
     time and work with any agent; they're facts and thinking noises, never
     a guess at the answer. A quiet heartbeat isn't news, so thinking after
     one stays silent. A filler not yet heard when the agent's own words
     come is taken back.
     After Interrupt the words are _Interrupted · it knows_ until the agent
     visibly acts on it or the programmer speaks: a quiet agent that heard
     must not read like one that didn't. While paused they say the work is
     held, and the agent's reports say the same.
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
summary. The whole row under it is icons, so it fits on one line.
Getting an agent going is one play button: it runs the chosen agent in
a free terminal already standing in the workspace, or a new one there.
Which agent that is changes rarely, so it's not in the panel; the
command _AI Pair: Choose Agent to Start_ picks it (any of the set-up
agents, or a custom command). Next to it, the session's **pairing
mode**: one button showing the active mode's icon, opening a small
menu here in the panel (like the speed menu). Bricks for _Build_ (get
it done, shown as it goes), and for _Learn_ an eye (_Show me_), two
people (_Together_), a pencil (_Let me try_): three splits of who does
the work, each with a line saying what it means. It's picked per
session before it starts and remembered between them; the agent is
told at the start, and the mode's page rides with its guide. The panel never
hosts an agent: each stays its own app, with its own screen, model and
thinking settings, and Start treats them all the same. At the right of
the same row sits the voice toggle as an icon only, its name in its
tip, showing on or off, joined to its own small menu opening here in
the panel (the panel's menus all do: speed, mode, voice; each shifts
back inside when the panel is too narrow for where it hangs). The voice
menu lists Kokoro's and
Chatterbox's voices under friendly names with a colored dot each, a
down-arrow on one whose engine is still to fetch, and the programmer's
own recording among them, with choosing one a row of its own. Each
voice is heard as it's moved to — a tiny shipped sample, cut short the
moment the pointer moves on, so voices compare back to back without
warming an engine up — and the keyboard menu's switches likewise play
as they're moved to: both are chosen by ear.
Too narrow for one line, the row wraps deliberately: play left and the
mode right on top, sound below with voice left and keys right. Words
appear under them only when something needs saying, like the voice
loading or failing. The reply box sits below, once a session is running.
In every message, code spans that name a file (`game.ts`,
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
the two Allow buttons are its primary and secondary buttons, with their hover
colors and borders. Their tooltips are the panel's own, in the theme's hover
colors, shown after a moment's hover or on keyboard focus, since native
tooltips show unreliably in a webview. The agent's colors are theme colors too (see Agent
cursor).

**The voice.** Watching code type in one place and reading about it in
another is two jobs at once, so the panel can read the narration aloud
itself: **Voice** in the band's controls (and, before a session, above the
reply box, with **Pick a voice** beside it). With the voice on, the band's
big current message goes away — the words go straight to the history,
where they can still be scanned back over — and the eyes stay on the code.
A command waiting to be allowed still shows its box: it's the one thing in
the band that needs a click. The status line and the reading ring stay: the
ring now fills over speaking time. Each `say` is spread over the typing it
explains — a long one gets a head start, then talks over the typing, so the
two finish about together; a natural voice keeps one steady pace while it
does this, spread by pauses alone, never played faster or slower line by
line. Interrupting cuts the voice off mid-line.

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
  the current message, with **Run**, **Allow _program_** (every command of
  that program, like `npm`, runs without asking until the session ends; shown
  only for one plain command, since allowing the first program of a chained,
  piped or redirected one would let the rest through), **Allow all** (every
  command runs without asking until the session ends) and **Skip** (unless
  `aiPair.confirmCommands` is off), with the cursor in its read state and the
  status _Needs you: allow the command?_. Nothing plays until the programmer
  answers, so the question can't be missed: the panel comes into view, the
  command box pulses, and the voice, if on, asks out loud. Once they answer,
  the ask is taken back: if it's still queued or sounding, it isn't said, and
  the agent's other words go on. The
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

**Reading.** A beat's `say`, without a voice, gets
`clamp(words × 270, 1500, 9000)`: enough to read it at an ordinary pace,
about 220 words a minute. Its actions start a moment after the words show,
and the beat lasts as long as the longer of the reading and the work, so a
short line over a long edit adds no wait, and a long line over a small one
still gets read.

**Speed.** The panel's speed menu (0.4×, 0.6×, 1.0×, 1.5×, 2.0×, 3.0×) scales
all of it together, immediately, even mid-typing. It's the `aiPair.speed`
setting, which takes any value from 0.25 to 4. The voice is one of the things
it scales, so there's one control, not two: with the voice on, typing waits
for speech, and a faster session with a slow voice wouldn't be faster. The
voice follows from 1× up to 2×. Slower than 1× it keeps its natural pace,
since a drawl helps no one; past 2× words blur.

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

## Open questions

- **Setup flow.** Discovery file vs. a command that writes the harness's MCP
  config directly. How to make the first run trivial.
- **Panel placement.** Secondary side bar by default; is it wide enough for
  large text, or should the panel be an editor-group webview?
- **Type-to-pause.** Does pausing when the programmer starts typing a reply
  feel natural, or does it surprise?
- **Bulk changes outside the protocol.** A bulk rename marks many files at
  once; the history entry should probably group them.

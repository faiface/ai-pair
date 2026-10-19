# Changelog

## Unreleased

- **Less dead air while the agent thinks.** The agent is told to answer news
  with one short line first and keep its next batch small, so you hear back
  sooner. And a run's output now reaches an agent waiting on it as soon as
  its batch ends, instead of after everything queued behind it.
- **A slimmer Start row.** The agent-name button is gone: which agent Start
  runs is picked with *AI Pair: Choose Agent to Start*, since it rarely
  changes.
- **A run's answer reaches the agent at once.** When the agent waited for a
  command's output, it could sit out a 45-second heartbeat after the command
  finished before hearing the result, looking stuck. Finished runs (and
  failures) now wake it as soon as they land.
- **Pause and Interrupt say what they did.** Reports now tell the agent when
  playback is paused, and your Pause and Resume reach a waiting agent at
  once instead of at the next heartbeat. After Interrupt, the panel's status
  reads _Interrupted · it knows_ until the agent acts on it,
  and the agent is told to stop, say where it stopped, and listen.
- **Words and work come in beats.** The agent now sends a batch as beats:
  each one is what it says and the actions those words are about. They start
  together, and the next beat waits until both are done, so the words stay
  with the code they talk about. The words show as the work starts, and a
  beat lasts as long as the longer of reading and working. The pair protocol
  is now version 4.
- **Clearer errors for a wrong beat.** If the agent puts `move` or `say` in
  the wrong place, it's told exactly where they go, with an example.
- **OMP forgets what never played.** When you interrupt, an OMP started
  from the panel sees only the beats that played in its own history, not
  the code it had queued. It no longer talks as if that code is in your
  file. Your saved chat is not changed.
- **The agent hears when it left you waiting.** If the editor sat still for 5
  seconds or more while it wrote its next batch, the report tells it how
  long, and to keep something playing with bigger batches. The `step` tool
  now asks for batches of about 10 to 30 seconds, not single short lines.
- **The agent talks first, then looks.** It's told to start the session right
  away and say what it's going to look at, before it reads your code. Before,
  it could read and think for minutes in silence.

- **Other extensions no longer garble the agent's typing.** When an extension
  answers a keystroke, like Pylance closing a `"""` the moment it opens, that
  addition is taken back at once. Before, it doubled the quotes, counted as
  your edit, and cut off the batch mid-sentence.
- **No more `def f(x)::`.** A `type` that puts a `:`, `;` or `,` after its
  close is rejected, since stepping past the close and typing on would add it
  twice.
- **The agent doesn't explain code it hasn't written.** Reports now say
  plainly that what didn't play never happened, and the agent is told to
  call that code a plan and to say again what you didn't hear.
- **Pairing keeps moving.** The agent now writes its next batches while you
  watch, up to 2 batches ahead, so the editor no longer sits still between
  batches while it thinks. Step in and what it wrote ahead is dropped, so your
  interruption still lands right away. New setting:
  `aiPair.workAheadBatches`.
- **The agent knows a command waits for you.** The agent is told a run is waiting on
  you, instead of just hearing that nothing has finished.
- **The status line says what the wait is**: a clock while the agent thinks,
  a note when it has gone quiet for long, and how many batches are ready.
- **A tidier idle panel.** The play button and the agent it runs sit on one
  row.
- **Start your agent from the panel.** The play button runs the agent you
  picked in a free terminal already standing in your project, or a new
  one there — OMP, Claude Code, Codex, OpenCode, Gemini CLI, or a command of your own with
  the flags you want. The first start gives that agent the pair server by
  itself. Every agent is started the same way and stays its own app: you
  talk to it in its terminal, and it pairs from there. New commands:
  **AI Pair: Start Agent** and **AI Pair: Choose Agent to Start**.
- **AI Pair: Set Up Agent** can also connect an OMP you run yourself.

## 0.1.0

The first release.

- Your coding agent gets its own cursor in the editor, types at a human pace,
  and explains what it's doing in the **Pair** panel.
- Reply, interrupt, or edit the code at any moment, and the agent's next move
  takes it into account. Select some code to ask about it.
- **My turn** lets you write a part yourself while the agent navigates.
- The agent's commands play in an *AI Pair* terminal, after you allow them.
- The speed menu sets the pace, from 0.4× to 3.0×.
- **AI Pair: Set Up Agent** connects Claude Code, Codex, OpenCode, Gemini CLI
  and Cursor. GitHub Copilot needs no setup.
- **AI Pair: Play Demo Session** shows what it's like without an agent.

# Changelog

## Unreleased

- **Staged pairing: the agent works first, then shows you.** Your agent
  now does the real work at its own pace in a private copy of your
  project, with no pairing rules slowing it down, and records it in
  stages: small steps that each run on their own, with notes on why. A
  presenter, a subagent it starts on its own model with thinking off
  (or the agent itself, if it has no subagents; for OMP, the setup adds
  a `pair-presenter` agent for this), plays each stage in your editor and explains it while
  the agent works on the next, so you almost never wait on its thinking.
  The presenter types a stage's lines with a new `write` action, handles
  your small requests itself, and passes bigger ones to the agent. Your
  edits always stand: both agents treat them as yours and build on them,
  never undo them as drift. Each stage starts with its own divider in
  the panel's history. A change in a stage plays as one piece: a blank
  line next to it is never split off to be typed on its own. When the
  presenter asks you something, it stops and listens for your answer;
  in Learn mode it asks only now and then, where a bigger idea comes
  together. And when its batches have played while a stage still has
  code to type, it hears so at once, instead of sitting out a long wait.
- **Compare with prepared.** After a session with stages, a button in
  the panel (also *AI Pair: Compare with Prepared*) opens the agent's
  prepared version beside the final code, so you see at a glance what
  changed on the way.
- **Paths in projects opened through a symlink.** A project opened in
  VS Code through a symlinked folder (like `/tmp` on macOS) is now
  matched to the agent's working directory by its real path, so files
  aren't missed or opened twice.
- **Less dead air while the agent thinks.** With the voice on, if the
  agent thinks for a few seconds after a run or something you did, the
  voice says a short line that fits, like *Mm. Let me see.*, and once
  more if it goes on. The extension says these itself, so they work with
  any agent and cost it no time. It never reads a run's output out: it's
  on your screen, and the agent says what it makes of it in its own
  words, without announcing beforehand what it expects. The agent is
  also told to answer news with one short line first and keep its next
  batch small, so you hear back sooner. And a run's output now reaches an
  agent waiting on it as soon as its batch ends, instead of after
  everything queued behind it.
- **The panel's menus live in the panel, and fit it.** Voice and keyboard
  are picked from small menus right beside their toggles, like speed and
  mode already were, instead of a list at the top of the window. Voices
  go by friendly names with a colored dot each, Kokoro and Chatterbox in
  their own sections, a down-arrow marking one whose engine is fetched
  when first used; your own recording sits among Chatterbox's voices,
  with choosing one a row of its own. Moving to a voice plays it at once
  (a tiny shipped sample, stopped the moment you move on), keyboards
  play as you move to them too, and menu sub-lines sit left, not
  centered. Menus shift back inside when the panel is narrow instead of
  running off its edge, and too narrow for one line, the Start row
  wraps neatly: play and mode on top, voice and keys split below. In a
  session, a narrow panel puts the controls on a line under the status
  instead of sliding them over it. The pick commands now open these
  menus.
- **A slimmer Start row, all icons.** The panel's second play button (in
  its title bar) and the agent-name button are gone: which agent Start
  runs is picked with *AI Pair: Choose Agent to Start*, since it rarely
  changes. The pairing mode is one small button showing the active
  mode's icon; its menu opens right in the panel.
- **Build or Learn: pick how a session pairs.** Beside Start, the mode
  button. *Build* gets it done, shown as it goes. *Learn* teaches: one
  small idea at a time, the too-simple version first, each piece run so
  you see what it does, never a question about what hasn't been taught
  yet. Nothing arrives before the code needs it: no fields or helpers
  added for where it's headed, the need shown on screen first, then the
  piece that meets it. Learn comes at three splits of who does the work — *Show me*
  (the agent drives), *Together* (a worked example, then you write the
  next one like it), *Let me try* (you drive, the agent navigates). The
  pick is remembered, fixed for the session, and told to the agent when
  the session starts, so you only ever say what the task is. The running
  session's mode shows quietly beside the panel's status.
- **A run's answer reaches the agent at once.** When the agent waited for a
  command's output, it could sit out a 45-second heartbeat after the command
  finished before hearing the result, looking stuck. Finished runs (and
  failures) now wake it as soon as they land.
- **Chatterbox keeps one steady pace.** Each line was sped up or slowed down
  to match the typing it covered, which a natural voice makes plain. It now
  always talks at the one pace you set; pauses between sentences do the
  spreading instead. Kokoro still fits its lines as before.
- **Pause and Interrupt say what they did.** Reports now tell the agent when
  playback is paused, and your Pause and Resume reach a waiting agent at
  once instead of at the next heartbeat. After Interrupt, the panel's status
  reads _Interrupted · it knows_ until the agent acts on it,
  and the agent is told to stop, say where it stopped, and listen.
- **The voice is AI Pair's own.** Kokoro is no longer borrowed from an OMP
  install, and there is no `omp say` fallback: the first turn-on downloads
  Kokoro into the extension's own storage instead (it needs bun or node,
  nothing else). It speaks the same whichever agent you pair with. If you
  had the voice on, the first turn-on after this update fetches it again
  into its new home.
- **Allow a whole kind of command.** When the agent wants to run a command,
  the panel now offers **Run**, **Allow `npm`** (every command of that
  program, like `npm test` and `npm run build`), **Allow all**, and **Skip**.
  Both allow choices last until the session ends. Chained or piped commands
  (`a && b`, `a | b`) can't be allowed by program, since that would let the
  other part through too. This replaces **Allow for session**, which only
  covered the exact same command.
- **The voice stops asking once you answer.** "Okay to run it?" is no longer
  spoken after you pick Run, Allow, or Skip, even if the voice was busy and
  the ask was still waiting its turn. Other speech goes on as before.
- **Words and work come in beats.** The agent now sends a batch as beats:
  each one is what it says and the actions those words are about. They start
  together, and the next beat waits until both are done. So the voice no
  longer drifts away from the code it talks about. With the voice off, the
  words show as the work starts, and a beat lasts as long as the longer of
  reading and working. The pair protocol is now version 4.
- **The agent knows if you can hear it.** It's told whether the voice is on
  when the session starts, and again whenever you flip it. With the voice
  on, it writes for the ear: plain words, and code said the way you'd say it
  out loud.
- **Clearer errors for a wrong beat.** If the agent puts `move` or `say` in
  the wrong place, it's told exactly where they go, with an example.
- **OMP forgets what never played.** When you interrupt, an OMP started
  from the panel sees only the beats that played in its own history, not
  the code it had queued. It no longer talks as if that code is in your
  file. Your saved chat is not changed.
- **A line that won't end can't freeze the session.** With the voice on, a
  batch that points at code waits for its words to finish. If the voice went
  quiet without finishing, the batch waited forever. Now it moves on after
  about twice the line's length. A rare race that could leave a new line
  never spoken, right after you interrupt, is fixed too.
- **The agent hears when it left you waiting.** If the editor sat still for 5
  seconds or more while it wrote its next batch, the report tells it how
  long, and to keep something playing with bigger batches. The `step` tool
  now asks for batches of about 10 to 30 seconds, not single short lines.
- **The Run box shows with the voice on.** With the voice on, the box that
  asks you to allow a command was hidden, so a session could sit waiting for
  you with no sign of why. Now it stays in view.
- **The agent talks first, then looks.** It's told to start the session right
  away and say what it's going to look at, before it reads your code. Before,
  it could read and think for minutes in silence.

- **Other extensions no longer garble the agent's typing.** When an extension
  answers a keystroke, like Pylance closing a `"""` the moment it opens, that
  addition is taken back at once. Before, it doubled the quotes, counted as
  your edit, and cut off the batch and its voice mid-sentence.
- **No more `def f(x)::`.** A `type` that puts a `:`, `;` or `,` after its
  close is rejected, since stepping past the close and typing on would add it
  twice.
- **The agent doesn't explain code it hasn't written.** Reports now say
  plainly that what didn't play never happened, and the agent is told to
  call that code a plan and to say again what you didn't hear.
- **The voice follows the speed menu,** up to 2×. One control sets the pace
  of both typing and talking; slower than 1×, the voice keeps its natural
  pace. `aiPair.voice.rate` now fine-tunes on top, and works for Chatterbox
  too. Kokoro stays clear when fast: past 1.3× it no longer squeezes its
  own sounds, which smeared words at 2×; the line is made at 1.3× and
  sped up the rest of the way at the same pitch.
- **Pairing keeps moving.** The agent now writes its next batches while you
  watch, up to 2 batches ahead, so the editor no longer sits still between
  batches while it thinks. Their speech is made ahead too, so each batch
  starts talking at once. Step in and what it wrote ahead is dropped, so your
  interruption still lands right away. New setting:
  `aiPair.workAheadBatches`.
- **A command waiting for you can't go unseen.** The panel comes into view,
  the command pulses, and the voice asks. The agent is told it's waiting on
  you, instead of just hearing that nothing has finished.
- **The status line says what the wait is**: a clock while the agent thinks,
  a note when it has gone quiet for long, and how many batches are ready.
- **A tidier idle panel.** The play button and the agent it runs sit on one
  row, with Voice and Key sounds at its right as clear on/off icon toggles.
- **Key sounds you can choose by ear.** The arrow beside the keyboard
  toggle opens a list of six keyboards (new: Alpaca and the IBM Model M's
  buckling spring). Each one types a few words as you move to it. The sounds themselves are more lifelike too: Shift goes
  down for capitals, each key keeps its own pitch, a word's first key lands
  harder, indentation is silent, and a small room's echo puts the keyboard on
  a desk instead of in your ear. New command: **AI Pair: Select Typing Sound
  Switch**.
- **Start your agent from the panel.** The play button runs the agent you
  picked in a free terminal already standing in your project, or a new
  one there — OMP, Claude Code, Codex, OpenCode, Gemini CLI, or a command of your own with
  the flags you want. The first start gives that agent the pair server by
  itself. Every agent is started the same way and stays its own app: you
  talk to it in its terminal, and it pairs from there. New commands:
  **AI Pair: Start Agent** and **AI Pair: Choose Agent to Start**.
- **AI Pair: Set Up Agent** can also connect an OMP you run yourself.
- **The agent can talk.** Turn **Voice** on in the Pair panel and everything
  it says is spoken while it works, with Kokoro: a speech model that runs on
  your own machine, so nothing leaves it to be said. The words are spread
  over the typing they explain — a long one gets a head start, then talks
  over the typing, so the two finish about together; interrupting cuts it
  off. The big
  text in the panel goes away while the voice is on — your eyes stay on the
  code — and the words still land in the history. The arrow beside **Voice** chooses
  whose it is. The first turn-on may download the model once. New settings:
  `aiPair.voice.enabled`, `.voice`, `.rate`, `.runtimePath`. Code is said the
  way a programmer says it: `req.body` is "req dot body", `user_id` "user
  id", `server.ts` "server dot T S", 404 "four oh four". And agents are told
  to talk like a pair at your desk, naming the code they type. The typing a
  `say` explains waits until its words are heard, so a slow-to-start voice
  never lags behind the code it is about.
- **Two voices to choose from.** The voice picker offers Kokoro (light, works
  everywhere) or Chatterbox (more natural; needs
  [uv](https://docs.astral.sh/uv/), and an Apple Silicon GPU or an
  NVIDIA card to keep up; a big one-time fetch on the first turn-on).
  Chatterbox speaks in its own voice, or in one taken from a recording
  you pick. New settings: `aiPair.voice.model`,
  `aiPair.voice.chatterboxVoice`.
- **Hear the agent type.** The keyboard button in the Pair panel turns on
  typing sounds: its keystrokes play as a real mechanical keyboard, from
  recordings of a switch — a press and a release per key, letters by their
  row, space, enter and backspace their own, each a little different. Kept
  well under the voice, and quieter still while it talks. Click the panel
  once so VS Code lets it make sound. New settings:
  `aiPair.typingSounds.enabled`, `.volume`, `.switch` (Holy Panda, Cream,
  MX Brown, Topre; recordings from kbsim, MIT).

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

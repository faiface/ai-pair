// Playing a batch in memory before queuing it, so an action that would fail (text that isn't on
// its line, say) is reported at once, instead of when the batch plays, minutes later. It's the same
// player as real playback, on a stage that plays in a copy of the editor, instantly and silently.

import type { Action, BatchResult } from "@ai-pair/protocol"
import type { Config } from "./controller"
import type { LineIds, Sighting } from "./lines"
import { Player, transformScene, type Scene } from "./player"
import type { Change, CommandOutcome, EditorPort, PanelPort } from "./ports"
import { instant } from "./timeline"

/** What playing batches leaves behind: the scene, the text of each file they edited, and its lines. `edits`: this batch's own. */
export type Rehearsal = { scene: Scene; texts: Map<string, string>; lines: LineIds; edits: Set<string> }

/**
 * Plays `actions` in memory, starting from `from`. Commands don't run, and succeed; a `move` goes
 * only to a line the agent `knows`. Returns the batch's result, the lines it shows, and what it
 * leaves behind, for rehearsing the batch after it.
 */
export async function rehearse(
  editor: EditorPort,
  config: Config,
  from: Rehearsal,
  actions: Action[],
  knows: (file: string, line: number, id: number) => boolean,
): Promise<{ result: BatchResult; sightings: Sighting[]; after: Rehearsal }> {
  const scene: Scene = {
    ...from.scene,
    cursor: from.scene.cursor && { ...from.scene.cursor },
    selection: from.scene.selection && { ...from.scene.selection },
    point: from.scene.point && { ...from.scene.point },
  }
  const memory = new MemoryEditor(editor, new Map(from.texts))
  const lines = from.lines.fork()
  const player = new Player(scene, {
    editor: memory,
    panel: silent,
    pacing: instant,
    config: () => config,
    speed: () => 1,
    render: () => {},
    confirm: () => Promise.resolve(true),
    lines,
    knows,
  })
  const { result, sightings } = await player.play(0, actions)
  return { result, sightings, after: { scene, texts: memory.texts, lines, edits: memory.edits } }
}

/** Follows a change by others to a file no queued batch edits, so its rehearsed text is the editor's. */
export function followChange(r: Rehearsal, file: string, before: string, after: string, changes: Change[]): void {
  r.lines.of(file, before)
  for (const change of changes) {
    transformScene(r.scene, file, change)
    r.lines.apply(file, change)
  }
  if (r.texts.has(file)) r.texts.set(file, after)
}

const silent: PanelPort = { post: () => {} }

/** A copy of the editor: files it has edited are its own, the rest are read from the real one. */
class MemoryEditor implements EditorPort {
  readonly edits = new Set<string>()

  constructor(
    private readonly real: EditorPort,
    readonly texts: Map<string, string>,
  ) {}

  resolvePath(file: string): string {
    return this.real.resolvePath(file)
  }

  displayPath(file: string): string {
    return this.real.displayPath(file)
  }

  async getText(file: string): Promise<string> {
    return this.texts.get(file) ?? (await this.real.getText(file))
  }

  async eol(file: string): Promise<string> {
    try {
      return await this.real.eol(file)
    } catch {
      // Only created in memory.
      return "\n"
    }
  }

  async isDirty(): Promise<boolean> {
    return false
  }

  async show(file: string): Promise<void> {
    if (this.texts.has(file)) return
    try {
      await this.real.getText(file)
    } catch {
      // Showing a file creates it.
      this.texts.set(file, "")
    }
  }

  async edit(file: string, offset: number, deleteLength: number, text: string): Promise<void> {
    const old = await this.getText(file)
    this.texts.set(file, old.slice(0, offset) + text + old.slice(offset + deleteLength))
    this.edits.add(file)
  }

  async save(): Promise<void> {}
  renderCursor(): void {}
  renderPoint(): void {}
  reveal(): void {}
  follow(): void {}

  async runCommand(): Promise<CommandOutcome> {
    return { exitCode: 0, output: "" }
  }
}

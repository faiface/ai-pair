// Every number that shapes how playback feels, in one place, for calibration.
// Durations are in milliseconds at normal speed; the speed setting divides them all.
// The programmer can override any of them with the `aiPair.timing` setting.

export type Cadence = {
  /** Between characters within a word. */
  charMs: number
  /** Random variation of `charMs`, e.g. 0.25 for ±25%. */
  jitter: number
  /** Extra, when a word starts: switching from punctuation or whitespace to a letter or digit. */
  wordStartMs: number
  /** Extra, after `,` `;` `:`. */
  punctuationMs: number
  /** Extra, after an opening `(` `[` `{`. */
  openBracketMs: number
  /** Extra, after a newline: the next line is being thought of. */
  newlineMs: number
}

export type Reading = { msPerWord: number; minMs: number; maxMs: number }

/** How a beat's `say` and its work fit together. */
export type VoiceTiming = {
  /** How long the work waits for the words to begin, read or spoken, before it goes on under them. */
  leadMs: number
  /**
   * The most the work waits for a spoken `say`'s first words to be heard: making speech takes a
   * moment, and words still queued go first. Past this the voice is taken to be stuck, and work goes on.
   */
  maxStartMs: number
  /**
   * The most the work waits when a spoken `say` runs much longer than the work it covers: that
   * much is spoken first, the rest talks over the work.
   */
  maxLeadMs: number
  /** How long a word takes to say, for pacing speech against the work it covers. */
  msPerWord: number
}

export type Timing = {
  type: Cadence
  /** `type_fast` plays the same cadence, with every delay multiplied by this. */
  fastFactor: number
  /** A `say` that's read: the least its beat lasts, enough to read it at an ordinary pace. */
  reading: Reading
  /** A beat's words and work, read or spoken. */
  voice: VoiceTiming
  /** Before a move, so the jump doesn't look instantaneous. */
  beforeMoveMs: number
  /** After a move nearby, and after `type` steps back between its parts: the eyes find the cursor again. */
  afterMoveNearMs: number
  /** After a move to another file or far away: the view changed, re-orient. */
  afterMoveFarMs: number
  /** A move within this many lines in the same file counts as nearby. */
  nearLines: number
  beforeSelectMs: number
  /** After a selection appears: read what's about to change. */
  afterSelectMs: number
  /** After a deletion: register what's gone. */
  afterDeleteMs: number
  /** After a `point` highlight appears: find the highlighted code. */
  afterPointMs: number
}

export const defaultTiming: Timing = {
  type: {
    charMs: 55,
    jitter: 0.25,
    wordStartMs: 110,
    punctuationMs: 90,
    openBracketMs: 70,
    newlineMs: 350,
  },
  fastFactor: 0.25,
  reading: { msPerWord: 270, minMs: 1500, maxMs: 9000 },
  voice: { leadMs: 350, maxStartMs: 10000, maxLeadMs: 4000, msPerWord: 380 },
  beforeMoveMs: 150,
  afterMoveNearMs: 450,
  afterMoveFarMs: 900,
  nearLines: 15,
  beforeSelectMs: 150,
  afterSelectMs: 700,
  afterDeleteMs: 300,
  afterPointMs: 400,
}

export type TimingOverrides = Partial<Omit<Timing, "type" | "reading" | "voice">> & {
  type?: Partial<Cadence>
  reading?: Partial<Reading>
  voice?: Partial<VoiceTiming>
}

export function withOverrides(base: Timing, overrides: TimingOverrides): Timing {
  return {
    ...base,
    ...overrides,
    type: { ...base.type, ...overrides.type },
    reading: { ...base.reading, ...overrides.reading },
    voice: { ...base.voice, ...overrides.voice },
  }
}

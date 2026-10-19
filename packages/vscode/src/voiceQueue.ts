// The order words are spoken in: one sentence is made while the one before it plays, and a queue
// that falls behind drops its oldest lines instead of reading stale news. Duplex pacing lives
// here too: given how long the typing a `say` covers will take, its sentences are spread across
// that span — a touch slower or faster, with pauses between sentences — so the talking and the
// typing run together and finish about together. Sentences of batches still waiting their turn
// are made early (`prepare`), a few at a time, so a batch starts talking the moment it starts.
// No audio here: making and playing a sentence are the backend's, so this can be tested with fakes.

import { splitSentences, spokenText } from "./voiceText"

export type SpeechBackend<T> = {
  /** Makes one sentence ready to play, at `speedScale` times its ordinary pace (1 unless fitting a span). */
  synth(text: string, speedScale: number): Promise<T>
  /** Plays it, settling when it ends or is stopped. */
  play(token: T): Promise<void>
  /** Cuts off whatever is playing now. */
  stopPlaying(): void
  /** Frees a played (or dropped) sentence: deletes its file, say. */
  release?(token: T): void
}

/** Sentences waiting their turn before the oldest unstarted ones are dropped as stale. */
const MAX_WAITING = 6

/** About how long a word takes to say: how spans are fitted. Rough is fine; ears forgive. */
const MS_PER_WORD = 380

/** The most a sentence is held back to spread speech over typing: longer reads as a stall. */
const MAX_GAP_MS = 3000

/**
 * The most sentences made early and not yet spoken. The worker makes one sentence at a time, so
 * whatever it was asked for runs ahead of a fresh `say` after an interruption: kept short, that
 * wait is one sentence, not the whole queue's.
 */
const MAX_MADE_EARLY = 4

/**
 * `heard`: the say's first words are sounding, or never will; called on any of its sentences, it acts once.
 * `signal`: the say's, which takes its words back.
 */
type Job = { text: string; done: () => void; heard: () => void; speedScale: number; gapBeforeMs: number; signal?: AbortSignal }

/** A sentence to make before it's spoken; `token` once its making has started. */
type Early<T> = { text: string; speedScale: number; token?: Promise<T | undefined> }

/** How a `say` is spoken across `spanMs`: its sentences, their pace, and the pause between them. */
function fit(raw: string, spanMs: number, steady: boolean): { sentences: string[]; speedScale: number; gap: number } {
  const sentences = splitSentences(spokenText(raw))
  const total = sentences.reduce((sum, s) => sum + Math.max(1, s.split(/\s+/).filter(Boolean).length) * MS_PER_WORD, 0)
  // Fit the span with pace first (a touch either way; more sounds wrong), then with pauses. A
  // steady voice is never sped up or slowed down for a span — heard plainly in a natural voice —
  // so its pauses alone do the spreading.
  const speedScale = !steady && spanMs > 0 ? Math.min(1.3, Math.max(0.85, total / spanMs)) : 1
  const fitted = total / speedScale
  const extra = spanMs > fitted ? Math.min(spanMs, fitted * 1.6) - fitted : 0
  const gap = sentences.length > 1 ? Math.min(extra / (sentences.length - 1), MAX_GAP_MS) : 0
  return { sentences, speedScale, gap }
}

export class SpeechQueue<T> {
  private jobs: Job[] = []
  private running = false
  /** Bumped by `stop`, so a loop still holding an old sentence knows to let go of it. */
  private generation = 0
  /** Cancels a between-sentences pause in flight. */
  private cancelGap: (() => void) | undefined
  /** The sentence pausing before it plays, or playing: taking its say back cuts it off. */
  private current: Job | undefined
  /** Says whose first words aren't heard yet, even the one being made: `stop` lets them all go at once. */
  private readonly unheard = new Set<() => void>()
  /** Sentences to be spoken later, in order, the first few already being made. */
  private early: Array<Early<T>> = []
  /** One early sentence is being made: the next starts when it's done. */
  private makingEarly = false

  /** `steady`: this voice always speaks at its own pace, whatever span a `say` covers. */
  constructor(
    private readonly backend: SpeechBackend<T>,
    private readonly steady = false,
  ) {}

  /** How many sentences are waiting, unstarted. */
  get waiting(): number {
    return this.jobs.length
  }

  /**
   * Speaks a `say`, spread across `spanMs` when given: the time the work it covers takes to play.
   * Settles when its last sentence has played, or was dropped or stopped. `onStart` is called once:
   * when its first sentence starts sounding, or when none of it will. `signal` takes back just
   * this say: its sentences still waiting are dropped, and the one sounding is cut off.
   */
  speak(raw: string, spanMs = 0, onStart?: () => void, signal?: AbortSignal): Promise<void> {
    const { sentences, speedScale, gap } = fit(raw, spanMs, this.steady)
    if (sentences.length === 0 || signal?.aborted) {
      onStart?.()
      return Promise.resolve()
    }
    let started = false
    const heard = () => {
      if (started) return
      started = true
      this.unheard.delete(heard)
      onStart?.()
    }
    this.unheard.add(heard)
    return new Promise<void>((resolve) => {
      let left = sentences.length
      const one = () => {
        heard()
        if (--left === 0) resolve()
      }
      sentences.forEach((text, i) => this.jobs.push({ text, done: one, heard, speedScale, gapBeforeMs: i === 0 ? 0 : gap, signal }))
      while (this.jobs.length > MAX_WAITING) this.jobs.shift()!.done()
      signal?.addEventListener(
        "abort",
        () => {
          this.jobs = this.jobs.filter((j) => j.signal !== signal)
          heard()
          resolve()
          // A sentence of it already being made is skipped by the loop when its turn comes.
          if (this.current?.signal === signal) {
            this.cancelGap?.()
            this.backend.stopPlaying()
          }
        },
        { once: true },
      )
      void this.pump()
    })
  }

  /**
   * Starts making a `say`'s sentences before it is spoken with the same `spanMs`, so they're
   * ready when it is. Sentences are made in the order they were prepared, a few ahead at most.
   */
  prepare(raw: string, spanMs = 0): void {
    const { sentences, speedScale } = fit(raw, spanMs, this.steady)
    for (const text of sentences) this.early.push({ text, speedScale })
    this.makeEarly()
  }

  /** Cuts off the current sentence and drops everything waiting, and everything made early. */
  stop(): void {
    this.generation++
    const waiting = this.jobs
    this.jobs = []
    for (const job of waiting) job.done()
    for (const heard of [...this.unheard]) heard()
    for (const e of this.early) void e.token?.then((token) => token !== undefined && this.backend.release?.(token))
    this.early = []
    this.makingEarly = false
    this.cancelGap?.()
    this.backend.stopPlaying()
  }

  /** Makes the next early sentence, if fewer than the most are made and none is being made. */
  private makeEarly(): void {
    if (this.makingEarly) return
    const started = this.early.filter((e) => e.token).length
    const next = this.early.find((e) => !e.token)
    if (!next || started >= MAX_MADE_EARLY) return
    this.makingEarly = true
    const gen = this.generation
    next.token = this.backend.synth(next.text, next.speedScale).catch(() => undefined)
    void next.token.then(() => {
      if (gen !== this.generation) return
      this.makingEarly = false
      this.makeEarly()
    })
  }

  /**
   * A sentence's speech: the one made early for it, or made now. Early sentences before it were
   * never spoken — their `say` was dropped — so they're let go.
   */
  private make(job: Job): Promise<T | undefined> {
    const at = this.early.findIndex((e) => e.text === job.text && e.speedScale === job.speedScale)
    if (at < 0) return this.backend.synth(job.text, job.speedScale).catch(() => undefined)
    const [skipped, found] = [this.early.slice(0, at), this.early[at]!]
    this.early = this.early.slice(at + 1)
    for (const e of skipped) void e.token?.then((token) => token !== undefined && this.backend.release?.(token))
    const token = found.token ?? this.backend.synth(job.text, job.speedScale).catch(() => undefined)
    this.makeEarly()
    return token
  }

  /** A pause between sentences, cut short by `stop`. */
  private gapWait(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.cancelGap = undefined
        resolve()
      }, ms)
      this.cancelGap = () => {
        clearTimeout(timer)
        this.cancelGap = undefined
        resolve()
      }
    })
  }

  private async pump(): Promise<void> {
    if (this.running) return
    this.running = true
    const gen = this.generation
    let ahead: { job: Job; token: Promise<T | undefined> } | undefined
    const startNext = () => {
      const job = this.jobs.shift()
      return job ? { job, token: this.make(job) } : undefined
    }
    try {
      ahead = startNext()
      while (ahead && gen === this.generation) {
        const current = ahead
        const token = await current.token
        if (gen !== this.generation) {
          if (token !== undefined) this.backend.release?.(token)
          current.job.done()
          ahead = undefined
          break
        }
        ahead = startNext()
        if (token !== undefined) {
          this.current = current.job
          if (current.job.gapBeforeMs > 0 && !current.job.signal?.aborted) await this.gapWait(current.job.gapBeforeMs)
          // A say taken back while this sentence was made, or paused before it, isn't said.
          if (gen === this.generation && !current.job.signal?.aborted) {
            current.job.heard()
            await this.backend.play(token).catch(() => {})
          }
          this.current = undefined
          this.backend.release?.(token)
        }
        current.job.done()
      }
      if (gen !== this.generation && ahead) {
        // A sentence made ahead for a queue that was stopped: free it and let its `speak` settle.
        const dropped = ahead
        void dropped.token.then((token) => {
          if (token !== undefined) this.backend.release?.(token)
          dropped.job.done()
        })
      }
    } finally {
      this.running = false
      // `stop` empties the queue, so what's in it now came since, from `speak`s that found this
      // loop still running and left their lines to it: picked up here, or no one ever says them.
      if (this.jobs.length > 0) void this.pump()
    }
  }
}

// The speech queue: sentences in order, made ahead, dropped when stale, cut off on stop.
// Making and playing are fakes whose promises the test settles; no real waits.

import { expect, it, vi } from "vitest"
import { SpeechQueue } from "../src/voiceQueue"
import { splitSentences, spokenText } from "../src/voiceText"

type Settler = { resolve: () => void }

function fakeBackend() {
  const made: string[] = []
  const speeds: number[] = []
  const played: string[] = []
  const released: string[] = []
  const synths = new Map<string, Settler>()
  const plays = new Map<string, Settler>()
  let stopped = 0
  const backend = {
    synth: (text: string, speedScale: number) => {
      made.push(text)
      speeds.push(speedScale)
      return new Promise<string>((resolve) => synths.set(text, { resolve: () => resolve(text) }))
    },
    play: (token: string) => {
      played.push(token)
      return new Promise<void>((resolve) => plays.set(token, { resolve }))
    },
    stopPlaying: () => {
      stopped++
      for (const p of plays.values()) p.resolve()
      plays.clear()
    },
    release: (token: string) => released.push(token),
  }
  const settleSynth = (text: string) => synths.get(text)!.resolve()
  const settlePlay = (text: string) => plays.get(text)!.resolve()
  const tick = async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  }
  return { backend, made, speeds, played, released, settleSynth, settlePlay, tick, stops: () => stopped }
}

it("makes the next sentence while the last one plays, in order", async () => {
  const f = fakeBackend()
  const queue = new SpeechQueue<string>(f.backend)
  const done = queue.speak("One here. Two here.")
  expect(f.made).toEqual(["One here."])
  f.settleSynth("One here.")
  await f.tick()
  expect(f.played).toEqual(["One here."])
  expect(f.made).toEqual(["One here.", "Two here."]) // already being made, mid-play
  f.settlePlay("One here.")
  f.settleSynth("Two here.")
  await f.tick()
  expect(f.played).toEqual(["One here.", "Two here."])
  f.settlePlay("Two here.")
  await done
  expect(f.released).toEqual(["One here.", "Two here."])
})

it("tells when a say is first heard: after the line before it, not when it was asked", async () => {
  const f = fakeBackend()
  const queue = new SpeechQueue<string>(f.backend)
  const heard: string[] = []
  void queue.speak("Before.", 0, () => heard.push("before"))
  void queue.speak("Then this. And more.", 0, () => heard.push("then"))
  f.settleSynth("Before.")
  await f.tick()
  expect(heard).toEqual(["before"])
  f.settleSynth("Then this.")
  await f.tick()
  expect(heard).toEqual(["before"]) // made, but still waiting its turn
  f.settlePlay("Before.")
  await f.tick()
  expect(heard).toEqual(["before", "then"])
  f.settleSynth("And more.")
  f.settlePlay("Then this.")
  await f.tick()
  expect(heard).toEqual(["before", "then"]) // once per say
})

it("lets a waiting start go when its words are stopped before they are heard", async () => {
  const f = fakeBackend()
  const queue = new SpeechQueue<string>(f.backend)
  const heard = vi.fn()
  void queue.speak("Never made.", 0, heard)
  queue.stop()
  expect(heard).toHaveBeenCalledTimes(1)
})

it("stop cuts the line off and settles every speak", async () => {
  const f = fakeBackend()
  const queue = new SpeechQueue<string>(f.backend)
  const first = queue.speak("One here. Two here.")
  const second = queue.speak("Three here.")
  f.settleSynth("One here.")
  await f.tick()
  queue.stop()
  // The prefetched line settles when its making does.
  f.settleSynth("Two here.")
  await f.tick()
  await first
  await second
  expect(f.stops()).toBe(1)
  expect(f.played).toEqual(["One here."])
})

it("speaks a say that comes while a stopped line is still being made", async () => {
  const f = fakeBackend()
  const queue = new SpeechQueue<string>(f.backend)
  void queue.speak("Old line.")
  queue.stop()
  const next = queue.speak("New line.")
  // The stopped line's making ends after the new say came: the new say must not be stranded.
  f.settleSynth("Old line.")
  await f.tick()
  expect(f.made).toEqual(["Old line.", "New line."])
  f.settleSynth("New line.")
  await f.tick()
  expect(f.played).toEqual(["New line."])
  f.settlePlay("New line.")
  await next
})

it("takes back one say: cut off while it sounds, the words after it still spoken", async () => {
  const f = fakeBackend()
  const queue = new SpeechQueue<string>(f.backend)
  const asked = new AbortController()
  const ask = queue.speak("Okay to run it? Allow it in the panel.", 0, undefined, asked.signal)
  const after = queue.speak("Next words.")
  f.settleSynth("Okay to run it?")
  await f.tick()
  expect(f.played).toEqual(["Okay to run it?"])
  asked.abort()
  await ask
  expect(f.stops()).toBe(1)
  // Its second sentence was being made ahead: once made, it's skipped, not said.
  f.settleSynth("Allow it in the panel.")
  await f.tick()
  f.settleSynth("Next words.")
  await f.tick()
  expect(f.played).toEqual(["Okay to run it?", "Next words."])
  f.settlePlay("Next words.")
  await after
})

it("takes back one say before it sounds, without cutting off the line playing", async () => {
  const f = fakeBackend()
  const queue = new SpeechQueue<string>(f.backend)
  const asked = new AbortController()
  void queue.speak("Before.")
  const ask = queue.speak("Okay to run it? Allow it in the panel.", 0, undefined, asked.signal)
  void queue.speak("After.")
  f.settleSynth("Before.")
  await f.tick()
  // The ask's first sentence is being made ahead while "Before." plays.
  asked.abort()
  await ask
  expect(f.stops()).toBe(0)
  f.settlePlay("Before.")
  f.settleSynth("Okay to run it?")
  await f.tick()
  f.settleSynth("After.")
  await f.tick()
  expect(f.played).toEqual(["Before.", "After."])
})

it("makes a queued say's sentences early, in order, and speaks them without making them again", async () => {
  const f = fakeBackend()
  const queue = new SpeechQueue<string>(f.backend)
  queue.prepare("Early one. Early two.", 0)
  // One at a time: the worker makes one sentence at once.
  expect(f.made).toEqual(["Early one."])
  f.settleSynth("Early one.")
  await f.tick()
  expect(f.made).toEqual(["Early one.", "Early two."])

  const done = queue.speak("Early one. Early two.", 0)
  await f.tick()
  expect(f.played).toEqual(["Early one."])
  f.settleSynth("Early two.")
  f.settlePlay("Early one.")
  await f.tick()
  f.settlePlay("Early two.")
  await done
  expect(f.made).toEqual(["Early one.", "Early two."])
  expect(f.played).toEqual(["Early one.", "Early two."])
})

it("lets go of what was made early when it's stopped, or skipped by a say that came instead", async () => {
  const f = fakeBackend()
  const queue = new SpeechQueue<string>(f.backend)
  queue.prepare("Dropped.", 0)
  queue.prepare("Kept.", 0)
  f.settleSynth("Dropped.")
  await f.tick()
  // "Dropped." was planned but never spoken: its batch was skipped.
  void queue.speak("Kept.", 0)
  f.settleSynth("Kept.")
  await f.tick()
  expect(f.released).toContain("Dropped.")
  expect(f.played).toEqual(["Kept."])

  queue.prepare("Stale.", 0)
  f.settleSynth("Stale.")
  queue.stop()
  await f.tick()
  expect(f.released).toContain("Stale.")
})

it("drops the oldest waiting lines when speech falls behind", async () => {
  const f = fakeBackend()
  const queue = new SpeechQueue<string>(f.backend)
  void queue.speak("First line.") // starts at once, never settles its making
  const speaks = []
  for (let i = 0; i < 9; i++) speaks.push(queue.speak(`Line ${i}.`))
  let settled = 0
  for (const s of speaks) void s.then(() => settled++)
  await f.tick()
  expect(queue.waiting).toBeLessThanOrEqual(6)
  expect(settled).toBeGreaterThan(0) // the dropped ones settled without a sound
  queue.stop()
})

it("spreads sentences across the span they cover, a touch slower and with pauses", async () => {
  vi.useFakeTimers()
  try {
    const f = fakeBackend()
    const queue = new SpeechQueue<string>(f.backend)
    // Two 3-word sentences: about 2280 ms of talk for 6000 ms of typing.
    const done = queue.speak("One two three. Four five six.", 6000)
    expect(f.speeds[0]).toBeCloseTo(0.85) // as slow as still sounds right
    f.settleSynth("One two three.")
    await f.tick()
    expect(f.played).toEqual(["One two three."])
    f.settlePlay("One two three.")
    f.settleSynth("Four five six.")
    await f.tick()
    // The second sentence waits out its share of the typing before it sounds.
    expect(f.played).toEqual(["One two three."])
    await vi.advanceTimersByTimeAsync(2000)
    expect(f.played).toEqual(["One two three.", "Four five six."])
    f.settlePlay("Four five six.")
    await done
  } finally {
    vi.useRealTimers()
  }
})

it("keeps a steady voice at its own pace over any span, spreading with pauses only", async () => {
  vi.useFakeTimers()
  try {
    const f = fakeBackend()
    const queue = new SpeechQueue<string>(f.backend, true)
    // The same talk first over long typing, then over barely any: a fitted voice would go to the
    // two ends of its pace range; a steady one never leaves its own.
    const done = queue.speak("One two three. Four five six.", 6000)
    void queue.speak("Seven eight nine.", 10)
    expect(f.speeds[0]).toBe(1)
    f.settleSynth("One two three.")
    await f.tick()
    f.settlePlay("One two three.")
    f.settleSynth("Four five six.")
    await f.tick()
    // The pause between its sentences is still there: only the pace stopped changing.
    expect(f.played).toEqual(["One two three."])
    await vi.advanceTimersByTimeAsync(2000)
    expect(f.played).toEqual(["One two three.", "Four five six."])
    f.settlePlay("Four five six.")
    await done
    await f.tick()
    expect(f.speeds.every((s) => s === 1)).toBe(true)
  } finally {
    vi.useRealTimers()
  }
})

it("drops what is only for the eyes: code blocks, link targets, markup", () => {
  expect(spokenText("See **[the docs](https://x.dev)** and https://y.dev/a")).toBe("See the docs and a link")
  expect(spokenText("Type this:\n```ts\nconst x = 1\n```\nDone.")).toBe("Type this: Done.")
})

it("says code that slipped into backticks the way a programmer says it out loud", () => {
  expect(spokenText("`express.json()` parses it, so `body.title` is a string.")).toBe(
    "express dot json parses it, so body dot title is a string.",
  )
  expect(spokenText("Now `createTodo` in `src/todos.ts` reads `user_id` and `MAX_RETRIES`.")).toBe(
    "Now create to-do in source slash to-do's dot T S reads user I D and max retries.",
  )
  expect(spokenText("Run `npm test -- --watch` with `_dev_`.")).toBe("Run N P M test dash dash watch with dev.")
})

it("gives words a speech model says wrong the programmer's spelling, and leaves the rest as written", () => {
  expect(spokenText("So req dot body is an object, and the todos array gets it.")).toBe(
    "So rec dot body is an object, and the to-do's array gets it.",
  )
})

it("ends a sentence only where its stop meets a space, so a file name stays whole", () => {
  expect(splitSentences("One. Two? Three! Four")).toEqual(["One.", "Two?", "Three!", "Four"])
  expect(splitSentences("Open server.ts now. Then this, etc. and that.")).toEqual(["Open server.ts now.", "Then this, etc. and that."])
})

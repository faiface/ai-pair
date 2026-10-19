import { describe, expect, it } from "vitest"
import { timeStretch } from "../src/timeStretch"

const RATE = 24000

/** The frequency of a tone, from how often it crosses zero going up, away from the edges. */
function frequency(samples: Float32Array): number {
  const from = Math.floor(samples.length * 0.2)
  const to = Math.floor(samples.length * 0.8)
  let crossings = 0
  for (let i = from + 1; i < to; i++) if (samples[i - 1]! < 0 && samples[i]! >= 0) crossings++
  return crossings / ((to - from) / RATE)
}

describe("time stretch", () => {
  it("plays a tone faster at the same pitch, without gaps or bursts", () => {
    const tone = new Float32Array(RATE).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 220 * i) / RATE))
    for (const rate of [1.25, 1.54, 2]) {
      const fast = timeStretch(tone, rate)
      expect(Math.abs(fast.length - RATE / rate)).toBeLessThan(2)
      expect(Math.abs(frequency(fast) - 220)).toBeLessThan(220 * 0.02)
      // Windows that fail to line up cancel or pile up: the loudness would sag or swell.
      const middle = fast.subarray(Math.floor(fast.length * 0.2), Math.floor(fast.length * 0.8))
      expect(Math.max(...middle.map(Math.abs))).toBeLessThan(0.52)
      let low = 0
      for (let i = 0; i + 240 <= middle.length; i += 240) low = Math.max(low, 0.5 - Math.max(...middle.subarray(i, i + 240).map(Math.abs)))
      expect(low).toBeLessThan(0.02)
    }
  })
})

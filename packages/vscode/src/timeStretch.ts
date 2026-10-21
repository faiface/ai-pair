// Speeds speech up without raising its pitch (WSOLA: waveform-similarity overlap-add). Short
// windows of the recording are laid down at a fixed step, each taken from about where the faster
// pace has reached, nudged to the spot whose waveform best continues the window before, so the
// overlaps add up without the clicks and warble of cutting at arbitrary points.

/** One window: 40 ms at 24 kHz, long enough to hold a few periods of a voice's pitch. */
const WINDOW = 960
const HOP = WINDOW / 2
/** How far a window may be nudged either way: 10 ms, a full period of even a low voice. */
const TOLERANCE = 240

/** `samples` played `rate` times as fast, at the same pitch. A rate of about 1 returns them as they are. */
export function timeStretch(samples: Float32Array, rate: number): Float32Array {
  if (Math.abs(rate - 1) < 0.01 || samples.length < WINDOW + 2 * TOLERANCE) return samples
  const window = new Float32Array(WINDOW)
  for (let i = 0; i < WINDOW; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WINDOW)
  const outLength = Math.floor(samples.length / rate)
  const out = new Float32Array(outLength + WINDOW)
  const weight = new Float32Array(outLength + WINDOW)
  let previous = 0
  for (let at = 0; at < outLength; at += HOP) {
    const nominal = Math.round(at * rate)
    let start = Math.min(nominal, samples.length - WINDOW)
    if (at > 0) {
      // The window before, carried on unbroken, is what the next one should sound like where they overlap.
      const natural = previous + HOP
      let best = -Infinity
      const from = Math.max(0, nominal - TOLERANCE)
      const to = Math.min(samples.length - WINDOW, nominal + TOLERANCE)
      for (let candidate = from; candidate <= to; candidate++) {
        let score = 0
        for (let i = 0; i < HOP; i++) score += samples[candidate + i]! * samples[natural + i]!
        if (score > best) {
          best = score
          start = candidate
        }
      }
    }
    for (let i = 0; i < WINDOW; i++) {
      out[at + i] = out[at + i]! + samples[start + i]! * window[i]!
      weight[at + i] = weight[at + i]! + window[i]!
    }
    previous = start
  }
  for (let i = 0; i < outLength; i++) if (weight[i]! > 1e-3) out[i] = out[i]! / weight[i]!
  return out.subarray(0, outLength)
}

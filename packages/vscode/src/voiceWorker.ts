// The warm voice: a small process (bun or node, never VS Code's own runtime, which refuses the
// speech engine's native code) that loads Kokoro once and makes one WAV per line it is given.
// Lines in: { id, text, voice, speed, out }. Lines out: { type: "ready" }, then per line
// { id, ok, seconds } or { id, ok: false, error }. AI_PAIR_KOKORO_PATH names the kokoro-js module
// to load — the copy the extension fetched into its own storage, so it is only ever downloaded once.

import * as fs from "node:fs"
import * as readline from "node:readline"
import { pathToFileURL } from "node:url"
import { timeStretch } from "./timeStretch"

/**
 * The fastest Kokoro is asked to talk itself. It speeds up by giving each sound fewer frames, and
 * past this the short ones run out of frames and words smear: a speech-to-text check misheard about
 * one word in six at its own 2×, and no more than at 1× when made at 1.3×. Faster than this, the line
 * is made at this pace and its recording sped up at the same pitch, which kept the words as clear.
 */
const MAX_MADE_SPEED = 1.3
const SAMPLE_RATE = 24000

/** Mono samples as a 16-bit PCM WAV file. */
function wav(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(bytes.buffer)
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i))
  }
  text(0, "RIFF")
  view.setUint32(4, 36 + samples.length * 2, true)
  text(8, "WAVEfmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, SAMPLE_RATE, true)
  view.setUint32(28, SAMPLE_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, "data")
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i]!)) * 0x7fff, true)
  return bytes
}

type KokoroModule = {
  KokoroTTS: {
    from_pretrained(
      model: string,
      options: { dtype: string; device: string },
    ): Promise<{
      generate(text: string, options: { voice: string; speed: number }): Promise<{ audio: Float32Array }>
    }>
  }
}

const say = (frame: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(frame)}\n`)

const modulePath = process.env.AI_PAIR_KOKORO_PATH
if (!modulePath) {
  say({ type: "fatal", error: "AI_PAIR_KOKORO_PATH is not set." })
  process.exit(1)
}

// An untyped external module, loaded from wherever it was found on this machine.
const kokoro = (await import(pathToFileURL(modulePath).href)) as KokoroModule
const tts = await kokoro.KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: "q8", device: "cpu" })
say({ type: "ready" })

const lines = readline.createInterface({ input: process.stdin })
for await (const line of lines) {
  if (!line.trim()) continue
  let request: { id?: unknown; text?: unknown; voice?: unknown; speed?: unknown; out?: unknown }
  try {
    request = JSON.parse(line) as typeof request
  } catch {
    continue
  }
  const { id, text, voice, speed, out } = request
  if (typeof id !== "number" || typeof text !== "string" || typeof out !== "string") continue
  try {
    const wanted = typeof speed === "number" && speed > 0 ? speed : 1
    const made = Math.min(wanted, MAX_MADE_SPEED)
    const audio = await tts.generate(text, { voice: typeof voice === "string" && voice ? voice : "af_heart", speed: made })
    const samples = timeStretch(audio.audio, wanted / made)
    fs.writeFileSync(out, wav(samples))
    say({ id, ok: true, seconds: samples.length / SAMPLE_RATE })
  } catch (error) {
    say({ id, ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

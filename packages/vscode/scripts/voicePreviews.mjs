// Makes the voice menu's preview samples (media/voices/*.mp3): every offered voice saying the
// same short line, generated once here and shipped, so hovering a voice just plays a file
// instead of warming an engine up. Run with bun or node after the voice has been used once
// (it borrows the Kokoro install the extension fetched), or point AI_PAIR_KOKORO_PATH at a
// kokoro.js. Chatterbox's own voice needs an Apple Silicon Mac, like the engine; elsewhere
// it is skipped and the shipped sample stands. Needs ffmpeg for the mp3s.

import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const PHRASE = "Hi. I'll talk while we code."
// Keep in step with VOICES in src/voice.ts.
const VOICES = ["af_heart", "af_bella", "af_nicole", "af_aoede", "af_kore", "af_sarah", "am_michael", "am_fenrir", "am_puck", "bf_emma", "bm_george", "bm_fable"]

const here = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.join(here, "..", "media", "voices")
fs.mkdirSync(outDir, { recursive: true })
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-pair-voices-"))

const toMp3 = (wav, name) => {
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", wav, "-af", "loudnorm=I=-18:TP=-2:LRA=11", "-codec:a", "libmp3lame", "-b:a", "40k", "-ar", "24000", "-ac", "1", path.join(outDir, name)])
  console.log(name)
}

const kokoroPath =
  process.env.AI_PAIR_KOKORO_PATH ??
  path.join(os.homedir(), "Library", "Application Support", "Code", "User", "globalStorage", "michalstrba.ai-pair", "kokoro-1.2.1", "node_modules", "kokoro-js", "dist", "kokoro.js")
if (!fs.existsSync(kokoroPath)) {
  console.error(`No Kokoro install at ${kokoroPath}. Use the voice once in VS Code first, or set AI_PAIR_KOKORO_PATH.`)
  process.exit(1)
}
const kokoro = await import(kokoroPath)
const tts = await kokoro.KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: "q8", device: "cpu" })
for (const voice of VOICES) {
  const wav = path.join(tmp, `${voice}.wav`)
  fs.writeFileSync(wav, (await tts.generate(PHRASE, { voice, speed: 1 })).toWav())
  toMp3(wav, `${voice}.mp3`)
}

if (process.platform === "darwin" && process.arch === "arm64") {
  const py = path.join(tmp, "chatterbox.py")
  fs.writeFileSync(
    py,
    [
      "import wave, sys",
      "import numpy as np",
      "from mlx_audio.tts.utils import load_model",
      'model = load_model("mlx-community/chatterbox-turbo-4bit")',
      `audio = np.concatenate([np.array(part.audio, dtype=np.float32) for part in model.generate(text=${JSON.stringify(PHRASE)})])`,
      "pcm = (np.clip(audio, -1, 1) * 32767).astype(np.int16)",
      "with wave.open(sys.argv[1], 'wb') as wav:",
      "    wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(24000)",
      "    wav.writeframes(pcm.tobytes())",
    ].join("\n"),
  )
  const wav = path.join(tmp, "chatterbox.wav")
  execFileSync("uv", ["tool", "run", "--from", "mlx-audio==0.5.9", "python", py, wav], { stdio: "inherit", env: { ...process.env, TQDM_DISABLE: "1" } })
  toMp3(wav, "chatterbox.mp3")
} else {
  console.log("chatterbox.mp3 skipped: needs an Apple Silicon Mac; the shipped sample stands.")
}
const phononWav = path.join(tmp, "phonon.wav")
execFileSync("uv", ["tool", "run", "--python", "3.12", "--from", "ptts==0.4.0", "python", "-c", "import ptts,sys; ptts.TTS(lang='en', device='cpu').save(sys.argv[1], sys.argv[2])", phononWav, PHRASE], { stdio: "inherit" })
toMp3(phononWav, "phonon.mp3")
fs.rmSync(tmp, { recursive: true, force: true })

# The Chatterbox voice: Resemble AI's Chatterbox Turbo, run on the Mac's GPU through mlx-audio, kept
# warm in its own process the way voiceWorker.ts keeps Kokoro. uv runs it, so its Python and packages
# come and go with uv's cache instead of the machine's own Python.
# Lines in: { id, text, voice, out }, where `voice` is "" for the model's own voice or the path of a
# recording to speak like. Lines out: { type: "ready" }, then per line { id, ok, seconds } or
# { id, ok: false, error }. Fatal trouble before ready: { type: "fatal", error }.

import json
import os
import sys
import wave

# Anything the libraries print would garble the replies, so stdout is ours alone and they get stderr.
replies = sys.stdout
sys.stdout = sys.stderr


def say(frame):
    replies.write(json.dumps(frame) + "\n")
    replies.flush()


try:
    import numpy as np
    from mlx_audio.tts.utils import load_model

    model = load_model(os.environ.get("AI_PAIR_CHATTERBOX_MODEL", "mlx-community/chatterbox-turbo-4bit"))
    own_voice = model._conds
    # The first line made pays for compiling the model; better here than in the person's first sentence.
    for _ in model.generate(text="Ready."):
        pass
except Exception as error:  # noqa: BLE001 - whatever stopped the load is what the person needs to read.
    say({"type": "fatal", "error": str(error) or type(error).__name__})
    sys.exit(1)

say({"type": "ready"})

voice_now = ""
for line in sys.stdin:
    if not line.strip():
        continue
    try:
        request = json.loads(line)
    except ValueError:
        continue
    id, text, out = request.get("id"), request.get("text"), request.get("out")
    if not isinstance(id, int) or not isinstance(text, str) or not isinstance(out, str):
        continue
    try:
        voice = request.get("voice") if isinstance(request.get("voice"), str) else ""
        if voice != voice_now:
            # Listening to a recording takes a moment, so it is done once per change of voice.
            if voice:
                model.prepare_conditionals(voice)
            else:
                model._conds = own_voice
            voice_now = voice
        audio = np.concatenate([np.array(part.audio, dtype=np.float32) for part in model.generate(text=text)])
        pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2")
        with wave.open(out, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(model.sample_rate)
            wav.writeframes(pcm.tobytes())
        say({"id": id, "ok": True, "seconds": len(audio) / model.sample_rate})
    except Exception as error:  # noqa: BLE001 - one bad line must not end the voice.
        voice_now = None
        say({"id": id, "ok": False, "error": str(error) or type(error).__name__})

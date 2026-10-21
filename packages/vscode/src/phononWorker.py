# Phonon 31m, kept warm under uv. Same JSON-line protocol as the other voice workers.
# Lines in: { id, text, speed, out }. Replies: ready/fatal, then { id, ok, seconds/error }.
import json
import math
import os
import sys
from pathlib import Path

replies = sys.stdout
sys.stdout = sys.stderr


def say(frame):
    replies.write(json.dumps(frame) + "\n")
    replies.flush()


try:
    import ptts

    # The pinned package pins its default model revision too. A local path on ordinary
    # startup prevents even a cache check from fetching files without a person's click.
    source = ptts.DEFAULT_MODEL
    if os.environ.get("AI_PAIR_PHONON_OFFLINE") == "1":
        repo, revision = source.removeprefix("hf://").split("@")
        source = str(
            Path(os.environ["HF_HOME"])
            / "hub"
            / ("models--" + repo.replace("/", "--"))
            / "snapshots"
            / revision
        )
    model = ptts.TTS(source, lang="en", device="cpu")
    model.synth("Ready.")
except Exception as error:
    say({"type": "fatal", "error": str(error) or type(error).__name__})
    sys.exit(1)

say({"type": "ready"})

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
        speed = request.get("speed", 1)
        if (
            not isinstance(speed, (int, float))
            or not math.isfinite(speed)
            or speed <= 0
        ):
            speed = 1
        speed = min(2, max(0.5, speed))
        # Ask for shorter or longer sounds without changing their pitch.
        model.set_conditions({"duration_delta": 1 / speed - 1})
        seconds = model.save(out, text)
        say({"id": id, "ok": True, "seconds": seconds})
    except Exception as error:
        say({"id": id, "ok": False, "error": str(error) or type(error).__name__})

#!/usr/bin/env python3
"""Bounded one-shot Kokoro-82M synthesis sidecar (offline; Apache-2.0 weights, no voice cloning).

Invoked by the Java LocalKokoroSynthesizer as a bounded process (no shell, cleared environment):

  python -I kokoro_synth.py --model-dir DIR --voice af_heart --speed 1.0 --lang a \
      --text-file in.txt --out out.wav

* Loads only local files: DIR/kokoro-v1_0.pth, DIR/config.json and DIR/voices/<voice>.pt. Network access
  is disabled (HF_HUB_OFFLINE=1 is set by the caller and enforced again here).
* The voice name is restricted to a fixed pattern and must resolve to a file inside DIR/voices. Only the
  voice packs shipped with the verified model are usable; this tool offers no voice cloning or embedding import.
* Writes a mono 24 kHz signed 16-bit PCM WAV and prints one JSON line to stdout. Nothing else is printed.
"""
import argparse
import json
import os
import re
import sys

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"

SAMPLE_RATE = 24000
MAX_CHARS = 2000
VOICE_PATTERN = re.compile(r"^[a-z]{2}_[a-z]{2,16}$")
LANG_CODES = {"a", "b"}  # American / British English (the verified language of this profile)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--voice", required=True)
    parser.add_argument("--speed", type=float, default=1.0)
    parser.add_argument("--lang", default="a")
    parser.add_argument("--text-file", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    if not VOICE_PATTERN.match(args.voice):
        sys.exit("invalid voice id")
    if args.lang not in LANG_CODES:
        sys.exit("unsupported language code")
    if not (0.5 <= args.speed <= 2.0):
        sys.exit("speed outside [0.5, 2.0]")
    model_dir = os.path.realpath(args.model_dir)
    voice_path = os.path.realpath(os.path.join(model_dir, "voices", args.voice + ".pt"))
    if not voice_path.startswith(os.path.join(model_dir, "voices") + os.sep) or not os.path.isfile(voice_path):
        sys.exit("voice pack is not part of the installed model")
    with open(args.text_file, "r", encoding="utf-8") as handle:
        text = handle.read(MAX_CHARS + 1)
    text = text.strip()
    if not text or len(text) > MAX_CHARS:
        sys.exit("text must be 1-%d characters" % MAX_CHARS)

    import numpy as np
    import soundfile as sf
    from kokoro import KModel, KPipeline

    model = KModel(config=os.path.join(model_dir, "config.json"),
                   model=os.path.join(model_dir, "kokoro-v1_0.pth"), repo_id="hexgrad/Kokoro-82M")
    pipeline = KPipeline(lang_code=args.lang, model=model, repo_id="hexgrad/Kokoro-82M")
    chunks = []
    for _, _, audio in pipeline(text, voice=voice_path, speed=args.speed):
        if audio is not None:
            chunks.append(np.asarray(audio, dtype=np.float32))
    if not chunks:
        sys.exit("synthesis produced no audio")
    samples = np.concatenate(chunks)
    sf.write(args.out, samples, SAMPLE_RATE, subtype="PCM_16", format="WAV")
    print(json.dumps({"sampleRate": SAMPLE_RATE, "samples": int(samples.shape[0]), "voice": args.voice}))


if __name__ == "__main__":
    main()

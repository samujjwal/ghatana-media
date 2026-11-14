#!/usr/bin/env bash
# Regenerates the server-owned local-model manifests (outside the repository) from the files actually installed
# under ${MEDIA_LOCAL_MODEL_ROOT:-$HOME/.local/share/ghatana-media}. Re-run after any change to the pinned
# kokoro_synth.py sidecar or to the whisper.cpp binary, because their digests are enforced by the verifier.
#
# This script records what is on disk; it neither downloads weights nor decides licence acceptability. The Java
# verifier (LocalModelManifest.verify) enforces MIT for speech-to-text and Apache-2.0 for text-to-speech.
set -euo pipefail
ROOT="${MEDIA_LOCAL_MODEL_ROOT:-$HOME/.local/share/ghatana-media}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAKE="$HERE/make_manifest.py"

WHISPER_REV="${WHISPER_MODEL_REVISION:-5359861c739e955e79d9a303bcbc70fb988958b1}"
WHISPER_CPP_REV="${WHISPER_CPP_REVISION:-d1be6fde11ac6e0407606b4e42fe72d34add8037}"
python3 -I "$MAKE" --model-root "$ROOT/models/whisper-large-v3-turbo" --key whisper-large-v3-turbo \
  --modality SPEECH_TO_TEXT \
  --model-id "openai/whisper-large-v3-turbo (ggml conversion distributed by ggerganov/whisper.cpp)" \
  --source-url https://huggingface.co/ggerganov/whisper.cpp --revision "$WHISPER_REV" \
  --spdx MIT --license-source-url https://raw.githubusercontent.com/openai/whisper/main/LICENSE \
  --file WEIGHTS:ggml-large-v3-turbo.bin --file LICENSE:LICENSE-openai-whisper.txt \
  --file LICENSE:LICENSE-whisper.cpp.txt --file MODEL_CARD:MODEL_CARD_README.md --language en \
  --notice "Whisper model weights (c) 2022 OpenAI, MIT License; whisper.cpp / ggml (c) 2023-2026 The ggml authors, MIT License. The MIT copyright and permission notice must be preserved in copies or substantial portions." \
  --notice-required --runtime-name whisper.cpp --runtime-version v1.9.5 --runtime-revision "$WHISPER_CPP_REV" \
  --runtime-exe "$ROOT/runtimes/whisper.cpp-src/build/bin/whisper-cli" \
  --out "$ROOT/models/whisper-large-v3-turbo/manifest.json"

KOKORO_REV="${KOKORO_MODEL_REVISION:-f3ff3571791e39611d31c381e3a41a3af07b4987}"
python3 -I "$MAKE" --model-root "$ROOT/models/kokoro-82m" --key kokoro-82m --modality TEXT_TO_SPEECH \
  --model-id "hexgrad/Kokoro-82M" --source-url https://huggingface.co/hexgrad/Kokoro-82M \
  --revision "$KOKORO_REV" --spdx Apache-2.0 \
  --license-source-url https://huggingface.co/hexgrad/Kokoro-82M/blob/$KOKORO_REV/README.md \
  --file WEIGHTS:kokoro-v1_0.pth --file CONFIG:config.json --file VOICE:voices/af_heart.pt \
  --file VOICE:voices/am_michael.pt --file LICENSE:LICENSE-Apache-2.0.txt --file MODEL_CARD:README.md \
  --language en \
  --notice "Kokoro-82M (c) hexgrad, licensed under the Apache License 2.0; the model repository ships no LICENSE file, the licence is declared in the model-card metadata at the pinned revision and LICENSE-Apache-2.0.txt is the canonical text from apache.org. Apache-2.0 attribution and licence copy must accompany redistribution. The kokoro/misaki Python packages are Apache-2.0; their English phonemizer fallback pulls GPL-3.0+ components (phonemizer-fork, espeak-ng) which are installed locally and must not be redistributed with this product without GPL compliance." \
  --notice-required --voice-cloning NOT_SUPPORTED \
  --runtime-name kokoro --runtime-version "kokoro 0.9.4 / misaki 0.9.4 / torch 2.15.0" \
  --runtime-exe "$HERE/kokoro_synth.py" \
  --out "$ROOT/models/kokoro-82m/manifest.json"
echo "manifests written under $ROOT/models/*/manifest.json"

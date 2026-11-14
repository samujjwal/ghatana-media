# Local vision and multimodal model runtime

Owner decision, 2026-11-14 (verbatim): "Local open models (Recommended): Whisper large-v3-turbo via whisper.cpp for
speech-to-text (MIT). Kokoro-82M for text-to-speech (Apache-2.0, no voice cloning). Florence-2 for vision (MIT).
Qwen2.5-VL-7B for multimodal (Apache-2.0). Media stays on this machine, with no per-use cost." and "we will abide by all
license requirements."

This directory holds only code. Weights, the Python environment and manifests live outside the repository and are never
committed: `~/.local/share/ghatana-media/models/<name>/` and `~/.local/share/ghatana-media/runtimes/vision-venv/`.

| Model | Source (pinned revision) | SPDX | Runtime |
| --- | --- | --- | --- |
| Florence-2-large | `florence-community/Florence-2-large` `4271c66b88cdbc05735372ec13b2360108de5317` (transformers-native conversion of Microsoft's model; no remote code) | MIT | transformers, fp16 |
| Qwen2.5-VL-7B-Instruct | `Qwen/Qwen2.5-VL-7B-Instruct` `cc594898137f460bfe9f0759e9844b3ce807cfb5` | Apache-2.0 | transformers + bitsandbytes nf4 (about 7.6 GB VRAM) |

A GGUF/llama.cpp route was not used: it would need a CUDA toolchain (`nvcc` is not installed on the reference host);
the transformers 4-bit path is the robust option there.

## Install (operator, once)

```bash
uv venv --python 3.12 ~/.local/share/ghatana-media/runtimes/vision-venv
uv pip install --python ~/.local/share/ghatana-media/runtimes/vision-venv/bin/python \
  torch torchvision transformers accelerate bitsandbytes pillow safetensors
# Download the two model repositories at the revisions above into
#   ~/.local/share/ghatana-media/models/florence-2-large/
#   ~/.local/share/ghatana-media/models/qwen2.5-vl-7b-instruct/
# READ each LICENSE / model card first. Proceed only if Florence-2 is MIT and Qwen2.5-VL-7B-Instruct is Apache-2.0.
# Qwen's repository has no LICENSE file: keep the Apache-2.0 text from github.com/QwenLM/Qwen2.5-VL beside the weights.
python3 tools/model-runtimes/vision/make_manifest.py --model-dir <dir> --model-id <id> --role VISION|MULTIMODAL_QA ...
```

`make_manifest.py` hashes what is on disk (and refuses if a file differs from an upstream-published digest you pass with
`--upstream-sha256`), then writes `ghatana-model-manifest.json` (schema: `../schemas/local-model-manifest.schema.json`,
template: `../schemas/local-model-manifest.template.json`). The Java host and the sidecar both refuse a model whose files
do not match its manifest.

## Run

```bash
GHATANA_VISION_SIDECAR_TOKEN=<random >= 24 chars> \
  ~/.local/share/ghatana-media/runtimes/vision-venv/bin/python -I tools/model-runtimes/vision/vision_sidecar.py \
  --port 18765 --models-root ~/.local/share/ghatana-media/models [--preload]
```

It binds 127.0.0.1 only and requires `Authorization: Bearer <token>`. Then start the Media launcher with
`MEDIA_LOCAL_VISION_MODELS_ROOT`, `MEDIA_LOCAL_VISION_SIDECAR_URL=http://127.0.0.1:18765` and
`MEDIA_LOCAL_VISION_SIDECAR_TOKEN` (see `docs/surfaces/launcher/README.md`). The first Qwen request also loads the model
(about 90 s including digest verification); later requests take a few seconds. Keep VRAM modest on shared GPUs: Florence-2
about 1.5 GB, Qwen2.5-VL 4-bit about 6 GB.

## Licence obligations

See `THIRD_PARTY_NOTICES.md` (MIT notice for Florence-2; Apache-2.0 for Qwen2.5-VL, with the nf4 quantization applied in
memory so the on-disk weights are unmodified). Florence-2 scene text is its own OCR task and is not the Document
Intelligence OCR gateway. No accuracy or quality claim is made for either model.

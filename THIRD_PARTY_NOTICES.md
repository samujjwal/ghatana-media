# Third-party notices

Media runs open speech models locally under the owner decision of 2026-11-14 (quoted verbatim in
`libs/java/common/src/main/java/com/ghatana/media/runtime/localmodel/LocalModelManifest.java` and in every local model
manifest): "Local open models (Recommended): Whisper large-v3-turbo via whisper.cpp for speech-to-text (MIT).
Kokoro-82M for text-to-speech (Apache-2.0, no voice cloning). Florence-2 for vision (MIT). Qwen2.5-VL-7B for
multimodal (Apache-2.0). Media stays on this machine, with no per-use cost." The owner added: "we will abide by all
license requirements."

**Model weights and runtimes are never committed to this repository.** They are installed outside the repo under
`~/.local/share/ghatana-media/` and verified by SHA-256 against a server-owned manifest before use
(`tools/model-runtimes/`, `config/model-runtimes/`). This file records the licence obligations of what is installed
and invoked as a separate process. Entries for the vision/multimodal models are owned by the vision workstream.

## Speech-to-text

| Component | Version / revision | SPDX | Source |
| --- | --- | --- | --- |
| OpenAI Whisper large-v3-turbo weights (ggml conversion) | `ggerganov/whisper.cpp` HF revision `5359861c739e955e79d9a303bcbc70fb988958b1` (card: `license: mit`) | MIT | https://huggingface.co/ggerganov/whisper.cpp |
| OpenAI Whisper (model licence text) | upstream `LICENSE`, copyright (c) 2022 OpenAI | MIT | https://github.com/openai/whisper |
| whisper.cpp / ggml (inference runtime, built locally) | v1.9.5, commit `d1be6fde11ac6e0407606b4e42fe72d34add8037` | MIT | https://github.com/ggml-org/whisper.cpp |

MIT obligation: the copyright and permission notice below must be preserved in copies or substantial portions of the
software or weights. Verified licence files (SHA-256): OpenAI Whisper `LICENSE`
`b5d65a59060e68c4ff940e1eddfa6f94b2d68fdf58ed7f4dd57721c997e35e9d`; whisper.cpp `LICENSE`
`94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d`.

> MIT License. Copyright (c) 2022 OpenAI. Copyright (c) 2023-2026 The ggml authors. Permission is hereby granted,
> free of charge, to any person obtaining a copy of this software and associated documentation files (the
> "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy,
> modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom
> the Software is furnished to do so, subject to the following conditions: The above copyright notice and this
> permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS
> PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED. (Full text: the two `LICENSE-*.txt` files
> stored beside the weights and pinned by digest in the manifest.)

## Text-to-speech

| Component | Version / revision | SPDX | Source |
| --- | --- | --- | --- |
| Kokoro-82M weights, config and voice packs (`af_heart`, `am_michael`) | `hexgrad/Kokoro-82M` HF revision `f3ff3571791e39611d31c381e3a41a3af07b4987` (card: `license: apache-2.0`) | Apache-2.0 | https://huggingface.co/hexgrad/Kokoro-82M |
| `kokoro` Python package | 0.9.4 | Apache-2.0 | https://pypi.org/project/kokoro/ |
| `misaki` G2P package | 0.9.4 | Apache-2.0 | https://pypi.org/project/misaki/ |
| spaCy `en_core_web_sm` (used by misaki) | 3.8.0 | MIT | https://github.com/explosion/spacy-models |
| PyTorch, NumPy, soundfile, Hugging Face Hub | torch 2.15.0 and others, installed in a dedicated venv | BSD-3-Clause / Apache-2.0 / MIT mix | see each package's metadata |

Apache-2.0 obligations: provide a copy of the licence with any redistribution, retain copyright/attribution notices,
and state significant changes. The Kokoro model repository ships **no `LICENSE` file**; the licence is declared in the
model-card metadata at the pinned revision, and the canonical text (SHA-256
`cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`, stored beside the weights as `LICENSE-Apache-2.0.txt`) was fetched from
https://www.apache.org/licenses/LICENSE-2.0.txt. Kokoro is used for synthesis with the shipped voice packs only; **no
voice cloning or voice-embedding import** is offered by this integration.

### GPL components in the Kokoro runtime (do not redistribute the venv)

The English pronunciation fallback of `misaki` pulls `phonemizer-fork` (GPL-3.0-or-later) and the `espeak-ng`
library (GPL-3.0-or-later) through `espeakng-loader`. They are installed only on the operator's machine, in the
sidecar's private virtual environment, and run as a separate process behind `tools/model-runtimes/kokoro_synth.py`.
Nothing GPL is committed to or shipped by this repository. **Do not redistribute that virtual environment, a container
image containing it, or the espeak-ng binaries with this product without satisfying the GPL (source offer, licence
text).** This was flagged to the owner when the runtime was installed.

<!-- SECTION: local-vision-and-multimodal (begin) -->
## Local vision and multimodal models (Florence-2, Qwen2.5-VL-7B-Instruct)

Owner decision (2026-11-14, verbatim): "Local open models (Recommended): Whisper large-v3-turbo via whisper.cpp for
speech-to-text (MIT). Kokoro-82M for text-to-speech (Apache-2.0, no voice cloning). Florence-2 for vision (MIT).
Qwen2.5-VL-7B for multimodal (Apache-2.0). Media stays on this machine, with no per-use cost."

### Florence-2-large — MIT

- Model: `florence-community/Florence-2-large` at revision `4271c66b88cdbc05735372ec13b2360108de5317`
  (https://huggingface.co/florence-community/Florence-2-large), the transformers-native converted checkpoint of
  Microsoft's Florence-2-large. The model card declares `license: mit`; the MIT text below was read from
  `microsoft/Florence-2-large` at revision `21a599d414c4d928c9032694c424fb94458e3594`, the upstream the card's
  `license_link` names.
- Weights SHA-256: `7715423d6549bf1e71188bdd84f4ac960cc0597886af24a5ef7b66f128660685` (equals the host-published LFS digest).
- Used by: the local vision sidecar (`tools/model-runtimes/vision/vision_sidecar.py`) for caption, object detection and
  scene-text. No remote code is executed.

```
MIT License

Copyright (c) Microsoft Corporation.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE
```

### Qwen2.5-VL-7B-Instruct — Apache License 2.0

- Model: `Qwen/Qwen2.5-VL-7B-Instruct` at revision `cc594898137f460bfe9f0759e9844b3ce807cfb5`
  (https://huggingface.co/Qwen/Qwen2.5-VL-7B-Instruct). Copyright Alibaba Cloud (Qwen team). The model card declares
  `license: apache-2.0`; the model repository carries no LICENSE file, so the full licence text was taken from the
  upstream QwenLM/Qwen2.5-VL repository (`LICENSE`, 11357 bytes) and is kept beside the weights.
- Weight shard SHA-256 values are the host-published LFS digests (recorded in the manifest).
- Used by: the local vision sidecar for visual question answering. 4-bit (bitsandbytes nf4) quantization is applied
  at load time in memory; the files on disk are unmodified, so no modified redistribution occurs. If the weights are
  ever redistributed, include the full Apache-2.0 text, retain all notices and state any changes.
- Apache License 2.0 full text: http://www.apache.org/licenses/LICENSE-2.0 (also stored as `LICENSE` in the model
  directory and covered by the manifest digest).

### Runtime libraries (installed into the sidecar virtual environment, not redistributed)

PyTorch 2.15.0 (package metadata: Apache-2.0 AND BSD-2-Clause AND BSD-3-Clause AND BSL-1.0 AND ISC AND MIT AND Zlib,
among others), Hugging Face Transformers 5.23.0 (Apache-2.0), bitsandbytes 0.50.2 (MIT), Pillow 13.0.0 (MIT-CMU),
safetensors 0.8.0 (Apache Software License). Licences are as read from each installed package's metadata. They are installed from PyPI by the operator and are not vendored here.
<!-- SECTION: local-vision-and-multimodal (end) -->

#!/usr/bin/env python3
"""Loopback-only local vision/multimodal inference sidecar for Ghatana Media.

Serves two open models, both loaded from a digest-pinned local directory:
  * Florence-2-large (MIT, native transformers conversion) -> POST /v1/analyze (caption / detect / ocr)
  * Qwen2.5-VL-7B-Instruct (Apache-2.0) -> POST /v1/ask      (visual question answering)

Owner decision (2026-11-14): "Local open models (Recommended): Whisper large-v3-turbo via
whisper.cpp for speech-to-text (MIT). Kokoro-82M for text-to-speech (Apache-2.0, no voice
cloning). Florence-2 for vision (MIT). Qwen2.5-VL-7B for multimodal (Apache-2.0). Media stays
on this machine, with no per-use cost."

Security posture:
  * binds 127.0.0.1 only (any other --host is refused);
  * every request needs `Authorization: Bearer <token>` (token from the environment variable
    named by --token-env; the process refuses to start without one);
  * the model directories must carry a manifest and every listed file (weights, config,
    tokenizer) must match its
    SHA-256 before the model is loaded; a mismatch refuses that model;
  * no network access for models: HF_HUB_OFFLINE=1, local_files_only=True;
  * request bodies, image size, pixel count, token counts and per-request time are bounded;
  * inference is serialized by one lock (one GPU), greedy decoding (deterministic);
  * image/question content is never logged.
"""
import argparse
import base64
import binascii
import hashlib
import hmac
import io
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_BODY_BYTES = 40 * 1024 * 1024
MAX_IMAGE_BYTES = 32 * 1024 * 1024
MAX_PIXELS = 40_000_000
MAX_QUESTION_CHARS = 2000
MAX_NEW_TOKENS = 512
FLORENCE_TASKS = {
    "caption": "<MORE_DETAILED_CAPTION>",
    "detect": "<OD>",
    "ocr": "<OCR_WITH_REGION>",
}
MANIFEST_NAME = "ghatana-model-manifest.json"


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def verify_manifest(model_dir, expected_model_id, expected_spdx):
    """Return the manifest after verifying licence id and the digest of every listed file."""
    path = os.path.join(model_dir, MANIFEST_NAME)
    with open(path, "r", encoding="utf-8") as handle:
        manifest = json.load(handle)
    if manifest.get("modelId") != expected_model_id:
        raise RuntimeError("manifest modelId mismatch")
    if manifest.get("spdxLicense") != expected_spdx:
        raise RuntimeError("manifest licence is not " + expected_spdx)
    for entry in manifest["files"]:
        rel = entry["path"]
        if rel.startswith("/") or ".." in rel.split("/"):
            raise RuntimeError("manifest path escapes the model directory")
        full = os.path.join(model_dir, rel)
        if not os.path.isfile(full) or sha256_file(full) != entry["sha256"]:
            raise RuntimeError("digest mismatch for " + rel)
    return manifest


class Engines:
    def __init__(self, florence_dir, qwen_dir, device, qwen_max_pixels):
        self.florence_dir = florence_dir
        self.qwen_dir = qwen_dir
        self.device = device
        self.qwen_max_pixels = qwen_max_pixels
        self.lock = threading.Lock()
        self._florence = None
        self._qwen = None
        self.florence_manifest = None
        self.qwen_manifest = None

    # ---- loading ----
    def load_florence(self):
        if self._florence is not None:
            return self._florence
        import torch
        from transformers import AutoModelForImageTextToText, AutoProcessor
        self.florence_manifest = verify_manifest(self.florence_dir, "florence-community/Florence-2-large", "MIT")
        dtype = torch.float16 if self.device.startswith("cuda") else torch.float32
        # Native transformers Florence2 implementation: no remote code is ever executed.
        model = AutoModelForImageTextToText.from_pretrained(
            self.florence_dir, local_files_only=True, dtype=dtype).to(self.device).eval()
        processor = AutoProcessor.from_pretrained(self.florence_dir, local_files_only=True)
        self._florence = (model, processor, dtype)
        return self._florence

    def load_qwen(self):
        if self._qwen is not None:
            return self._qwen
        import torch
        from transformers import AutoProcessor, BitsAndBytesConfig, Qwen2_5_VLForConditionalGeneration
        self.qwen_manifest = verify_manifest(self.qwen_dir, "Qwen/Qwen2.5-VL-7B-Instruct", "Apache-2.0")
        quant = BitsAndBytesConfig(
            load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_use_double_quant=True,
            bnb_4bit_compute_dtype=torch.float16)
        model = Qwen2_5_VLForConditionalGeneration.from_pretrained(
            self.qwen_dir, local_files_only=True, quantization_config=quant,
            dtype=torch.float16, device_map={"": self.device}).eval()
        processor = AutoProcessor.from_pretrained(
            self.qwen_dir, local_files_only=True,
            min_pixels=64 * 28 * 28, max_pixels=self.qwen_max_pixels)
        self._qwen = (model, processor)
        return self._qwen

    # ---- inference ----
    def analyze(self, image, tasks, max_new_tokens):
        import torch
        model, processor, dtype = self.load_florence()
        results = {}
        for task in tasks:
            prompt = FLORENCE_TASKS[task]
            inputs = processor(text=prompt, images=image, return_tensors="pt")
            inputs = {k: (v.to(self.device, dtype) if v.is_floating_point() else v.to(self.device))
                      for k, v in inputs.items()}
            with torch.inference_mode():
                ids = model.generate(**inputs, max_new_tokens=max_new_tokens, num_beams=3, do_sample=False)
            text = processor.batch_decode(ids, skip_special_tokens=False)[0]
            parsed = processor.post_process_generation(text, task=prompt, image_size=image.size)[prompt]
            results[task] = parsed
        return results

    def ask(self, image, question, max_new_tokens):
        import torch
        model, processor = self.load_qwen()
        messages = [{"role": "user", "content": [
            {"type": "image"}, {"type": "text", "text": question}]}]
        text = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        inputs = processor(text=[text], images=[image], padding=True, return_tensors="pt").to(self.device)
        with torch.inference_mode():
            ids = model.generate(**inputs, max_new_tokens=max_new_tokens, do_sample=False)
        trimmed = ids[:, inputs["input_ids"].shape[1]:]
        return processor.batch_decode(trimmed, skip_special_tokens=True)[0].strip()


def decode_image(b64):
    from PIL import Image
    try:
        raw = base64.b64decode(b64, validate=True)
    except (binascii.Error, ValueError):
        raise ValueError("imageBase64 is not valid base64")
    if not raw or len(raw) > MAX_IMAGE_BYTES:
        raise ValueError("image size is outside the allowed range")
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    try:
        image = Image.open(io.BytesIO(raw))
        if image.format not in ("PNG", "JPEG", "GIF", "WEBP", "BMP"):
            raise ValueError("unsupported image format")
        if image.width * image.height > MAX_PIXELS:
            raise ValueError("image has too many pixels")
        image.load()
    except ValueError:
        raise
    except Exception:
        raise ValueError("image could not be decoded")
    return image.convert("RGB")


def make_handler(engines, token):
    class Handler(BaseHTTPRequestHandler):
        server_version = "ghatana-vision-sidecar/1"
        timeout = 30

        def log_message(self, fmt, *args):  # never log request content
            return

        def _send(self, status, body):
            data = json.dumps(body, separators=(",", ":")).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def _authorized(self):
            supplied = self.headers.get("Authorization", "")
            return hmac.compare_digest(supplied, "Bearer " + token)

        def do_GET(self):
            if not self._authorized():
                return self._send(401, {"error": "UNAUTHORIZED"})
            if self.path == "/v1/health":
                return self._send(200, {
                    "status": "UP",
                    "floren2Loaded": engines._florence is not None,
                    "qwenLoaded": engines._qwen is not None})
            return self._send(404, {"error": "NOT_FOUND"})

        def do_POST(self):
            if not self._authorized():
                return self._send(401, {"error": "UNAUTHORIZED"})
            if self.path not in ("/v1/analyze", "/v1/ask"):
                return self._send(404, {"error": "NOT_FOUND"})
            try:
                length = int(self.headers.get("Content-Length", "-1"))
            except ValueError:
                length = -1
            if length <= 0 or length > MAX_BODY_BYTES:
                return self._send(413, {"error": "BODY_SIZE_INVALID"})
            try:
                request = json.loads(self.rfile.read(length))
                image = decode_image(request.get("imageBase64", ""))
                max_new = int(request.get("maxNewTokens", 256))
                if not 1 <= max_new <= MAX_NEW_TOKENS:
                    raise ValueError("maxNewTokens is outside the allowed range")
                started = time.monotonic()
                with engines.lock:
                    if self.path == "/v1/analyze":
                        tasks = request.get("tasks", [])
                        if not tasks or any(t not in FLORENCE_TASKS for t in tasks):
                            raise ValueError("tasks must be a non-empty subset of caption, detect, ocr")
                        output = {"results": engines.analyze(image, list(dict.fromkeys(tasks)), max_new),
                                  "imageSize": {"width": image.width, "height": image.height}}
                    else:
                        question = request.get("question", "")
                        if not isinstance(question, str) or not question.strip() \
                                or len(question) > MAX_QUESTION_CHARS:
                            raise ValueError("question is outside the allowed range")
                        output = {"answer": engines.ask(image, question, max_new),
                                  "imageSize": {"width": image.width, "height": image.height}}
                output["elapsedMillis"] = int((time.monotonic() - started) * 1000)
                self._send(200, output)
            except ValueError as invalid:
                self._send(400, {"error": "INVALID_REQUEST", "message": str(invalid)[:200]})
            except Exception as failure:  # model/runtime failure: typed, no content echoed
                sys.stderr.write("inference failure: %s\n" % type(failure).__name__)
                self._send(500, {"error": "INFERENCE_FAILED", "type": type(failure).__name__})
    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--models-root", required=True)
    parser.add_argument("--florence-dir", default="florence-2-large")
    parser.add_argument("--qwen-dir", default="qwen2.5-vl-7b-instruct")
    parser.add_argument("--token-env", default="GHATANA_VISION_SIDECAR_TOKEN")
    parser.add_argument("--device", default="cuda:0")
    parser.add_argument("--qwen-max-pixels", type=int, default=1024 * 28 * 28)
    parser.add_argument("--preload", action="store_true")
    args = parser.parse_args()
    if args.host not in ("127.0.0.1", "::1", "localhost"):
        sys.exit("refusing a non-loopback bind address")
    token = os.environ.get(args.token_env, "")
    if len(token) < 24:
        sys.exit("a bearer token of at least 24 characters is required in $" + args.token_env)
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    engines = Engines(os.path.join(args.models_root, args.florence_dir),
                      os.path.join(args.models_root, args.qwen_dir), args.device, args.qwen_max_pixels)
    if args.preload:
        engines.load_florence()
        engines.load_qwen()
    server = ThreadingHTTPServer((args.host, args.port), make_handler(engines, token))
    server.daemon_threads = True
    sys.stderr.write("vision sidecar listening on %s:%d\n" % (args.host, args.port))
    sys.stderr.flush()
    server.serve_forever()


if __name__ == "__main__":
    main()

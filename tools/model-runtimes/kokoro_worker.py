#!/usr/bin/env python3
"""Persistent loopback Kokoro-82M synthesis worker (offline; Apache-2.0 weights, no voice cloning).

Started and supervised by the Java LocalKokoroWorker as a child process (no shell, cleared environment):

  python -I kokoro_worker.py --model-dir DIR --manifest DIR/manifest.json --port N --token-env VAR

It loads the model once and then serves POST /v1/synthesize, so a call no longer pays interpreter start-up, the
torch import and the weight load that the one-shot kokoro_synth.py pays every time. The one-shot path stays as
the fallback and is unchanged.

Security posture (mirrors the vision sidecar):
  * binds 127.0.0.1 only (any other --host is refused); every request needs `Authorization: Bearer <token>`
    (token from the environment variable named by --token-env, at least 24 characters);
  * REFUSES TO SERVE unless every file listed in the manifest (weights, config, voices, licence, card) and this
    very script match their pinned SHA-256 (runtime.workerSha256 in the manifest). The files are re-checked
    (size / mtime / inode, then re-hashed on any change) before each request and on health probes; a mismatch
    turns the worker permanently REFUSED (503 FILES_CHANGED) until it is restarted against a re-verified install;
  * only voice packs listed in the manifest can be used; no voice embedding can be supplied (no cloning);
  * requests are bounded: body size, text length, speed, deadline and queue depth (one synthesis at a time, a
    small bounded wait queue, anything beyond it is refused 429 BUSY);
  * the deadline is checked while waiting and between synthesis chunks; an exceeded deadline answers 504 and the
    audio is discarded (never a partial success);
  * HF_HUB_OFFLINE=1; request text is never logged.

Device: CUDA when torch reports it is available (the pip torch wheel ships its own CUDA runtime), otherwise CPU.
The device actually used is reported by GET /v1/health and the X-Kokoro-Device response header.
"""
import argparse
import hashlib
import hmac
import json
import os
import re
import struct
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"

SAMPLE_RATE = 24000
MAX_CHARS = 2000
MAX_BODY_BYTES = 64 * 1024
MAX_WAV_BYTES = 8 * 1024 * 1024
MAX_DEADLINE_MILLIS = 180_000
MAX_WAITING = 2
VOICE_PATTERN = re.compile(r"^[a-z]{2}_[a-z]{2,16}$")
LANG_CODES = {"a", "b"}
CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")


# ---------------------------------------------------------------- integrity ----------------------------------

def _sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _stat_key(path):
    info = os.lstat(path)
    return (info.st_size, info.st_mtime_ns, info.st_ino, info.st_dev)


class IntegrityError(Exception):
    pass


class Verifier:
    """Tracks the pinned files; cheap stat comparison per request, re-hash only when a file's stat changed."""

    def __init__(self, model_dir, manifest, script_path):
        self.lock = threading.Lock()
        self.refused = ""
        self.expected = {}
        self.voices = set()
        rel_paths = []
        for entry in manifest.get("files", []):
            rel = entry.get("path", "")
            if not rel or rel.startswith("/") or ".." in rel.split("/"):
                raise IntegrityError("manifest path escapes the model directory")
            full = os.path.join(model_dir, rel)
            self.expected[full] = entry.get("sha256", "")
            rel_paths.append(rel)
            if entry.get("role") == "VOICE" and rel.startswith("voices/") and rel.endswith(".pt"):
                self.voices.add(rel[len("voices/"):-3])
        if not self.expected or not self.voices:
            raise IntegrityError("manifest lists no files or no voices")
        runtime = manifest.get("runtime") or {}
        pinned = runtime.get("workerSha256", "")
        if runtime.get("name") != "kokoro" or not re.fullmatch(r"[0-9a-f]{64}", pinned):
            raise IntegrityError("manifest pins no worker script digest")
        self.script = os.path.abspath(script_path)
        self.expected[self.script] = pinned
        self.keys = {}
        for path, sha in self.expected.items():
            self._verify_one(path, sha)

    def _verify_one(self, path, sha):
        if not os.path.isfile(path) or os.path.islink(path):
            raise IntegrityError("not a regular file: " + os.path.basename(path))
        before = _stat_key(path)
        if _sha256(path) != sha:
            raise IntegrityError("digest mismatch for " + os.path.basename(path))
        if _stat_key(path) != before:
            raise IntegrityError("file changed while it was verified: " + os.path.basename(path))
        self.keys[path] = before

    def check(self):
        """True while every pinned file is unchanged or re-hashes to its pinned digest; sticky once refused."""
        with self.lock:
            if self.refused:
                return False
            try:
                for path, sha in self.expected.items():
                    if not os.path.isfile(path) or os.path.islink(path):
                        raise IntegrityError("file missing: " + os.path.basename(path))
                    if _stat_key(path) != self.keys[path]:
                        self._verify_one(path, sha)
            except (IntegrityError, OSError) as failure:
                self.refused = str(failure)[:160]
                return False
            return True


# ---------------------------------------------------------------- engine -------------------------------------

class DeadlineExceeded(Exception):
    pass


class KokoroEngine:
    """The loaded model. One instance, used under the worker's single synthesis lock."""

    def __init__(self, model_dir, device_preference):
        import torch
        from kokoro import KModel
        self.model_dir = model_dir
        self.torch_version = torch.__version__
        self.cuda_available = bool(torch.cuda.is_available())
        self.cuda_name = torch.cuda.get_device_name(0) if self.cuda_available else ""
        wanted = "cuda:0" if (device_preference == "auto" and self.cuda_available) or device_preference == "cuda" \
            else "cpu"
        model = KModel(config=os.path.join(model_dir, "config.json"),
                       model=os.path.join(model_dir, "kokoro-v1_0.pth"), repo_id="hexgrad/Kokoro-82M").eval()
        self.device_note = ""
        if wanted.startswith("cuda"):
            try:
                model = model.to(wanted)
            except RuntimeError as failure:  # e.g. the shared GPU is out of memory: fall back, say so
                self.device_note = "cuda unusable (%s); fell back to cpu" % type(failure).__name__
                wanted = "cpu"
                model = model.to("cpu")
        self.model = model
        self.device = wanted
        self.pipelines = {}

    def _pipeline(self, lang):
        pipeline = self.pipelines.get(lang)
        if pipeline is None:
            from kokoro import KPipeline
            pipeline = KPipeline(lang_code=lang, model=self.model, repo_id="hexgrad/Kokoro-82M")
            self.pipelines[lang] = pipeline
        return pipeline

    def synthesize(self, text, voice_path, speed, lang, deadline):
        import numpy as np
        chunks = []
        for _, _, audio in self._pipeline(lang)(text, voice=voice_path, speed=speed):
            if time.monotonic() > deadline:
                raise DeadlineExceeded()
            if audio is not None:
                chunks.append(np.asarray(audio.cpu() if hasattr(audio, "cpu") else audio, dtype=np.float32))
        if not chunks:
            raise ValueError("synthesis produced no audio")
        return np.concatenate(chunks)


def pcm16_wav(samples):
    """Mono 24 kHz signed 16-bit PCM WAV bytes from a float32 sample array."""
    import numpy as np
    pcm = np.rint(np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
    header = b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVEfmt " + struct.pack(
        "<IHHIIHH", 16, 1, 1, SAMPLE_RATE, SAMPLE_RATE * 2, 2, 16) + b"data" + struct.pack("<I", len(pcm))
    return header + pcm


# ---------------------------------------------------------------- http ---------------------------------------

class Worker:
    def __init__(self, engine, verifier, model_dir, token):
        self.engine = engine
        self.verifier = verifier
        self.model_dir = os.path.realpath(model_dir)
        self.token = token
        self.lock = threading.Lock()  # one synthesis at a time
        self.admission = threading.BoundedSemaphore(1 + MAX_WAITING)  # running + bounded waiting

    def health(self):
        ok = self.verifier.check()
        body = {"status": "UP" if ok else "REFUSED", "verified": ok, "device": self.engine.device,
                "cudaAvailable": self.engine.cuda_available, "cudaDevice": self.engine.cuda_name,
                "torch": self.engine.torch_version, "voices": sorted(self.verifier.voices)}
        if self.engine.device_note:
            body["deviceNote"] = self.engine.device_note
        if not ok:
            body["reason"] = "FILES_CHANGED"
        return (200 if ok else 503), body


def make_handler(worker):
    class Handler(BaseHTTPRequestHandler):
        server_version = "ghatana-kokoro-worker/1"
        timeout = 30

        def log_message(self, fmt, *args):  # never log request content
            return

        def _json(self, status, body):
            data = json.dumps(body, separators=(",", ":")).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def _authorized(self):
            return hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + worker.token)

        def do_GET(self):
            if not self._authorized():
                return self._json(401, {"error": "UNAUTHORIZED"})
            if self.path == "/v1/health":
                status, body = worker.health()
                return self._json(status, body)
            return self._json(404, {"error": "NOT_FOUND"})

        def do_POST(self):
            if not self._authorized():
                return self._json(401, {"error": "UNAUTHORIZED"})
            if self.path != "/v1/synthesize":
                return self._json(404, {"error": "NOT_FOUND"})
            received = time.monotonic()
            try:
                length = int(self.headers.get("Content-Length", "-1"))
            except ValueError:
                length = -1
            if length <= 0 or length > MAX_BODY_BYTES:
                return self._json(413, {"error": "BODY_SIZE_INVALID"})
            try:
                request = json.loads(self.rfile.read(length))
                if not isinstance(request, dict):
                    raise ValueError("request must be an object")
                text = request.get("text")
                voice = request.get("voice")
                lang = request.get("lang", "a")
                speed = request.get("speed", 1.0)
                deadline_ms = request.get("deadlineMillis", 60_000)
                if not isinstance(text, str) or not text.strip() or len(text.strip()) > MAX_CHARS \
                        or CONTROL.search(text):
                    raise ValueError("text must be 1-%d characters without control characters" % MAX_CHARS)
                if not isinstance(voice, str) or not VOICE_PATTERN.match(voice) or voice not in worker.verifier.voices:
                    raise ValueError("voice is not part of the verified model installation")
                if lang not in LANG_CODES:
                    raise ValueError("unsupported language code")
                if isinstance(speed, bool) or not isinstance(speed, (int, float)) or not 0.5 <= speed <= 2.0:
                    raise ValueError("speed outside [0.5, 2.0]")
                if isinstance(deadline_ms, bool) or not isinstance(deadline_ms, int) \
                        or not 1 <= deadline_ms <= MAX_DEADLINE_MILLIS:
                    raise ValueError("deadlineMillis outside the allowed range")
            except (ValueError, UnicodeDecodeError) as invalid:
                return self._json(400, {"error": "INVALID_REQUEST", "message": str(invalid)[:200]})
            deadline = received + deadline_ms / 1000.0
            if not worker.verifier.check():
                return self._json(503, {"error": "FILES_CHANGED"})
            if not worker.admission.acquire(blocking=False):
                return self._json(429, {"error": "BUSY"})
            try:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not worker.lock.acquire(timeout=remaining):
                    return self._json(504, {"error": "DEADLINE_EXCEEDED"})
                try:
                    if not worker.verifier.check():
                        return self._json(503, {"error": "FILES_CHANGED"})
                    started = time.monotonic()
                    voice_path = os.path.realpath(os.path.join(worker.model_dir, "voices", voice + ".pt"))
                    samples = worker.engine.synthesize(text.strip(), voice_path, float(speed), lang, deadline)
                    wav = pcm16_wav(samples)
                    if len(wav) > MAX_WAV_BYTES:
                        return self._json(422, {"error": "OUTPUT_TOO_LARGE"})
                    if not worker.verifier.check():  # files changed while synthesizing: discard the audio
                        return self._json(503, {"error": "FILES_CHANGED"})
                finally:
                    worker.lock.release()
                self.send_response(200)
                self.send_header("Content-Type", "audio/wav")
                self.send_header("Content-Length", str(len(wav)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Kokoro-Device", worker.engine.device)
                self.send_header("X-Kokoro-Samples", str(len(samples)))
                self.send_header("X-Kokoro-Elapsed-Millis", str(int((time.monotonic() - started) * 1000)))
                self.end_headers()
                self.wfile.write(wav)
            except DeadlineExceeded:
                self._json(504, {"error": "DEADLINE_EXCEEDED"})
            except ValueError as invalid:
                self._json(422, {"error": "SYNTHESIS_REJECTED", "message": str(invalid)[:200]})
            except Exception as failure:  # model/runtime failure: typed, no content echoed
                sys.stderr.write("synthesis failure: %s\n" % type(failure).__name__)
                self._json(500, {"error": "SYNTHESIS_FAILED", "type": type(failure).__name__})
            finally:
                worker.admission.release()
    return Handler


def build_server(host, port, worker):
    if host not in ("127.0.0.1", "::1", "localhost"):
        raise SystemExit("refusing a non-loopback bind address")
    server = ThreadingHTTPServer((host, port), make_handler(worker))
    server.daemon_threads = True
    return server


def load_manifest(path):
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def _watch_parent(parent_pid):
    while True:
        time.sleep(2)
        if os.getppid() != parent_pid:
            os._exit(0)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--token-env", default="GHATANA_KOKORO_WORKER_TOKEN")
    parser.add_argument("--device", choices=["auto", "cpu", "cuda"], default="auto")
    parser.add_argument("--parent-pid", type=int, default=0,
                        help="exit when this process disappears (the supervising JVM)")
    args = parser.parse_args()
    if args.host not in ("127.0.0.1", "::1", "localhost"):
        sys.exit("refusing a non-loopback bind address")
    token = os.environ.get(args.token_env, "")
    if len(token) < 24:
        sys.exit("a bearer token of at least 24 characters is required in $" + args.token_env)
    if args.parent_pid > 0:
        threading.Thread(target=_watch_parent, args=(args.parent_pid,), daemon=True).start()
    model_dir = os.path.realpath(args.model_dir)
    try:
        verifier = Verifier(model_dir, load_manifest(args.manifest), __file__)
    except (IntegrityError, OSError, ValueError) as failure:
        sys.exit("refusing to serve: " + str(failure)[:160])
    engine = KokoroEngine(model_dir, args.device)
    if not verifier.check():  # a file changed between verification and the end of the model load
        sys.exit("refusing to serve: " + verifier.refused)
    worker = Worker(engine, verifier, model_dir, token)
    warm_voice = sorted(verifier.voices)[0]
    engine.synthesize("Warm up.", os.path.join(model_dir, "voices", warm_voice + ".pt"), 1.0, "a",
                      time.monotonic() + 120)  # compiles kernels so the first real request is already warm
    server = build_server(args.host, args.port, worker)
    sys.stderr.write("kokoro worker ready on %s:%d device=%s\n" % (args.host, args.port, engine.device))
    sys.stderr.flush()
    server.serve_forever()


if __name__ == "__main__":
    main()

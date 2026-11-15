#!/usr/bin/env python3
"""Unit tests for kokoro_worker.py with a stub engine (no torch, no model): integrity refusal, bearer token,
request bounds, deadline and bounded queue. Run with the Kokoro venv interpreter (needs numpy):

  ~/.local/share/ghatana-media/runtimes/kokoro-venv/bin/python tools/model-runtimes/test_kokoro_worker.py
"""
import hashlib
import http.client
import importlib.util
import json
import os
import shutil
import tempfile
import threading
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("kokoro_worker", os.path.join(HERE, "kokoro_worker.py"))
kw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(kw)
TOKEN = "t" * 32


def sha(data):
    return hashlib.sha256(data).hexdigest()


class StubEngine:
    device = "cpu"
    cuda_available = False
    cuda_name = ""
    torch_version = "stub"
    device_note = ""

    def __init__(self, delay=0.0):
        self.delay = delay
        self.calls = 0

    def synthesize(self, text, voice_path, speed, lang, deadline):
        import numpy as np
        self.calls += 1
        end = time.monotonic() + self.delay
        while time.monotonic() < end:
            if time.monotonic() > deadline:
                raise kw.DeadlineExceeded()
            time.sleep(0.01)
        return np.zeros(2400, dtype=np.float32)


class WorkerTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="kw-test-")
        self.addCleanup(shutil.rmtree, self.dir, True)
        os.makedirs(os.path.join(self.dir, "voices"))
        files = {"kokoro-v1_0.pth": b"weights", "config.json": b"{}", "voices/af_heart.pt": b"voice",
                 "voices/ef_dora.pt": b"voice-es"}
        for rel, data in files.items():
            with open(os.path.join(self.dir, rel), "wb") as handle:
                handle.write(data)
        with open(os.path.join(HERE, "kokoro_worker.py"), "rb") as handle:
            self.script_sha = sha(handle.read())
        self.manifest = {"files": [
            {"role": "WEIGHTS", "path": "kokoro-v1_0.pth", "sha256": sha(b"weights")},
            {"role": "CONFIG", "path": "config.json", "sha256": sha(b"{}")},
            {"role": "VOICE", "path": "voices/af_heart.pt", "sha256": sha(b"voice")},
            {"role": "VOICE", "path": "voices/ef_dora.pt", "sha256": sha(b"voice-es")}],
            "runtime": {"name": "kokoro", "workerSha256": self.script_sha}}

    def serve(self, engine=None, manifest=None):
        verifier = kw.Verifier(self.dir, manifest or self.manifest, os.path.join(HERE, "kokoro_worker.py"))
        worker = kw.Worker(engine or StubEngine(), verifier, self.dir, TOKEN)
        server = kw.build_server("127.0.0.1", 0, worker)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.shutdown)
        self.addCleanup(server.server_close)
        return server.server_address[1], worker

    def call(self, port, method, path, body=None, token=TOKEN):
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        headers = {"Authorization": "Bearer " + token} if token is not None else {}
        data = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode()
        connection.request(method, path, body=data, headers=headers)
        response = connection.getresponse()
        payload = response.read()
        connection.close()
        return response.status, payload, response

    def request(self, **overrides):
        body = {"text": "Hello there.", "voice": "af_heart", "deadlineMillis": 5000}
        body.update(overrides)
        return body

    # ---- integrity ----
    def test_digest_mismatch_refuses_to_serve(self):
        self.manifest["files"][0]["sha256"] = sha(b"tampered")
        with self.assertRaises(kw.IntegrityError):
            self.serve()

    def test_manifest_without_worker_digest_refuses_to_serve(self):
        del self.manifest["runtime"]["workerSha256"]
        with self.assertRaises(kw.IntegrityError):
            self.serve()

    def test_wrong_worker_script_digest_refuses_to_serve(self):
        self.manifest["runtime"]["workerSha256"] = sha(b"some other script")
        with self.assertRaises(kw.IntegrityError):
            self.serve()

    def test_additional_worker_digest_is_accepted_when_the_pinned_one_is_an_older_revision(self):
        self.manifest["runtime"]["additionalWorkerSha256"] = [self.script_sha]
        self.manifest["runtime"]["workerSha256"] = sha(b"an older worker revision")
        self.serve()  # the script on disk matches one accepted digest
        self.manifest["runtime"]["additionalWorkerSha256"] = [sha(b"another")]
        with self.assertRaises(kw.IntegrityError):
            self.serve()

    def test_manifest_path_escape_refused(self):
        self.manifest["files"][0]["path"] = "../outside"
        with self.assertRaises(kw.IntegrityError):
            self.serve()

    def test_file_changed_after_start_refuses_and_stays_refused(self):
        port, _ = self.serve()
        self.assertEqual(self.call(port, "POST", "/v1/synthesize", self.request())[0], 200)
        with open(os.path.join(self.dir, "voices/af_heart.pt"), "wb") as handle:
            handle.write(b"swapped voice pack")
        status, body, _ = self.call(port, "POST", "/v1/synthesize", self.request())
        self.assertEqual((status, json.loads(body)["error"]), (503, "FILES_CHANGED"))
        with open(os.path.join(self.dir, "voices/af_heart.pt"), "wb") as handle:
            handle.write(b"voice")  # restoring the bytes does not resurrect a refused worker
        self.assertEqual(self.call(port, "POST", "/v1/synthesize", self.request())[0], 503)
        status, body, _ = self.call(port, "GET", "/v1/health")
        self.assertEqual((status, json.loads(body)["status"]), (503, "REFUSED"))

    def test_touched_but_identical_file_is_rehashed_and_still_served(self):
        port, _ = self.serve()
        os.utime(os.path.join(self.dir, "config.json"), ns=(1, 1))
        self.assertEqual(self.call(port, "POST", "/v1/synthesize", self.request())[0], 200)

    # ---- authentication ----
    def test_bad_or_missing_token_is_refused_without_synthesizing(self):
        engine = StubEngine()
        port, _ = self.serve(engine)
        self.assertEqual(self.call(port, "POST", "/v1/synthesize", self.request(), token="wrong" * 8)[0], 401)
        self.assertEqual(self.call(port, "POST", "/v1/synthesize", self.request(), token=None)[0], 401)
        self.assertEqual(self.call(port, "GET", "/v1/health", token="nope")[0], 401)
        self.assertEqual(engine.calls, 0)

    def test_non_loopback_bind_refused(self):
        with self.assertRaises(SystemExit):
            kw.build_server("0.0.0.0", 0, None)

    # ---- bounds ----
    def test_oversize_body_and_text_are_refused(self):
        engine = StubEngine()
        port, _ = self.serve(engine)
        status, _, _ = self.call(port, "POST", "/v1/synthesize", b"x" * (kw.MAX_BODY_BYTES + 1))
        self.assertEqual(status, 413)
        status, _, _ = self.call(port, "POST", "/v1/synthesize", self.request(text="a" * (kw.MAX_CHARS + 1)))
        self.assertEqual(status, 400)
        self.assertEqual(self.call(port, "POST", "/v1/synthesize", self.request(text="a" * kw.MAX_CHARS))[0], 200)
        self.assertEqual(engine.calls, 1)

    def test_invalid_fields_are_refused(self):
        port, _ = self.serve()
        for bad in (self.request(voice="am_michael"), self.request(voice="../x"), self.request(speed=3.0),
                    self.request(speed=True), self.request(lang="z"), self.request(deadlineMillis=0),
                    self.request(deadlineMillis=10 ** 9), self.request(text="bad\x00control"),
                    self.request(text="   "), self.request(text=5)):
            self.assertEqual(self.call(port, "POST", "/v1/synthesize", bad)[0], 400, bad)
        self.assertEqual(self.call(port, "POST", "/v1/synthesize", b"not json")[0], 400)

    def test_spanish_requires_a_spanish_voice_pack_and_the_matching_language_code(self):
        engine = StubEngine()
        port, _ = self.serve(engine)
        self.assertEqual(self.call(port, "POST", "/v1/synthesize", self.request(voice="ef_dora", lang="e"))[0], 200)
        # A voice pack is only usable with its own language code, in both directions.
        self.assertEqual(self.call(port, "POST", "/v1/synthesize", self.request(voice="ef_dora", lang="a"))[0], 400)
        self.assertEqual(self.call(port, "POST", "/v1/synthesize", self.request(voice="af_heart", lang="e"))[0], 400)
        self.assertEqual(engine.calls, 1)

    def test_success_returns_pcm16_wav_and_device_header(self):
        port, _ = self.serve()
        status, body, response = self.call(port, "POST", "/v1/synthesize", self.request())
        self.assertEqual(status, 200)
        self.assertEqual(body[:4], b"RIFF")
        self.assertEqual(response.getheader("X-Kokoro-Device"), "cpu")
        self.assertEqual(len(body), 44 + 2400 * 2)

    # ---- deadline and queue ----
    def test_deadline_exceeded_during_synthesis_is_504(self):
        port, _ = self.serve(StubEngine(delay=2.0))
        status, body, _ = self.call(port, "POST", "/v1/synthesize", self.request(deadlineMillis=200))
        self.assertEqual((status, json.loads(body)["error"]), (504, "DEADLINE_EXCEEDED"))

    def test_deadline_while_queued_is_504_and_queue_is_bounded(self):
        port, _ = self.serve(StubEngine(delay=1.5))
        results = []

        def fire(deadline):
            results.append(self.call(port, "POST", "/v1/synthesize", self.request(deadlineMillis=deadline))[0])

        threads = [threading.Thread(target=fire, args=(10_000,))]
        threads[0].start()
        time.sleep(0.3)  # the first request holds the synthesis lock
        for _ in range(kw.MAX_WAITING):
            threads.append(threading.Thread(target=fire, args=(600,)))
            threads[-1].start()
        time.sleep(0.15)
        overflow = self.call(port, "POST", "/v1/synthesize", self.request(deadlineMillis=600))
        self.assertEqual(overflow[0], 429)  # running + MAX_WAITING already admitted
        for thread in threads:
            thread.join()
        self.assertEqual(sorted(results), [200] + [504] * kw.MAX_WAITING)

    def test_unknown_path_is_404(self):
        port, _ = self.serve()
        self.assertEqual(self.call(port, "POST", "/v1/other", self.request())[0], 404)


if __name__ == "__main__":
    unittest.main()

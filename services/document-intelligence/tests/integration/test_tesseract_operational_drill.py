"""Operational drill for the single DI writer on the REAL Tesseract path (MED-09 / F5-025).

Opt-in (same switch as the other real-provider tests) and stdlib/unittest only, so it runs without the FastAPI test extras:
  DOCUMENT_INTELLIGENCE_RUN_REAL_PROVIDERS=1 DOCUMENT_INTELLIGENCE_TESSERACT_RUNTIME=<root> python3 -I -m unittest <this module>
Proves: cancellation of in-flight OCR (no orphan process), deadline timeout, SIGKILL of the engine mid-job (typed failure,
never a fabricated result), crash/restart through the outcome store (no result, no re-execution => UNKNOWN to the caller),
idempotent replay, and that OCR text never reaches log events. Not qualification; the provider stays NOT_ADMITTED.
"""
from __future__ import annotations

import asyncio, io, logging, os, signal, sys, tempfile, threading, time, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))
from PIL import Image, ImageDraw, ImageFont  # noqa: E402

from document_intelligence.errors import WorkerError  # noqa: E402
from document_intelligence.observability import log_event, safe_event  # noqa: E402
from document_intelligence.operations import FileOutcomeStore, OperationRegistry  # noqa: E402
from document_intelligence.providers.tesseract_ocr_parser import TesseractOcrParser, _provisioned_runtime  # noqa: E402
from document_intelligence.runtime.cancellation import CancellationToken  # noqa: E402
from document_intelligence.runtime.deadline import Deadline  # noqa: E402
from document_intelligence.runtime.subprocess_runner import run_bounded_subprocess  # noqa: E402

SECRET_TEXT = "Confidential synthetic marker 7391"
RUN = os.getenv("DOCUMENT_INTELLIGENCE_RUN_REAL_PROVIDERS") == "1" and _provisioned_runtime() is not None


def _png(text: str, lines: int = 1, size=(900, 140)) -> bytes:
    font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 28)
    img = Image.new("L", (size[0], size[1] * lines), 255)
    draw = ImageDraw.Draw(img)
    for i in range(lines):
        draw.text((20, 40 + i * size[1]), text, font=font, fill=0)
    out = io.BytesIO(); img.save(out, "PNG"); return out.getvalue()


def _tesseract_pids(exe: str) -> set[int]:
    pids = set()
    for p in Path("/proc").iterdir():
        if p.name.isdigit():
            try:
                if (p / "exe").resolve() == Path(exe).resolve(): pids.add(int(p.name))
            except OSError: pass
    return pids


def _slow_png() -> bytes:  # big, dense page => the engine runs long enough to interrupt
    return _png("The quick brown fox jumps over the lazy dog 0123456789", lines=60, size=(2400, 80))


@unittest.skipUnless(RUN, "real Tesseract drill requires DOCUMENT_INTELLIGENCE_RUN_REAL_PROVIDERS=1 and a provisioned runtime")
class TesseractOperationalDrill(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.parser = TesseractOcrParser()
        self.exe = _provisioned_runtime()[0]
        self.before = _tesseract_pids(self.exe)

    def _parse(self, data, token=None, ms=60_000, runner=None):
        p = self.parser if runner is None else TesseractOcrParser(runner=runner, executable=self.exe, tessdata_dir=self.parser._tessdata_dir)
        if runner is not None: p._library_dir = self.parser._library_dir
        return p.parse(data, media_type="image/png", language="en", limits={}, deadline=Deadline(ms, margin_ms=0), token=token or CancellationToken())

    async def test_cancel_in_flight_terminates_engine_without_result_or_orphan(self):
        token = CancellationToken()
        task = asyncio.create_task(asyncio.to_thread(self._parse, _slow_png(), token))
        await asyncio.sleep(0.4)
        token.cancel()
        with self.assertRaises(WorkerError) as ctx: await asyncio.wait_for(task, 20)
        self.assertEqual(ctx.exception.code, "CANCELLED")
        await asyncio.sleep(0.3)
        self.assertEqual(_tesseract_pids(self.exe) - self.before, set(), "engine process survived cancellation")

    async def test_deadline_is_a_typed_retryable_timeout_never_a_result(self):
        with self.assertRaises(WorkerError) as ctx: await asyncio.to_thread(self._parse, _slow_png(), None, 300)
        self.assertEqual(ctx.exception.code, "TIMEOUT"); self.assertTrue(ctx.exception.retryable)
        self.assertEqual(_tesseract_pids(self.exe) - self.before, set())

    async def test_sigkill_of_engine_mid_job_is_provider_failure_not_fabricated_text(self):
        def killing_runner(argv, **kw):
            def kill():
                time.sleep(0.4)
                for pid in _tesseract_pids(self.exe) - self.before:
                    try: os.kill(pid, signal.SIGKILL)
                    except OSError: pass
            threading.Thread(target=kill, daemon=True).start()
            return run_bounded_subprocess(argv, **kw)
        with self.assertRaises(WorkerError) as ctx: await asyncio.to_thread(self._parse, _slow_png(), None, 60_000, killing_runner)
        self.assertEqual(ctx.exception.code, "PROVIDER_FAILED")

    async def test_crash_restart_leaves_no_result_and_blocks_blind_reexecution(self):
        with tempfile.TemporaryDirectory() as d:
            first = OperationRegistry(outcome_store=FileOutcomeStore(d), owner_id="worker-1")
            op = await first.begin("op-crash", "ghatana.tesseractocr", 60_000, "a" * 32)
            self.assertIsNotNone(op.claim_token)
            # worker "crashes": the registry is dropped with no outcome published. A restarted worker shares only the store.
            second = OperationRegistry(outcome_store=FileOutcomeStore(d), owner_id="worker-2")
            self.assertIsNone(await second.get_outcome("op-crash", "a" * 32))  # UNKNOWN: nothing fabricated
            with self.assertRaises(WorkerError) as ctx: await second.begin("op-crash", "ghatana.tesseractocr", 60_000, "a" * 32)
            self.assertEqual(ctx.exception.code, "DUPLICATE_OPERATION")  # no second blind execution of the same generation

    async def test_published_result_replays_identically_and_never_reruns(self):
        with tempfile.TemporaryDirectory() as d:
            reg = OperationRegistry(outcome_store=FileOutcomeStore(d), owner_id="w1")
            op = await reg.begin("op-ok", "ghatana.tesseractocr", 60_000, "b" * 32)
            result = await asyncio.to_thread(self._parse, _png(SECRET_TEXT))
            payload = {"operationId": "op-ok", "result": result}
            self.assertTrue(await reg.publish_success(op, payload))
            await reg.finish(op)
            restarted = OperationRegistry(outcome_store=FileOutcomeStore(d), owner_id="w2")
            replay = await restarted.get_outcome("op-ok", "b" * 32)
            self.assertEqual(replay.status, "SUCCEEDED"); self.assertEqual(replay.response, payload)
            with self.assertRaises(WorkerError) as ctx: await restarted.begin("op-ok", "ghatana.tesseractocr", 60_000, "b" * 32)
            self.assertEqual(ctx.exception.code, "DUPLICATE_OPERATION")

    async def test_cancel_before_publish_prevents_late_result_resurrection(self):
        with tempfile.TemporaryDirectory() as d:
            reg = OperationRegistry(outcome_store=FileOutcomeStore(d), owner_id="w1")
            op = await reg.begin("op-race", "ghatana.tesseractocr", 60_000, "c" * 32)
            self.assertTrue(await reg.cancel("op-race", "c" * 32))
            self.assertFalse(await reg.cancel("op-race", "d" * 32) and (await reg.get_outcome("op-race", "d" * 32)) is not None)
            self.assertFalse(await reg.publish_success(op, {"operationId": "op-race", "result": {"late": True}}))

    async def test_ocr_text_never_reaches_log_events(self):
        records: list[str] = []
        class Cap(logging.Handler):
            def emit(self, r): records.append(r.getMessage())
        logger = logging.getLogger("document_intelligence.drill"); logger.setLevel(logging.DEBUG)
        h = Cap(); logging.getLogger().addHandler(h); logging.getLogger().setLevel(logging.DEBUG); logger.addHandler(h)
        try:
            res = await asyncio.to_thread(self._parse, _png(SECRET_TEXT))
            text = " ".join(l["text"] for b in res["pages"][0]["blocks"] for l in b["lines"])
            self.assertIn("Confidential", text)  # the engine really read it
            log_event(logger, operationId="op-log", providerRef="ghatana.tesseractocr", text=text, content=text, inputByteCount=10, status="succeeded")
            self.assertNotIn("text", safe_event(text=text, status="ok"))
            self.assertTrue(records)
            self.assertFalse(any("Confidential" in r or "7391" in r for r in records))
        finally:
            logging.getLogger().removeHandler(h); logger.removeHandler(h)


if __name__ == "__main__":
    unittest.main()

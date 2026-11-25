"""Model-free checks for Vision sidecar cancellation and image orientation."""
import http.client
import base64
import io
import importlib.util
import json
import pathlib
import sys
import threading
import time
import types
import unittest
import uuid
from unittest.mock import patch


SIDECAR_PATH = pathlib.Path(__file__).with_name("vision_sidecar.py")
SPEC = importlib.util.spec_from_file_location("vision_sidecar_under_test", SIDECAR_PATH)
sidecar = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = sidecar
SPEC.loader.exec_module(sidecar)

TOKEN = "test-token-for-local-sidecar-cancellation"


def jpeg_with_orientation(orientation):
    from PIL import Image

    image = Image.new("RGB", (80, 60))
    colors = (
        ((0, 0, 40, 30), (255, 0, 0)),
        ((40, 0, 80, 30), (0, 255, 0)),
        ((0, 30, 40, 60), (0, 0, 255)),
        ((40, 30, 80, 60), (255, 255, 0)),
    )
    for (left, top, right, bottom), color in colors:
        for y in range(top, bottom):
            for x in range(left, right):
                image.putpixel((x, y), color)
    exif = Image.Exif()
    exif[274] = orientation
    encoded = io.BytesIO()
    image.save(encoded, format="JPEG", quality=100, subsampling=0, exif=exif)
    return encoded.getvalue()


def oriented_point(orientation, x, y, width, height):
    if orientation == 1:
        return x, y
    if orientation == 2:
        return width - 1 - x, y
    if orientation == 3:
        return width - 1 - x, height - 1 - y
    if orientation == 4:
        return x, height - 1 - y
    if orientation == 5:
        return y, x
    if orientation == 6:
        return height - 1 - y, x
    if orientation == 7:
        return height - 1 - y, width - 1 - x
    if orientation == 8:
        return y, width - 1 - x
    raise AssertionError("test orientation must be in the EXIF range")


class VisionSidecarImageOrientationTest(unittest.TestCase):
    def test_exif_orientations_one_through_eight_match_oriented_raster_contract(self):
        from PIL import Image

        sample_points = ((20, 15), (60, 15), (20, 45), (60, 45))
        width, height = 80, 60
        for orientation in range(1, 9):
            with self.subTest(orientation=orientation):
                encoded = jpeg_with_orientation(orientation)
                base = Image.open(io.BytesIO(encoded)).convert("RGB")
                actual = sidecar.decode_image(base64.b64encode(encoded).decode("ascii"))
                expected_size = (height, width) if orientation >= 5 else (width, height)
                self.assertEqual(actual.size, expected_size)
                for x, y in sample_points:
                    self.assertEqual(
                        actual.getpixel(oriented_point(orientation, x, y, width, height)),
                        base.getpixel((x, y)),
                        f"encoded pixel {(x, y)} must map through EXIF orientation {orientation}",
                    )

    def test_exif_orientation_outside_one_through_eight_fails_closed(self):
        for orientation in (0, 9):
            with self.subTest(orientation=orientation):
                encoded = jpeg_with_orientation(orientation)
                with self.assertRaisesRegex(ValueError, "invalid EXIF orientation"):
                    sidecar.decode_image(base64.b64encode(encoded).decode("ascii"))


class FakeImage:
    width = 2
    height = 2
    size = (2, 2)


class FakeEngines:
    def __init__(self):
        self.lock = threading.Lock()
        self.device = "cpu"
        self._florence = None
        self._qwen = None
        self.entered = threading.Event()
        self.allow_return = threading.Event()
        self.hold = False
        self.calls = 0

    def device_info(self):
        return {"kind": "CPU", "name": "test", "torch": "fake"}

    @staticmethod
    def _check_cancelled(cancel_event):
        if cancel_event is not None and cancel_event.is_set():
            raise sidecar.OperationCancelled()

    def _run(self):
        self.calls += 1
        self.entered.set()
        if self.hold:
            self.allow_return.wait(2)

    def analyze(self, image, tasks, max_new_tokens, cancel_event=None):
        self._run()
        return {"caption": "synthetic result"}

    def ask(self, image, question, max_new_tokens, cancel_event=None):
        self._run()
        return "synthetic answer"

    def translate(self, text, source, target, max_new_tokens, cancel_event=None):
        self._run()
        return "synthetic translation"


class FakeResponse:
    def __init__(self, status, body):
        self.status = status
        self.body = body


class VisionSidecarCancellationTest(unittest.TestCase):
    def setUp(self):
        self.engines = FakeEngines()
        self.server = sidecar.ThreadingHTTPServer(
            ("127.0.0.1", 0), sidecar.make_handler(self.engines, TOKEN))
        self.server.daemon_threads = True
        self.server_thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.server_thread.start()
        self.address = self.server.server_address
        self.image_patch = patch.object(sidecar, "decode_image", return_value=FakeImage())
        self.image_patch.start()

    def tearDown(self):
        self.engines.allow_return.set()
        self.image_patch.stop()
        self.server.shutdown()
        self.server.server_close()
        self.server_thread.join(timeout=2)

    def request(self, method, path, body=None, token=TOKEN, operation_id=None):
        connection = http.client.HTTPConnection(*self.address, timeout=3)
        headers = {"Authorization": "Bearer " + token, "Content-Type": "application/json"}
        if operation_id is not None:
            headers[sidecar.OPERATION_ID_HEADER] = operation_id
        data = None if body is None else json.dumps(body).encode("utf-8")
        connection.request(method, path, body=data, headers=headers)
        response = connection.getresponse()
        result = FakeResponse(response.status, response.read())
        connection.close()
        return result

    @staticmethod
    def analyze_body():
        return {"imageBase64": "test-image", "tasks": ["caption"], "maxNewTokens": 1}

    def start_post(self, operation_id=None):
        result = {}
        done = threading.Event()

        def run():
            try:
                result["response"] = self.request(
                    "POST", "/v1/analyze", self.analyze_body(), operation_id=operation_id)
            except BaseException as failure:
                result["failure"] = failure
            finally:
                done.set()

        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        return thread, done, result

    def test_cancel_requires_auth_and_never_creates_unknown_state(self):
        operation_id = str(uuid.uuid4())
        denied = self.request("DELETE", "/v1/operations/" + operation_id, token="wrong-token")
        unknown = self.request("DELETE", "/v1/operations/" + operation_id)

        self.assertEqual(denied.status, 401)
        self.assertEqual(unknown.status, 404)
        self.assertEqual(json.loads(unknown.body), {"error": "OPERATION_NOT_FOUND"})
        self.assertEqual(self.engines.calls, 0)

    def test_cancelled_active_inference_returns_no_partial_result(self):
        self.engines.hold = True
        operation_id = str(uuid.uuid4())
        _, done, result = self.start_post(operation_id)
        self.assertTrue(self.engines.entered.wait(1), "synthetic operation did not enter the engine")

        cancelled = self.request("DELETE", "/v1/operations/" + operation_id)
        self.engines.allow_return.set()

        self.assertTrue(done.wait(2), "cancelled POST did not finish")
        self.assertEqual(cancelled.status, 202)
        self.assertEqual(json.loads(cancelled.body), {"state": "CANCEL_REQUESTED"})
        response = result["response"]
        self.assertEqual(response.status, 409)
        self.assertEqual(json.loads(response.body), {"error": "OPERATION_CANCELLED"})
        self.assertNotIn("results", json.loads(response.body))

    def test_cancel_while_waiting_for_serial_engine_lock_skips_dispatch(self):
        self.engines.lock.acquire()
        operation_id = str(uuid.uuid4())
        _, done, result = self.start_post(operation_id)
        try:
            deadline = time.monotonic() + 2
            while True:
                cancellation = self.request("DELETE", "/v1/operations/" + operation_id)
                if cancellation.status == 202:
                    break
                self.assertEqual(cancellation.status, 404)
                self.assertLess(time.monotonic(), deadline, "operation was not registered before timeout")
                time.sleep(0.01)
        finally:
            self.engines.lock.release()

        self.assertTrue(done.wait(2), "cancelled lock waiter did not finish")
        response = result["response"]
        self.assertEqual(response.status, 409)
        self.assertEqual(json.loads(response.body), {"error": "OPERATION_CANCELLED"})
        self.assertEqual(self.engines.calls, 0)

    def test_duplicate_active_operation_id_is_refused_and_headerless_caller_still_works(self):
        self.engines.hold = True
        operation_id = str(uuid.uuid4())
        _, done, first = self.start_post(operation_id)
        self.assertTrue(self.engines.entered.wait(1), "first synthetic operation did not enter the engine")

        duplicate = self.request("POST", "/v1/analyze", self.analyze_body(), operation_id=operation_id)
        self.assertEqual(duplicate.status, 409)
        self.assertEqual(json.loads(duplicate.body), {"error": "OPERATION_ALREADY_ACTIVE"})
        self.request("DELETE", "/v1/operations/" + operation_id)
        self.engines.allow_return.set()
        self.assertTrue(done.wait(2))
        self.assertEqual(first["response"].status, 409)

        self.engines.hold = False
        self.engines.entered.clear()
        compatible = self.request("POST", "/v1/analyze", self.analyze_body())
        self.assertEqual(compatible.status, 200)
        self.assertEqual(json.loads(compatible.body)["results"], {"caption": "synthetic result"})

    def test_operation_id_must_be_canonical_uuid(self):
        invalid = self.request("POST", "/v1/analyze", self.analyze_body(), operation_id="NOT-A-UUID")
        self.assertEqual(invalid.status, 400)
        self.assertEqual(json.loads(invalid.body), {"error": "INVALID_OPERATION_ID"})
        self.assertEqual(self.engines.calls, 0)

    def test_transformers_criterion_observes_cancellation_between_decode_steps(self):
        class FakeInputIds:
            shape = (2, 1)
            device = "cpu"

        class FakeTorch:
            bool = object()

            @staticmethod
            def full(shape, value, dtype, device):
                return [value for _ in range(shape[0])]

        class FakeStoppingCriteria:
            pass

        class FakeStoppingCriteriaList(list):
            pass

        fake_transformers = types.SimpleNamespace(
            StoppingCriteria=FakeStoppingCriteria,
            StoppingCriteriaList=FakeStoppingCriteriaList)
        cancel_event = threading.Event()
        with patch.dict(sys.modules, {"torch": FakeTorch, "transformers": fake_transformers}):
            criteria = sidecar.Engines._stopping_criteria(cancel_event)
            self.assertEqual(criteria[0](FakeInputIds(), None), [False, False])
            cancel_event.set()
            self.assertEqual(criteria[0](FakeInputIds(), None), [True, True])

    def test_cancelled_analyze_does_not_import_torch_or_load_model(self):
        engines = sidecar.Engines("unused-florence", "unused-qwen", "cpu", 1024)
        cancel_event = threading.Event()
        cancel_event.set()
        with patch.dict(sys.modules, {"torch": None}), patch.object(engines, "load_florence") as load_model:
            with self.assertRaises(sidecar.OperationCancelled):
                engines.analyze(FakeImage(), ["caption"], 1, cancel_event)
        load_model.assert_not_called()


if __name__ == "__main__":
    unittest.main()

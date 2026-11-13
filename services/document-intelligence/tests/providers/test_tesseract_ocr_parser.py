import io

import pytest
from PIL import Image

from document_intelligence.errors import WorkerError
from document_intelligence.providers.tesseract_ocr_parser import TesseractOcrParser
from document_intelligence.runtime.cancellation import CancellationToken
from document_intelligence.runtime.deadline import Deadline
from document_intelligence.runtime.subprocess_runner import CompletedSubprocess


def image_bytes() -> bytes:
    image = Image.new("RGB", (40, 20), "white")
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def tsv() -> bytes:
    return b"level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t2\t3\t20\t8\t96.0\t123\n"


def test_tesseract_maps_language_and_preserves_bounded_runner_contract():
    calls = []

    def runner(argv, **kwargs):
        calls.append((argv, kwargs))
        return CompletedSubprocess(tsv(), b"", 0)

    parser = TesseractOcrParser(runner=runner, executable="tesseract")
    result = parser.parse(image_bytes(), media_type="image/png", language="mr", limits={"maxTextCharacters": 10}, deadline=Deadline(1000), token=CancellationToken())
    assert result["languageTag"] == "mr"
    assert result["pages"][0]["blocks"][0]["languageTag"] == "mr"
    assert calls[0][0] == ["tesseract", "stdin", "stdout", "-l", "mar", "tsv"]
    assert calls[0][1]["max_output_bytes"] == 40


def test_tesseract_rejects_cancellation_before_image_work():
    def runner(*args, **kwargs):
        raise AssertionError("native OCR must not start after cancellation")

    token = CancellationToken()
    token.cancel()
    with pytest.raises(WorkerError) as error:
        TesseractOcrParser(runner=runner).parse(image_bytes(), media_type="image/png", language="en", limits={}, deadline=Deadline(1000), token=token)
    assert error.value.code == "CANCELLED"


def test_tesseract_warm_requires_all_real_traineddata_for_the_default_runner(monkeypatch, tmp_path):
    monkeypatch.setattr("document_intelligence.providers.tesseract_ocr_parser.shutil.which", lambda _: None)
    monkeypatch.setenv("DOCUMENT_INTELLIGENCE_TESSERACT_RUNTIME", str(tmp_path / "absent"))
    with pytest.raises(RuntimeError, match="traineddata"):
        TesseractOcrParser().warm()

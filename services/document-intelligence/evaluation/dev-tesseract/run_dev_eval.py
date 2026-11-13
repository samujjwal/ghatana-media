#!/usr/bin/env python3
"""Development-only Tesseract evaluation through the DI worker's own TesseractOcrParser (MED-09 / F5-025).

Synthetic, non-PHI, generated corpus (no third-party data, no rights clearance needed). Records CER/WER per language
and condition plus runtime/model digests. This is NOT qualification: no independent reference set, no agreed thresholds,
no independent verifier; the evidence record it emits is unverified and the provider remains NOT_ADMITTED.

  DOCUMENT_INTELLIGENCE_TESSERACT_RUNTIME=<provisioned runtime root> python3 -I run_dev_eval.py --out <results.json>
"""
from __future__ import annotations

import argparse, hashlib, io, json, os, platform, random, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "src"))
from PIL import Image, ImageDraw, ImageFilter, ImageFont  # noqa: E402
from document_intelligence.providers.tesseract_ocr_parser import TesseractOcrParser, _provisioned_runtime  # noqa: E402
from document_intelligence.runtime.cancellation import CancellationToken  # noqa: E402
from document_intelligence.runtime.deadline import Deadline  # noqa: E402

CORPUS = {
    "en": ["The quick brown fox jumps over the lazy dog.", "Please keep this document in a safe place.",
           "Synthetic test sentence number three for recognition.", "Water is important for good health every day.",
           "The meeting starts at nine in the morning.", "Invoice total is one hundred and twenty dollars."],
    "ne": ["यो एउटा परीक्षण वाक्य हो।", "नेपालको राजधानी काठमाडौँ हो।", "आज मौसम राम्रो छ।",
           "कृपया कागजात सुरक्षित राख्नुहोस्।", "हामी पुस्तक पढ्छौँ।", "पानी पिउनु स्वास्थ्यका लागि राम्रो हुन्छ।"],
}
FONTS = {"en": "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "ne": "/usr/share/fonts/truetype/noto/NotoSansDevanagari-Regular.ttf"}


def render(text: str, lang: str, condition: str, seed: int) -> bytes:
    rng = random.Random(seed)
    font = ImageFont.truetype(FONTS[lang], 44)
    probe = ImageDraw.Draw(Image.new("L", (10, 10)))
    box = probe.textbbox((0, 0), text, font=font)
    img = Image.new("L", (box[2] + 80, box[3] + 80), 255)
    ImageDraw.Draw(img).text((40, 30), text, font=font, fill=0)
    if condition == "noisy":
        img = img.rotate(rng.uniform(-1.5, 1.5), fillcolor=255, expand=True).filter(ImageFilter.GaussianBlur(0.8))
        px = img.load()
        for _ in range(img.size[0] * img.size[1] // 40):
            x, y = rng.randrange(img.size[0]), rng.randrange(img.size[1])
            px[x, y] = max(0, min(255, px[x, y] + rng.randint(-60, 60)))
    out = io.BytesIO(); img.save(out, "PNG"); return out.getvalue()


def lev(a, b) -> int:
    prev = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        cur = [i]
        for j, y in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x != y)))
        prev = cur
    return prev[-1]


def norm(s: str) -> str: return " ".join(s.split())


def main() -> int:
    ap = argparse.ArgumentParser(); ap.add_argument("--out", required=True); args = ap.parse_args()
    runtime = _provisioned_runtime()
    if runtime is None: print("Tesseract runtime not provisioned; nothing evaluated", file=sys.stderr); return 3
    exe, _lib, tessdata = runtime
    parser = TesseractOcrParser().warm()
    sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
    rows, agg = [], {}
    for lang, sentences in CORPUS.items():
        for condition in ("clean", "noisy"):
            ce = cr = we = wr = 0
            for i, ref in enumerate(sentences):
                png = render(ref, lang, condition, seed=i * 7 + len(lang))
                t0 = time.perf_counter()
                res = parser.parse(png, media_type="image/png", language=lang, limits={}, deadline=Deadline(30_000, margin_ms=0), token=CancellationToken())
                ms = (time.perf_counter() - t0) * 1000
                hyp = norm(" ".join(l["text"] for b in res["pages"][0]["blocks"] for l in b["lines"]))
                r = norm(ref)
                ce += lev(r, hyp); cr += len(r); we += lev(r.split(), hyp.split()); wr += len(r.split())
                rows.append({"language": lang, "condition": condition, "referenceSha256": hashlib.sha256(r.encode()).hexdigest(), "hypothesis": hyp, "ms": round(ms, 1)})
            agg[f"{lang}/{condition}"] = {"samples": len(sentences), "cer": round(ce / cr, 4), "wer": round(we / wr, 4)}
    report = {
        "schemaVersion": "ghatana.media.di-dev-ocr-eval.v1", "classification": "DEV_ONLY_SYNTHETIC_NOT_QUALIFICATION",
        "admission": "NOT_ADMITTED", "verification": "ABSENT",
        "corpus": {"kind": "generated-synthetic-non-PHI", "fonts": FONTS, "sentences": {k: len(v) for k, v in CORPUS.items()}},
        "engine": {"providerRef": parser.identity()["providerRef"], "tesseract": os.popen(f"LD_LIBRARY_PATH={_lib} {exe} --version 2>&1 | head -1").read().strip(),
                   "binarySha256": sha(exe), "engTraineddataSha256": sha(tessdata / "eng.traineddata"), "nepTraineddataSha256": sha(tessdata / "nep.traineddata"),
                   "license": "Apache-2.0 (tesseract, tessdata)"},
        "host": {"platform": platform.platform(), "python": platform.python_version(), "cpus": os.cpu_count(), "loadavg": os.getloadavg()},
        "aggregate": agg, "rows": rows,
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(agg, ensure_ascii=False, indent=1)); return 0


if __name__ == "__main__": raise SystemExit(main())

#!/usr/bin/env python3
"""Measured Spanish round trip for the DEV_ONLY speech lanes: Kokoro-82M `es` -> Whisper large-v3-turbo `es`.

Admission of Spanish (owner decision of the Media owner delegate, 2026-11-15) is gated on this measurement. It
starts the REAL persistent Kokoro worker (kokoro_worker.py, the same script the launcher supervises) against a
scratch manifest, synthesizes N fixed Spanish sentences with every Spanish stock voice, resamples each result to
16 kHz mono, transcribes it with the REAL whisper-cli (explicit `-l es`, the flags the Java runner uses) and computes
the word and character error rates against the fixed sentences. It writes one evidence file that records the
sentences, every hypothesis, the rates, the thresholds that were declared BEFORE the run, and the SHA-256 of every
model/runtime artifact that took part. The evidence digest is then recorded in the installed manifests.

This is a smoke gate for "intelligible and recognizable by the pinned recognizer", NOT a quality qualification: the
same family of models on both sides can share systematic errors, and nine sentences are a small sample.

  kokoro-venv/bin/python es_roundtrip_evidence.py --model-root ~/.local/share/ghatana-media \
      --scratch-manifest /tmp/kokoro-scratch-manifest.json --ffmpeg /abs/ffmpeg --out evidence.json
"""
import argparse
import datetime
import hashlib
import http.client
import json
import os
import re
import secrets
import subprocess
import sys
import tempfile
import time
import unicodedata

# Declared before the first measurement; an admission needs every one of them to hold.
THRESHOLDS = {"overallWordErrorRateMax": 0.25, "overallCharacterErrorRateMax": 0.12,
              "perVoiceWordErrorRateMax": 0.30, "sentencesWithNoTextMax": 0}

SENTENCES = [
    ("es-01", "Hola, bienvenidos a este breve video de demostración."),
    ("es-02", "Hoy vamos a explicar cómo funciona nuestro nuevo sistema de edición."),
    ("es-03", "El equipo trabajó durante tres meses para terminar el proyecto."),
    ("es-04", "Por favor, revise el documento antes de enviarlo a la oficina."),
    ("es-05", "La reunión empieza a las diez de la mañana en la sala principal."),
    ("es-06", "Los resultados muestran que la mayoría de los usuarios están satisfechos."),
    ("es-07", "Mañana viajaremos a Madrid para visitar a nuestros amigos."),
    ("es-08", "Gracias por su atención, y hasta la próxima."),
    ("es-09", "El gato duerme tranquilamente sobre la mesa de la cocina."),
]
VOICES = ["ef_dora", "em_alex", "em_santa"]


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def normalize(text, keep_accents=True):
    text = unicodedata.normalize("NFC", text).lower()
    if not keep_accents:
        text = "".join(c for c in unicodedata.normalize("NFD", text) if unicodedata.category(c) != "Mn")
    text = re.sub(r"[^\w\s]|_", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def edit_distance(a, b):
    previous = list(range(len(b) + 1))
    for i, left in enumerate(a, 1):
        current = [i]
        for j, right in enumerate(b, 1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (left != right)))
        previous = current
    return previous[-1]


def error_rates(reference, hypothesis, keep_accents=True):
    ref, hyp = normalize(reference, keep_accents), normalize(hypothesis, keep_accents)
    word_errors, char_errors = edit_distance(ref.split(), hyp.split()), edit_distance(list(ref), list(hyp))
    return word_errors / max(1, len(ref.split())), char_errors / max(1, len(ref)), word_errors, char_errors


def post_json(port, token, body):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=180)
    connection.request("POST", "/v1/synthesize", body=json.dumps(body).encode(),
                       headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    response = connection.getresponse()
    data = response.read()
    headers = dict(response.getheaders())
    connection.close()
    return response.status, data, headers


def wait_ready(port, token, process):
    deadline = time.monotonic() + 240
    while time.monotonic() < deadline:
        if process.poll() is not None:
            sys.exit("the Kokoro worker exited early with code %s" % process.returncode)
        try:
            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            connection.request("GET", "/v1/health", headers={"Authorization": "Bearer " + token})
            response = connection.getresponse()
            body = json.loads(response.read())
            connection.close()
            if response.status == 200:
                return body
        except (OSError, ValueError):
            pass
        time.sleep(1)
    sys.exit("the Kokoro worker did not become ready")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-root", required=True)
    parser.add_argument("--scratch-manifest", required=True, help="manifest that already lists the Spanish voice packs")
    parser.add_argument("--ffmpeg", required=True)
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--threads", type=int, default=8)
    parser.add_argument("--repo-commit", default="")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.abspath(args.model_root)
    kokoro_dir = os.path.join(root, "models", "kokoro-82m")
    whisper_dir = os.path.join(root, "models", "whisper-large-v3-turbo")
    whisper_cli = os.environ.get("MEDIA_WHISPER_CPP_BIN") or os.path.join(
        root, "runtimes", "whisper.cpp-src", "build-vulkan", "bin", "whisper-cli")
    whisper_model = os.path.join(whisper_dir, "ggml-large-v3-turbo.bin")
    worker_script = os.path.join(here, "kokoro_worker.py")
    port = args.port or (20000 + secrets.randbelow(20000))
    token = secrets.token_hex(16)
    env = {"PATH": "/usr/bin:/bin", "HOME": tempfile.gettempdir(), "LC_ALL": "C.UTF-8", "HF_HUB_OFFLINE": "1",
           "TRANSFORMERS_OFFLINE": "1", "PYTHONDONTWRITEBYTECODE": "1", "GHATANA_KOKORO_WORKER_TOKEN": token}
    work = tempfile.mkdtemp(prefix="es-roundtrip-")
    worker = subprocess.Popen([sys.executable, "-I", worker_script, "--model-dir", kokoro_dir, "--manifest",
                               args.scratch_manifest, "--port", str(port), "--parent-pid", str(os.getpid())],
                              env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    results = []
    try:
        health = wait_ready(port, token, worker)
        missing = [v for v in VOICES if v not in health["voices"]]
        if missing:
            sys.exit("the scratch manifest does not list the Spanish voices: " + ",".join(missing))
        for voice in VOICES:
            for sid, text in SENTENCES:
                started = time.monotonic()
                status, data, headers = post_json(port, token, {"text": text, "voice": voice, "lang": "e",
                                                                "speed": 1.0, "deadlineMillis": 120000})
                synth_ms = int((time.monotonic() - started) * 1000)
                if status != 200:
                    sys.exit("synthesis refused: %s %s" % (status, data[:200]))
                wav24 = os.path.join(work, "%s-%s-24k.wav" % (voice, sid))
                wav16 = os.path.join(work, "%s-%s-16k.wav" % (voice, sid))
                with open(wav24, "wb") as handle:
                    handle.write(data)
                subprocess.run([args.ffmpeg, "-nostdin", "-v", "error", "-y", "-i", wav24, "-ac", "1", "-ar",
                                "16000", "-c:a", "pcm_s16le", wav16], check=True)
                base = os.path.join(work, "%s-%s" % (voice, sid))
                started = time.monotonic()
                subprocess.run([whisper_cli, "-m", whisper_model, "-f", wav16, "-l", "es", "-t", str(args.threads),
                                "-np", "-oj", "-of", base], check=True, stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL)
                stt_ms = int((time.monotonic() - started) * 1000)
                with open(base + ".json", "r", encoding="utf-8") as handle:
                    transcription = json.load(handle)
                hypothesis = " ".join(seg["text"].strip() for seg in transcription["transcription"]).strip()
                wer, cer, word_errors, char_errors = error_rates(text, hypothesis)
                wer_na, cer_na, _, _ = error_rates(text, hypothesis, keep_accents=False)
                results.append({
                    "sentenceId": sid, "voice": voice, "reference": text, "hypothesis": hypothesis,
                    "wordErrors": word_errors, "characterErrors": char_errors,
                    "wordErrorRate": round(wer, 4), "characterErrorRate": round(cer, 4),
                    "wordErrorRateAccentInsensitive": round(wer_na, 4),
                    "characterErrorRateAccentInsensitive": round(cer_na, 4),
                    "audioMillis": int(len(data) - 44) // 48, "audioSha256": hashlib.sha256(data).hexdigest(),
                    "synthesisMillis": synth_ms, "recognitionMillis": stt_ms,
                    "kokoroDevice": headers.get("X-Kokoro-Device", "")})
                print("%s %s WER=%.3f CER=%.3f  %s" % (voice, sid, wer, cer, hypothesis), flush=True)
    finally:
        worker.terminate()
        try:
            worker.wait(timeout=15)
        except subprocess.TimeoutExpired:
            worker.kill()

    def aggregate(items):
        ref_words = sum(len(normalize(i["reference"]).split()) for i in items)
        ref_chars = sum(len(normalize(i["reference"])) for i in items)
        word_errors = sum(i["wordErrors"] for i in items)
        char_errors = sum(i["characterErrors"] for i in items)
        return {"utterances": len(items), "referenceWords": ref_words, "referenceCharacters": ref_chars,
                "wordErrorRate": round(word_errors / ref_words, 4),
                "characterErrorRate": round(char_errors / ref_chars, 4)}

    per_voice = {v: aggregate([r for r in results if r["voice"] == v]) for v in VOICES}
    overall = aggregate(results)
    empty = sum(1 for r in results if not normalize(r["hypothesis"]))
    checks = {
        "overallWordErrorRate": overall["wordErrorRate"] <= THRESHOLDS["overallWordErrorRateMax"],
        "overallCharacterErrorRate": overall["characterErrorRate"] <= THRESHOLDS["overallCharacterErrorRateMax"],
        "perVoiceWordErrorRate": all(v["wordErrorRate"] <= THRESHOLDS["perVoiceWordErrorRateMax"]
                                     for v in per_voice.values()),
        "noEmptyRecognition": empty <= THRESHOLDS["sentencesWithNoTextMax"]}
    model_files = {}
    for rel in ["kokoro-v1_0.pth", "config.json"] + ["voices/%s.pt" % v for v in VOICES]:
        model_files["kokoro-82m/" + rel] = sha256_file(os.path.join(kokoro_dir, rel))
    model_files["whisper-large-v3-turbo/ggml-large-v3-turbo.bin"] = sha256_file(whisper_model)
    evidence = {
        "schema": "media.dev.language-roundtrip-evidence.v1",
        "language": "es",
        "purpose": "Admission gate for Spanish on the DEV_ONLY speech lanes (Media owner delegate decision "
                   "2026-11-15). A measured round trip; NOT a quality qualification.",
        "generatedAtUtc": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "method": {
            "synthesis": "kokoro_worker.py (persistent worker, lang code e, speed 1.0), manifest-verified voice packs",
            "resample": "ffmpeg -ac 1 -ar 16000 pcm_s16le",
            "recognition": "whisper-cli -l es -np -oj (explicit language, no auto detection)",
            "normalization": "NFC, lower case, punctuation removed, whitespace collapsed; accents kept (the "
                             "accent-insensitive rates are reported alongside)",
            "errorRates": "Levenshtein over words (WER) and characters (CER) divided by the reference length"},
        "thresholdsDeclaredBeforeTheRun": THRESHOLDS,
        "sentences": [{"id": sid, "text": text} for sid, text in SENTENCES],
        "voices": VOICES,
        "results": results,
        "perVoice": per_voice,
        "overall": overall,
        "emptyRecognitions": empty,
        "checks": checks,
        "admissible": all(checks.values()),
        "artifacts": {
            "sha256": model_files,
            "kokoroWorkerScriptSha256": sha256_file(worker_script),
            "whisperCliSha256": sha256_file(whisper_cli),
            "kokoroManifestSha256Scratch": sha256_file(args.scratch_manifest)},
        "environment": {"kokoroDevice": health.get("device"), "cudaDevice": health.get("cudaDevice"),
                        "torch": health.get("torch"), "whisperThreads": args.threads,
                        "repoCommit": args.repo_commit},
        "limits": ["Nine fixed sentences per voice; a smoke gate, not a quality qualification.",
                   "Synthetic speech from a model of the same family cannot reveal errors that a real human "
                   "speaker would expose; no human listening review was performed.",
                   "productionEligible stays false."]}
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(evidence, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
    for name in os.listdir(work):
        os.unlink(os.path.join(work, name))
    os.rmdir(work)
    print(json.dumps({"overall": overall, "perVoice": per_voice, "checks": checks}, indent=1))
    sys.exit(0 if evidence["admissible"] else 3)


if __name__ == "__main__":
    main()

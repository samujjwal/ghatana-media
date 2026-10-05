# Audio-Video gRPC Load Tests

This directory contains [ghz](https://ghz.sh/) load-test configurations for the audio-video gRPC services.

## Prerequisites

```bash
# Install ghz
brew install ghz
# or
go install github.com/bojand/ghz/cmd/ghz@latest
```

## Directory layout

```
tests/load/
├── stt-load-test.yaml      # STT Transcribe load test
├── tts-load-test.yaml      # TTS Synthesize load test
├── vision-load-test.yaml   # Vision DetectObjects load test
└── payloads/               # Binary request payloads (not committed — generate below)
```

## Generating test payloads

```bash
mkdir -p payloads

# 1-second silent WAV at 8 kHz mono 8-bit (for STT)
python3 -c "
import struct, wave, io
buf = io.BytesIO()
with wave.open(buf, 'wb') as w:
    w.setnchannels(1); w.setsampwidth(1); w.setframerate(8000)
    w.writeframes(bytes(8000))
open('payloads/stt-silence-1s.bin', 'wb').write(buf.getvalue())
print('Created payloads/stt-silence-1s.bin')
"

# 320×240 JPEG placeholder (use any real image for meaningful results)
curl -sL "https://via.placeholder.com/320x240.jpg" -o payloads/test-image-320x240.jpg \
  || cp /path/to/your/test-image.jpg payloads/test-image-320x240.jpg
```

## Running the tests

Start the services first (see product README), then:

```bash
# STT — 1000 requests at 50 concurrent
ghz --config stt-load-test.yaml

# TTS — 1000 requests at 50 concurrent
ghz --config tts-load-test.yaml

# Vision — 500 requests at 20 concurrent
ghz --config vision-load-test.yaml
```

## Interpreting results

The `*.json` output files contain:
- `count`, `total`, `average`, `fastest`, `slowest`, `rps`
- Latency distribution (p50, p75, p90, p95, p99)
- Status code breakdown (OK, DeadlineExceeded, Unavailable, …)

A healthy service should show:
| Metric          | STT       | TTS       | Vision    |
|:----------------|:----------|:----------|:----------|
| p99 latency     | < 3 s     | < 5 s     | < 8 s     |
| Error rate      | < 0.1 %%  | < 0.1 %%  | < 0.5 %%  |

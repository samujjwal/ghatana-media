from __future__ import annotations

import os
import sys
from pathlib import Path

# Offline-by-default flags must be in the environment before transformers /
# huggingface_hub are first imported in this process, regardless of which test
# module happens to trigger that import.
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

#!/usr/bin/env python3
"""Measure per-process ru_maxrss for the deterministic Rust decode probe."""

import argparse
import os
import platform
import subprocess
import sys

EXPECTED_CHILD_OUTPUT = (
    "decoded input_bytes=320044 sample_rate_hz=16000 channels=1 "
    "duration_seconds=10 samples=160000"
)


def parse_args():
    parser = argparse.ArgumentParser(
        description="Run the built decode-rss-probe example in separate child processes."
    )
    parser.add_argument("binary", help="path to the already-built decode-rss-probe executable")
    parser.add_argument("--runs", type=int, default=5, help="number of child processes (1..100; default: 5)")
    args = parser.parse_args()
    if not 1 <= args.runs <= 100:
        parser.error("--runs must be between 1 and 100")
    if not os.path.isfile(args.binary) or not os.access(args.binary, os.X_OK):
        parser.error("binary must name an existing executable file")
    if not hasattr(os, "wait4"):
        parser.error("this Python/platform does not provide os.wait4 for per-child ru_maxrss")
    return args


def rss_unit():
    # getrusage(2) reports bytes on Darwin and KiB on Linux.
    if sys.platform == "darwin":
        return "bytes"
    if sys.platform == "linux":
        return "KiB"
    raise ValueError(f"unsupported platform for ru_maxrss units: {sys.platform}")


def main():
    args = parse_args()
    try:
        unit = rss_unit()
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 2
    rss_values = []
    print(f"platform={platform.platform()} system={platform.system()} ru_maxrss_unit={unit}")
    print("input=deterministic PCM WAV sample_rate_hz=16000 channels=1 duration_seconds=10 samples=160000 max_input_bytes=1000000 max_decoded_samples=160000")
    print("measurement_scope=ru_maxrss includes process startup and WAV fixture creation")
    print(f"runs={args.runs}")

    for index in range(1, args.runs + 1):
        child = subprocess.Popen([args.binary], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            _, status, usage = os.wait4(child.pid, 0)
        except BaseException:
            child.kill()
            child.wait()
            raise
        child.returncode = os.waitstatus_to_exitcode(status)
        stdout, stderr = child.communicate()
        if child.returncode != 0:
            print(f"run={index} child_exit={child.returncode} stderr={stderr.strip()}", file=sys.stderr)
            return child.returncode or 1
        if stdout.strip() != EXPECTED_CHILD_OUTPUT:
            print(
                f"run={index} child output mismatch: expected {EXPECTED_CHILD_OUTPUT!r}, "
                f"got {stdout.strip()!r}",
                file=sys.stderr,
            )
            return 1
        rss_values.append(usage.ru_maxrss)
        print(f"run={index} ru_maxrss={usage.ru_maxrss} {unit} child={stdout.strip()}")

    ordered = sorted(rss_values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        median = ordered[middle]
    else:
        median = (ordered[middle - 1] + ordered[middle]) / 2
        if median.is_integer():
            median = int(median)
    print(f"summary runs={len(rss_values)} min={min(rss_values)} max={max(rss_values)} median={median} {unit}")
    print("scope=diagnostic host-process characterization; not an enforced limit or production workload claim")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

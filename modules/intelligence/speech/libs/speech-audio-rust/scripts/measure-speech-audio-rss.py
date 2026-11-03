#!/usr/bin/env python3
"""Measure per-process ru_maxrss for the deterministic Rust decode probe."""

import argparse
import errno
import os
import platform
import re
import selectors
import signal
import subprocess
import sys
import time

EXPECTED_CHILD_OUTPUT = (
    "decoded input_bytes=320044 sample_rate_hz=16000 channels=1 "
    "duration_seconds=10 samples=160000"
)
PEAK_RSS_OUTPUT = re.compile(r"peak_rss_bytes=([1-9][0-9]*) measurement=process_getrusage")
MAX_CHILD_OUTPUT_BYTES = 64 * 1024
CHILD_TIMEOUT_SECONDS = 120
CHILD_CLEANUP_SECONDS = 2


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


def parse_child_output(stdout, run_index):
    lines = stdout.splitlines()
    if len(lines) != 2 or lines[0] != EXPECTED_CHILD_OUTPUT:
        raise ValueError(
            f"run={run_index} child output mismatch: expected decode report and RSS measurement, "
            f"got {stdout.strip()!r}"
        )
    match = PEAK_RSS_OUTPUT.fullmatch(lines[1])
    if match is None:
        raise ValueError(f"run={run_index} child RSS measurement is malformed: {lines[1]!r}")
    return int(match.group(1))


def collect_child(binary, run_index, timeout_seconds=CHILD_TIMEOUT_SECONDS):
    """Drain bounded child output while wait4 collects that child's peak RSS."""
    child = subprocess.Popen(
        [binary],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        bufsize=0,
        start_new_session=True,
    )
    selector = selectors.DefaultSelector()
    output = {"stdout": bytearray(), "stderr": bytearray()}
    usage = None
    status = None
    failure = None
    cleanup_note = None
    cleanup_deadline = None
    deadline = time.monotonic() + timeout_seconds

    for name, stream in (("stdout", child.stdout), ("stderr", child.stderr)):
        selector.register(stream, selectors.EVENT_READ, name)

    def kill_child():
        nonlocal cleanup_note
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except OSError as error:
            if error.errno == errno.ESRCH:
                return
            if error.errno != errno.EPERM:
                cleanup_note = f"process-group SIGKILL failed: {error}"
            try:
                # Keep the measured child killable even when group signaling is denied.
                os.kill(child.pid, signal.SIGKILL)
            except OSError as child_error:
                if child_error.errno != errno.ESRCH:
                    cleanup_note = f"child SIGKILL failed: {child_error}"
            if error.errno == errno.EPERM:
                cleanup_note = "process-group SIGKILL denied (EPERM); attempted direct-child SIGKILL"

    try:
        while selector.get_map() or status is None:
            if failure is None and time.monotonic() >= deadline:
                failure = f"run={run_index} child timed out after {timeout_seconds:g}s"
                cleanup_deadline = time.monotonic() + CHILD_CLEANUP_SECONDS
                kill_child()
            if cleanup_deadline is not None and time.monotonic() >= cleanup_deadline:
                # A descendant may have escaped the process group while keeping
                # inherited pipes open. Stop draining after the bounded cleanup window.
                for key in list(selector.get_map().values()):
                    selector.unregister(key.fileobj)

            wait_seconds = 0.05
            if failure is None:
                wait_seconds = min(wait_seconds, max(0, deadline - time.monotonic()))
            for key, _ in selector.select(wait_seconds):
                chunk = os.read(key.fileobj.fileno(), 8192)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                captured = output[key.data]
                captured_total = len(output["stdout"]) + len(output["stderr"])
                remaining = MAX_CHILD_OUTPUT_BYTES - captured_total
                captured.extend(chunk[:remaining])
                if len(chunk) > remaining and failure is None:
                    failure = (
                        f"run={run_index} child output exceeded "
                        f"{MAX_CHILD_OUTPUT_BYTES} bytes"
                    )
                    cleanup_deadline = time.monotonic() + CHILD_CLEANUP_SECONDS
                    kill_child()

            if status is None:
                try:
                    waited_pid, child_status, child_usage = os.wait4(child.pid, os.WNOHANG)
                except InterruptedError:
                    continue
                if waited_pid == child.pid:
                    status = child_status
                    usage = child_usage
                    child.returncode = os.waitstatus_to_exitcode(status)

        if failure is not None:
            if cleanup_note is not None:
                failure = f"{failure}; cleanup: {cleanup_note}"
            raise RuntimeError(failure)
        return (
            output["stdout"].decode("utf-8", errors="replace"),
            output["stderr"].decode("utf-8", errors="replace"),
            child.returncode,
            usage,
        )
    except BaseException:
        # If interrupted or selector handling fails, always reap the exact child.
        kill_child()
        if status is None:
            while True:
                try:
                    waited_pid, child_status, child_usage = os.wait4(child.pid, 0)
                    if waited_pid == child.pid:
                        child.returncode = os.waitstatus_to_exitcode(child_status)
                        status = child_status
                        usage = child_usage
                        break
                except InterruptedError:
                    continue
                except ChildProcessError:
                    break
        raise
    finally:
        selector.close()
        child.stdout.close()
        child.stderr.close()


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
        try:
            stdout, stderr, returncode, usage = collect_child(args.binary, index)
        except RuntimeError as error:
            print(str(error), file=sys.stderr)
            return 1
        if returncode != 0:
            print(f"run={index} child_exit={returncode} stderr={stderr.strip()}", file=sys.stderr)
            return returncode or 1
        try:
            reported_peak_rss_bytes = parse_child_output(stdout, index)
        except ValueError as mismatch:
            print(str(mismatch), file=sys.stderr)
            return 1
        rss_values.append(usage.ru_maxrss)
        print(
            f"run={index} ru_maxrss={usage.ru_maxrss} {unit} "
            f"reported_peak_rss_bytes={reported_peak_rss_bytes}"
        )

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

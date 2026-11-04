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

GLOBAL_MAX_INPUT_BYTES = 512 * 1024 * 1024
GLOBAL_MAX_DECODED_SAMPLES = 96_000_000
GLOBAL_MAX_DURATION_SECONDS = 6 * 60 * 60
HIGH_WATER_MAX_INPUT_BYTES = 32 * 1024 * 1024 + 44

PROFILES = {
    "baseline": {
        "duration_seconds": 10,
        "samples": 160_000,
        "input_bytes": 320_044,
        "max_input_bytes": 1_000_000,
        "max_decoded_samples": 160_000,
        "description": "10 s / 160,000 samples",
    },
    "high-water": {
        "duration_seconds": 1_000,
        "samples": 16_000_000,
        "input_bytes": 32_000_044,
        "max_input_bytes": HIGH_WATER_MAX_INPUT_BYTES,
        "max_decoded_samples": 16_000_000,
        "description": "1,000 s / 16,000,000 samples (64,000,000 bytes, about 61 MiB f32 output)",
    },
    "hard-cap": {
        "duration_seconds": 6_000,
        "samples": 96_000_000,
        "input_bytes": 192_000_044,
        "max_input_bytes": GLOBAL_MAX_INPUT_BYTES,
        "max_decoded_samples": GLOBAL_MAX_DECODED_SAMPLES,
        "description": "6,000 s / 96,000,000 samples (384,000,000 bytes, about 366 MiB f32 output)",
    },
}


def validate_profile(profile, values=None):
    """Validate a closed profile against global ceilings and its own caps."""
    if profile not in PROFILES:
        raise ValueError(f"unknown closed probe profile: {profile}")
    selected = PROFILES[profile] if values is None else values
    expected_input_bytes = 44 + selected["samples"] * 2
    if (
        selected["samples"] > GLOBAL_MAX_DECODED_SAMPLES
        or selected["duration_seconds"] > GLOBAL_MAX_DURATION_SECONDS
        or expected_input_bytes > GLOBAL_MAX_INPUT_BYTES
        or selected["max_decoded_samples"] > GLOBAL_MAX_DECODED_SAMPLES
        or selected["max_input_bytes"] > GLOBAL_MAX_INPUT_BYTES
    ):
        raise ValueError(f"profile {profile} exceeds global high-water ceilings")
    if (
        selected["samples"] > selected["max_decoded_samples"]
        or expected_input_bytes > selected["max_input_bytes"]
        or expected_input_bytes != selected["input_bytes"]
    ):
        raise ValueError(f"profile {profile} fixture exceeds its selected input or decoded-sample cap")
    return selected


def expected_child_output(profile):
    values = validate_profile(profile)
    return (
        f"profile={profile} decoded input_bytes={values['input_bytes']} sample_rate_hz=16000 "
        f"channels=1 duration_seconds={values['duration_seconds']} samples={values['samples']} "
        f"max_input_bytes={values['max_input_bytes']} "
        f"max_decoded_samples={values['max_decoded_samples']}"
    )


EXPECTED_CHILD_OUTPUT = expected_child_output("baseline")
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
    parser.add_argument(
        "--profile",
        choices=tuple(PROFILES),
        default="baseline",
        help="closed deterministic workload profile (default: baseline)",
    )
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


def parse_child_output(stdout, run_index, profile="baseline"):
    lines = stdout.splitlines()
    expected_output = expected_child_output(profile)
    if len(lines) != 2 or lines[0] != expected_output:
        raise ValueError(
            f"run={run_index} child output mismatch: expected decode report and RSS measurement, "
            f"got {stdout.strip()!r}"
        )
    match = PEAK_RSS_OUTPUT.fullmatch(lines[1])
    if match is None:
        raise ValueError(f"run={run_index} child RSS measurement is malformed: {lines[1]!r}")
    return int(match.group(1))


def collect_child(binary, run_index, timeout_seconds=CHILD_TIMEOUT_SECONDS, profile="baseline"):
    """Drain bounded child output while wait4 collects that child's peak RSS."""
    validate_profile(profile)
    child = subprocess.Popen(
        [binary, "--profile", profile],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        bufsize=0,
        start_new_session=True,
    )
    selector = selectors.DefaultSelector()
    output = {"stdout": bytearray(), "stderr": bytearray()}
    usage = None
    status = None
    reap_unavailable = False
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
            group_error = error
            try:
                # Keep the measured child killable even when group signaling is denied.
                os.kill(child.pid, signal.SIGKILL)
            except OSError as child_error:
                if child_error.errno == errno.ESRCH:
                    return
                cleanup_note = (
                    f"process-group SIGKILL failed: {group_error}; "
                    f"direct-child SIGKILL failed: {child_error}"
                )
            else:
                cleanup_note = (
                    "process-group SIGKILL denied (EPERM); "
                    "direct-child SIGKILL was attempted"
                    if group_error.errno == errno.EPERM
                    else f"process-group SIGKILL failed: {group_error}; direct-child SIGKILL was sent"
                )

    def reap_until(reap_deadline):
        nonlocal status, usage, reap_unavailable
        while status is None:
            try:
                waited_pid, child_status, child_usage = os.wait4(child.pid, os.WNOHANG)
            except InterruptedError:
                continue
            except ChildProcessError:
                reap_unavailable = True
                return False
            if waited_pid == child.pid:
                status = child_status
                usage = child_usage
                child.returncode = os.waitstatus_to_exitcode(status)
                return True
            if time.monotonic() >= reap_deadline:
                return False
            time.sleep(min(0.05, max(0, reap_deadline - time.monotonic())))
        return status is not None

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
                if status is None and not reap_until(time.monotonic()):
                    if reap_unavailable:
                        failure = (
                            f"{failure}; child_wait_status_unavailable; ru_maxrss_unavailable; "
                            f"child_pid_unconfirmed={child.pid}"
                        )
                    else:
                        failure = f"{failure}; child_pid_unconfirmed={child.pid}"
                    break

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
                except ChildProcessError:
                    reap_unavailable = True
                    failure = (
                        f"run={run_index} child wait status unavailable; ru_maxrss unavailable; "
                        f"child_pid_unconfirmed={child.pid}"
                    )
                    for key in list(selector.get_map().values()):
                        selector.unregister(key.fileobj)
                    break
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
    except BaseException as original_error:
        # Cleanup remains bounded even when both group and direct-child signals fail.
        if reap_unavailable:
            cleanup_error = RuntimeError(
                f"{original_error}; child wait status unavailable; ru_maxrss unavailable; "
                f"child_pid_unconfirmed={child.pid}"
            )
            cleanup_error.child_process = child
            raise cleanup_error from original_error
        if (
            status is None
            and cleanup_deadline is not None
            and time.monotonic() >= cleanup_deadline
            and f"child_pid_unconfirmed={child.pid}" in str(original_error)
        ):
            original_error.child_process = child
            raise
        kill_child()
        if status is None and not reap_until(time.monotonic() + CHILD_CLEANUP_SECONDS):
            details = cleanup_note or "child did not exit before the bounded cleanup deadline"
            cleanup_error = RuntimeError(
                f"{original_error}; child_pid_unconfirmed={child.pid}; cleanup={details}"
            )
            cleanup_error.child_process = child
            raise cleanup_error from original_error
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
    profile = args.profile
    profile_values = PROFILES[profile]
    print(
        f"input=deterministic PCM WAV profile={profile} {profile_values['description']} "
        f"sample_rate_hz=16000 channels=1 input_bytes={profile_values['input_bytes']} "
        f"max_input_bytes={profile_values['max_input_bytes']} "
        f"max_decoded_samples={profile_values['max_decoded_samples']}"
    )
    print("measurement_scope=ru_maxrss includes process startup and WAV fixture creation")
    print(f"runs={args.runs}")

    for index in range(1, args.runs + 1):
        try:
            stdout, stderr, returncode, usage = collect_child(args.binary, index, profile=profile)
        except RuntimeError as error:
            print(str(error), file=sys.stderr)
            return 1
        if returncode != 0:
            print(f"run={index} child_exit={returncode} stderr={stderr.strip()}", file=sys.stderr)
            return returncode or 1
        try:
            reported_peak_rss_bytes = parse_child_output(stdout, index, profile)
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

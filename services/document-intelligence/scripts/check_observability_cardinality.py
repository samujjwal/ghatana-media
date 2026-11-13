#!/usr/bin/env python3
"""Observability cardinality checker (I6-60).

Static enforcement of ``config/observability-labels.v1.yaml``:

  1. ``observability.py`` SAFE_FIELDS must not contain any forbidden
     (unbounded/sensitive) name.  ``operationId`` may remain in SAFE_FIELDS —
     that is log correlation context, not a metric label.
  2. Every metric-emission call site under ``src/document_intelligence/``
     may only use label names declared in ``allowed``; forbidden names and
     correlation-only names (operationId/correlationId) are rejected.

There is no metrics subsystem today; the scan is forward-looking so a future
emission helper cannot silently introduce unbounded cardinality.
"""
from __future__ import annotations

import argparse
import ast
import json
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
POLICY = ROOT / "config/observability-labels.v1.yaml"
SRC = ROOT / "src/document_intelligence"
OBSERVABILITY = SRC / "observability.py"

# Names that mark a metric-emission call site.  The worker has no metrics
# helper today; this set defines what the scan treats as emission so future
# helpers (counter/gauge/histogram/summary/observe/metric/labels/…) are
# caught the day they appear.
_METRIC_HINTS = frozenset(
    {
        "counter",
        "gauge",
        "histogram",
        "summary",
        "observe",
        "metric",
        "metrics",
        "emit_metric",
        "record_metric",
        "labels",
        "labelled",
        "inc",
        "dec",
    }
)

# Arguments at a metric call site that are label *values*, not label names
# (e.g. counter.inc(amount=1)).  They are exempt from the allowed-label check.
_NON_LABEL_KWARGS = frozenset({"amount", "value", "count", "delta", "step", "description", "documentation", "name", "namespace", "subsystem", "unit", "buckets", "registry"})


def load_policy(path: Path = POLICY) -> dict:
    document = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(document, dict) or document.get("schemaVersion") != "document-intelligence.observability-labels.v1":
        raise ValueError("observability-labels authority schemaVersion mismatch")
    labels = document.get("metricLabels")
    if not isinstance(labels, dict):
        raise ValueError("observability-labels authority requires metricLabels")
    for key in ("allowed", "forbidden", "correlationOnly"):
        entries = labels.get(key)
        if not isinstance(entries, list) or not entries or any(not isinstance(item, str) for item in entries):
            raise ValueError(f"metricLabels.{key} must be a non-empty string list")
    return labels


def _call_root_name(node: ast.AST) -> str | None:
    """Return the terminal attribute/name of a call's function expression."""
    current = node
    while isinstance(current, ast.Attribute):
        current = current.value
    if isinstance(current, ast.Name):
        return current.id
    return None


def _call_method_name(node: ast.AST) -> str | None:
    func = getattr(node, "func", None)
    if isinstance(func, ast.Attribute):
        return func.attr
    if isinstance(func, ast.Name):
        return func.id
    return None


def _label_names_in_call(call: ast.Call) -> set[str]:
    """Collect candidate label names used at a metric call site.

    Label names arrive as keyword arguments (``labels(provider=...)``) or as
    string literals (``labels("provider", ...)`` / ``labelnames=[...]``).
    """
    names: set[str] = set()
    for keyword in call.keywords:
        if keyword.arg is None:
            continue
        if keyword.arg in _NON_LABEL_KWARGS:
            continue
        names.add(keyword.arg)
        # kwargs like labelnames=["a","b"] carry names as literals
        if isinstance(keyword.value, (ast.List, ast.Tuple, ast.Set)):
            for element in keyword.value.elts:
                if isinstance(element, ast.Constant) and isinstance(element.value, str):
                    names.add(element.value)
    for arg in call.args:
        if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
            names.add(arg.value)
    return names


def _is_metric_call(call: ast.Call) -> bool:
    method = _call_method_name(call)
    root = _call_root_name(call.func) if isinstance(call.func, ast.Attribute) else None
    return (method in _METRIC_HINTS) or (root in _METRIC_HINTS)


def _safe_fields(observability_path: Path) -> frozenset[str]:
    """Evaluate the SAFE_FIELDS literal without importing the module."""
    tree = ast.parse(observability_path.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id == "SAFE_FIELDS" for target in node.targets
        ):
            value_node = node.value
            # SAFE_FIELDS is written as frozenset({...}); unwrap the call.
            if (
                isinstance(value_node, ast.Call)
                and isinstance(value_node.func, ast.Name)
                and value_node.func.id == "frozenset"
                and len(value_node.args) == 1
            ):
                value_node = value_node.args[0]
            value = ast.literal_eval(value_node)
            return frozenset(value)
    raise ValueError("SAFE_FIELDS assignment not found in observability.py")


def check(src_root: Path = SRC, policy_path: Path = POLICY, observability_path: Path | None = None) -> list[str]:
    errors: list[str] = []
    labels = load_policy(policy_path)
    allowed = set(labels["allowed"])
    forbidden = set(labels["forbidden"])
    correlation_only = set(labels["correlationOnly"])

    observability = observability_path or (src_root / "observability.py")
    if observability.exists():
        safe = _safe_fields(observability)
        leaked = sorted(safe & forbidden)
        if leaked:
            errors.append(f"SAFE_FIELDS contains forbidden label names: {leaked}")
    else:
        errors.append(f"observability module missing: {observability}")

    for path in sorted(src_root.rglob("*.py")):
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
        except (SyntaxError, OSError) as exc:
            errors.append(f"{path.relative_to(src_root)}: unparsable source ({exc})")
            continue
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call) or not _is_metric_call(node):
                continue
            names = _label_names_in_call(node)
            location = f"{path.relative_to(src_root)}:{node.lineno}"
            for name in sorted(names & forbidden):
                errors.append(f"{location}: forbidden label name '{name}' in metric call")
            for name in sorted(names & correlation_only):
                errors.append(f"{location}: correlation id '{name}' used as a metric label")
            for name in sorted(names - allowed - forbidden - correlation_only):
                errors.append(f"{location}: label name '{name}' not in allowed bounded label set")
    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--policy", type=Path, default=POLICY)
    parser.add_argument("--src", type=Path, default=SRC)
    args = parser.parse_args(argv)
    try:
        errors = check(args.src, args.policy)
    except ValueError as exc:
        print(json.dumps({"status": "FAIL", "errors": [str(exc)]}, indent=2))
        return 1
    if errors:
        print(json.dumps({"status": "FAIL", "errors": errors}, indent=2))
        return 1
    print(json.dumps({"status": "PASS"}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

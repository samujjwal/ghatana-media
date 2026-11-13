#!/usr/bin/env python3
"""Executable invalidation graph for document-intelligence proofs (P0-02).

Commands:

    check                         validate graph structure and symmetry
    impact --changed <path> ...   changed material -> affected -> downstream -> preserved

Path arguments are either `repo:relative/path` (repo in {worker, product,
shared}) or a bare relative path, which is matched against every repo's
``owns`` globs.
"""
from __future__ import annotations

import argparse
import fnmatch
import json
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
GRAPH = ROOT / "verification/document-intelligence-proof-graph.yaml"
LEGACY = ROOT / "docs/evidence/leaf-dependencies.v1.json"


def load_graph(path: Path = GRAPH) -> dict:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or data.get("schemaVersion") != "document-intelligence.proof-graph.v1":
        raise ValueError("proof graph must declare schemaVersion document-intelligence.proof-graph.v1")
    if not isinstance(data.get("leaves"), dict) or not data["leaves"]:
        raise ValueError("proof graph must declare leaves")
    return data


def _match(path: str, glob: str) -> bool:
    return fnmatch.fnmatchcase(path, glob) or fnmatch.fnmatchcase(path, glob + "/**")


def _normalize(change: str) -> tuple[str | None, str]:
    if ":" in change:
        repo, _, rel = change.partition(":")
        return (repo, rel)
    return (None, change)


def _owned(leaf: dict, change: str) -> bool:
    repo, rel = _normalize(change)
    for exclude in leaf.get("ownsExcludes", []):
        ex_repo, _, ex_rel = exclude.partition(":")
        if (repo is None or repo == ex_repo) and _match(rel, ex_rel):
            return False
    for glob in leaf.get("owns", []):
        owner_repo, _, owner_rel = glob.partition(":")
        if repo is not None and repo != owner_repo:
            continue
        if _match(rel, owner_rel):
            return True
    return False


def downstream_closure(graph: dict, affected: set[str]) -> set[str]:
    """Leaves that transitively depend on any affected leaf."""
    leaves = graph["leaves"]
    dependents: dict[str, set[str]] = {}
    for leaf_id, leaf in leaves.items():
        for dep in leaf.get("dependsOn", []):
            dependents.setdefault(dep, set()).add(leaf_id)
    seen: set[str] = set()
    stack = list(affected)
    while stack:
        current = stack.pop()
        for dependent in dependents.get(current, ()):
            if dependent not in seen and dependent not in affected:
                seen.add(dependent)
                stack.append(dependent)
    return seen


def impact(graph: dict, changed: list[str]) -> dict:
    leaves = graph["leaves"]
    affected = sorted(
        leaf_id for leaf_id, leaf in leaves.items() if any(_owned(leaf, c) for c in changed)
    )
    downstream = sorted(downstream_closure(graph, set(affected)))
    preserved = sorted(set(leaves) - set(affected) - set(downstream))
    return {
        "schemaVersion": "document-intelligence.proof-impact.v1",
        "changed": changed,
        "affectedLeaves": affected,
        "downstreamLeaves": downstream,
        "preservedLeaves": preserved,
    }


def check(graph: dict) -> list[str]:
    errors: list[str] = []
    leaves = graph["leaves"]
    for leaf_id, leaf in leaves.items():
        for field in ("owns", "dependsOn", "invalidates", "expensive"):
            if field not in leaf:
                errors.append(f"{leaf_id}: missing {field}")
        for excl in leaf.get("ownsExcludes", []):
            ex_repo, _, ex_rel = excl.partition(":")
            covered = any(
                g.partition(":")[2] == ex_rel
                or _match(ex_rel, g.partition(":")[2])
                for g in leaf.get("owns", [])
                if g.partition(":")[0] == ex_repo
            )
            if not covered:
                errors.append(f"{leaf_id}: ownsExcludes {excl} is not covered by owns")
        if not isinstance(leaf.get("expensive"), bool):
            errors.append(f"{leaf_id}: expensive must be boolean")
        for dep in leaf.get("dependsOn", []):
            if dep not in leaves:
                errors.append(f"{leaf_id}: dependsOn unknown leaf {dep}")
        for inv in leaf.get("invalidates", []):
            if inv not in leaves:
                errors.append(f"{leaf_id}: invalidates unknown leaf {inv}")
    # invalidates must equal the reverse closure of dependsOn (symmetry rule)
    for leaf_id, leaf in leaves.items():
        expected = sorted(
            other for other, body in leaves.items() if leaf_id in body.get("dependsOn", [])
        )
        declared = sorted(leaf.get("invalidates", []))
        if declared != expected:
            errors.append(
                f"{leaf_id}: invalidates {declared} != reverse-dependsOn {expected}"
            )
    # leaf compatibility with the sealed dependency catalog
    if LEGACY.exists():
        catalog = json.loads(LEGACY.read_text(encoding="utf-8"))
        missing = sorted(set(catalog.get("leaves", {})) - set(leaves))
        if missing:
            errors.append(f"graph missing sealed catalog leaves: {missing}")
        # Extra leaves are allowed: the graph is the live invalidation
        # authority and new increments append leaves without touching the
        # sealed catalog.
    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--graph", type=Path, default=GRAPH)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("check")
    impact_parser = sub.add_parser("impact")
    impact_parser.add_argument("--changed", nargs="+", required=True)
    args = parser.parse_args(argv)

    graph = load_graph(args.graph)
    if args.command == "check":
        errors = check(graph)
        if errors:
            print(json.dumps({"status": "FAIL", "errors": errors}, indent=2))
            return 1
        print(json.dumps({"status": "PASS", "leaves": len(graph["leaves"])}))
        return 0
    result = impact(graph, args.changed)
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

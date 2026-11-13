"""Candidate dependency graph (I5-22).

Builds a deterministic graph view over the registry: nodes are registered
candidates; an edge candidateA -> authorityDependency means A consumed that
authority; two candidates sharing a dependency fingerprint are siblings.
A dependency change produces a NEW candidateId (see registry.candidate_id_for),
so this graph is append-only and version-respecting — older candidates keep
their recorded edges.
"""
from __future__ import annotations

from pathlib import Path

from . import registry


def build_graph(registry_root: Path) -> dict:
    manifests = registry.list_candidates(registry_root)
    nodes = []
    edges: dict[str, list[str]] = {}
    for manifest in manifests:
        candidate_id = manifest["candidateId"]
        nodes.append(
            {
                "candidateId": candidate_id,
                "kind": manifest["candidateKind"],
                "state": manifest["state"],
                "candidateFingerprint": manifest["candidateFingerprint"],
            }
        )
        edges[candidate_id] = sorted(
            f"{key}={value}"
            for key, value in manifest.get("dependencies", {}).items()
        )
    return {
        "schemaVersion": "document-intelligence.candidate-graph.v1",
        "nodes": sorted(nodes, key=lambda n: n["candidateId"]),
        "edges": edges,
    }


def dependents_on(registry_root: Path, dependency_key: str, fingerprint: str) -> list[str]:
    """Candidates whose recorded dependencies bind the given fingerprint."""
    return sorted(
        m["candidateId"]
        for m in registry.list_candidates(registry_root)
        if m.get("dependencies", {}).get(dependency_key) == fingerprint
    )

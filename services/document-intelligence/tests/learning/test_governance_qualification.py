from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from helpers import make_event, write_event_root  # noqa: E402
from learning.datasets.build_dataset import check_leakage  # noqa: E402
from learning.datasets.qualification import (  # noqa: E402
    check_statistical_sufficiency,
    freeze_holdout,
)
from learning.feedback.events import eligible_events, load_event_root  # noqa: E402
from learning.feedback.governance import (  # noqa: E402
    assess_event,
    resolve_conflicting_reviews,
)
from learning.util import digest  # noqa: E402


def test_equal_authority_conflict_is_quarantined_without_timestamp_ordering():
    first = make_event("first")["review"]
    second = make_event("second")["review"]
    first["reviewId"] = "review-a"
    second["reviewId"] = "review-b"
    for review, reviewer, authorization in (
        (first, "reviewer-a", "auth-a"),
        (second, "reviewer-b", "auth-b"),
    ):
        review["reviewerAuthority"] = {
            "reviewerRef": reviewer,
            "authorizationClass": "HUMAN_REVIEWER",
            "authorizationRef": authorization,
            "authorityRank": 1,
            "reviewRevision": 2,
            "correctionRevision": 1,
        }
    second["terminalAction"] = "REJECT"
    second["finalizedAt"] = "2099-01-01T00:00:00Z"

    result = resolve_conflicting_reviews([second, first])
    assert result["state"] == "QUARANTINED"
    assert result["reasonCode"] == "CONFLICTING_REVIEWS"
    assert len(result["reviewerFingerprints"]) == 2


def test_poisoned_correction_is_not_learning_eligible():
    event = make_event("poisoned")
    event["review"]["corrections"][0]["correctionId"] = "duplicate"
    event["review"]["corrections"].append(dict(event["review"]["corrections"][0]))
    verdict = assess_event(event)
    assert verdict.state == "QUARANTINED"
    assert verdict.reason_codes == ("CORRECTION_ID_INVALID",)

    event["review"]["poisoningAssessment"] = {
        "state": "QUARANTINED",
        "reasonCode": "EXTERNAL_POISONING_SIGNAL",
    }
    assert assess_event(event).reason_codes == (
        "CORRECTION_ID_INVALID",
        "EXTERNAL_POISONING_SIGNAL",
    )


def test_holdout_and_support_authorities_are_deterministic_and_fail_closed():
    events = [make_event("a", language="en"), make_event("b", language="ne")]
    first = freeze_holdout(
        events, holdout_id="qualification-v1", event_ids=[events[0]["eventId"]]
    )
    second = freeze_holdout(
        list(reversed(events)), holdout_id="qualification-v1", event_ids=[events[0]["eventId"]]
    )
    assert first == second
    result = check_statistical_sufficiency(
        events, {"language:en": 2, "field:identityDocumentNumber": 3}
    )
    assert result["status"] == "NOT_QUALIFIED"
    assert {item["subgroup"] for item in result["deficits"]} == {
        "field:identityDocumentNumber",
        "language:en",
    }


def test_near_duplicate_leakage_is_a_distinct_failed_check():
    train = make_event("train")
    evaluation = make_event("evaluation")
    train["source"]["nearDuplicateFingerprint"] = train["source"]["sourceContentFingerprint"]
    evaluation["source"]["nearDuplicateFingerprint"] = train["source"]["nearDuplicateFingerprint"]
    checks = check_leakage([train], [evaluation])
    near_duplicate = next(item for item in checks if item["check"] == "NEAR_DUPLICATE_SOURCE")
    assert near_duplicate["status"] == "FAIL"


def test_eligible_events_reject_explicit_poisoning_assessment(tmp_path: Path):
    event = make_event("assessed")
    event["review"]["poisoningAssessment"] = {
        "state": "QUARANTINED",
        "reasonCodes": ["POISONING_SIGNAL"],
    }
    event["eventFingerprint"] = digest(
        {key: value for key, value in event.items() if key != "eventFingerprint"}
    )
    loaded = load_event_root(write_event_root(tmp_path / "events", [event]))
    assert eligible_events(loaded) == ()

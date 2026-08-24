from pathlib import Path
from unittest.mock import patch

from backend.coaching.retriever import generate_coaching, retrieve_notes
from backend.domain.models import ShotAnalysis


GOOD_QUALITY = {
    "tier": "good",
    "camera_motion": 0.04,
    "blur_score": 0.82,
    "pose_coverage": 0.74,
}


def _shot(
    shot_id: int,
    *,
    outcome: str = "make",
    entry: float | None = 46.0,
    speed: float | None = 7.0,
    height: float | None = 2.3,
    elbow: float | None = 160.0,
) -> ShotAnalysis:
    return ShotAnalysis(
        id=shot_id,
        outcome=outcome,
        confidence=0.88,
        release_frame=100 + shot_id * 30,
        release_time=3.0 + shot_id,
        end_frame=125 + shot_id * 30,
        release_speed_ms=speed,
        release_height_m=height,
        entry_angle_deg=entry,
        arc_peak_m=3.7,
        form={"elbow": elbow, "knee": 165.0, "shoulder": 120.0, "hip": 170.0},
        flags=[],
        evidence={
            "rim_track_confidence": 0.9,
            "pose_confidence": 0.86,
            "observed_ball_frames": 30,
            "tracked_frames": 34,
            "crossing_frame": 120,
        },
        trace=[],
    )


def test_retrieval_ranks_matching_local_note() -> None:
    notes = retrieve_notes("elbow extension follow through finish", topics={"elbow"})

    assert notes
    assert notes[0].id == "follow-through"
    assert notes[0].source_id == "jr-nba-shooting"


def test_coaching_is_stable_short_grounded_and_has_no_em_dash() -> None:
    shot = _shot(1)
    first = generate_coaching([shot], GOOD_QUALITY)[1]
    second = generate_coaching([shot], GOOD_QUALITY)[1]

    assert first == second
    assert [tip["tone"] for tip in first["tips"]] == ["positive", "action", "consistency"]
    assert len(first["tips"]) == 3
    assert sum(len(tip["text"].split()) for tip in first["tips"]) <= 65
    assert "—" not in first["intro"]
    assert all("—" not in tip["text"] for tip in first["tips"])
    source_ids = {source["id"] for source in first["sources"]}
    assert source_ids == {source_id for tip in first["tips"] for source_id in tip["source_ids"]}
    assert first["matched_source_count"] == len(first["sources"])


def test_one_shot_advice_does_not_pretend_to_measure_consistency() -> None:
    coaching = generate_coaching([_shot(1)], GOOD_QUALITY)[1]

    consistency = coaching["tips"][2]
    assert "one shot" in consistency["text"].lower()
    assert consistency["evidence"]["value"] == "1 shot"


def test_low_quality_footage_suppresses_confident_angle_advice() -> None:
    quality = {**GOOD_QUALITY, "tier": "limited", "camera_motion": 0.26, "blur_score": 0.18}
    coaching = generate_coaching([_shot(1, entry=51.0, elbow=170.0)], quality)[1]

    assert coaching["limited"] is True
    assert "51" not in " ".join(tip["text"] for tip in coaching["tips"])
    assert coaching["tips"][0]["source_ids"] == ["arc-footage"]
    assert coaching["tips"][1]["source_ids"] == ["arc-footage"]


def test_missing_measurements_still_produce_safe_advice() -> None:
    coaching = generate_coaching(
        [_shot(1, outcome="review", entry=None, speed=None, height=None, elbow=None)],
        GOOD_QUALITY,
    )[1]

    assert len(coaching["tips"]) == 3
    assert coaching["tips"][0]["tone"] == "positive"
    assert coaching["tips"][1]["tone"] == "action"


def test_personalized_release_cue_uses_the_shot_measurements() -> None:
    coaching = generate_coaching(
        [_shot(1, entry=None, speed=6.4, height=2.15, elbow=None)],
        GOOD_QUALITY,
    )[1]

    action = coaching["tips"][1]
    assert "6.4 m/s" in action["text"]
    assert "2.15 m" in action["text"]
    assert action["evidence"]["metric"] == "release_speed_ms"
    assert "Shot 1" in coaching["intro"]


def test_session_advice_names_the_least_consistent_measurement() -> None:
    shots = [
        _shot(1, entry=46.0, speed=7.0, height=2.30, elbow=130.0),
        _shot(2, entry=46.5, speed=7.1, height=2.31, elbow=170.0),
        _shot(3, entry=46.2, speed=7.0, height=2.30, elbow=140.0),
        _shot(4, entry=46.4, speed=7.1, height=2.31, elbow=175.0),
    ]

    coaching = generate_coaching(shots, GOOD_QUALITY)

    assert "elbow extension" in coaching[1]["tips"][2]["text"].lower()
    assert coaching[1]["tips"][2]["evidence"]["value"] == "Most variable"


def test_consistent_session_gets_a_positive_repeatability_note() -> None:
    shots = [
        _shot(1, entry=46.0, speed=7.0, height=2.30, elbow=160.0),
        _shot(2, entry=46.2, speed=7.02, height=2.31, elbow=161.0),
        _shot(3, entry=45.9, speed=7.01, height=2.30, elbow=160.5),
    ]

    coaching = generate_coaching(shots, GOOD_QUALITY)[1]

    assert "steady" in coaching["tips"][2]["text"].lower() or "matching" in coaching["tips"][2]["text"].lower()
    assert coaching["tips"][2]["evidence"]["value"] == "Steady"


def test_readme_has_no_em_dash() -> None:
    readme = Path(__file__).parents[1] / "README.md"

    assert "—" not in readme.read_text(encoding="utf-8")


def test_coaching_generation_does_not_open_a_network_connection() -> None:
    with patch("socket.create_connection", side_effect=AssertionError("network access attempted")):
        coaching = generate_coaching([_shot(1)], GOOD_QUALITY)[1]

    assert len(coaching["tips"]) == 3

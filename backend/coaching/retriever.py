from __future__ import annotations

import hashlib
import json
import math
import re
from collections import Counter
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

import numpy as np

from backend.domain.models import ShotAnalysis


KNOWLEDGE_PATH = Path(__file__).resolve().parent / "knowledge" / "shooting_coach.json"
TOKEN_PATTERN = re.compile(r"[a-z0-9]+")


@dataclass(frozen=True, slots=True)
class KnowledgeNote:
    id: str
    topic: str
    source_id: str
    tags: tuple[str, ...]
    summary: str
    positive: tuple[str, ...]
    action: tuple[str, ...]

    @property
    def document(self) -> str:
        return " ".join((self.topic, *self.tags, self.summary))


class BM25Index:
    def __init__(self, notes: tuple[KnowledgeNote, ...]) -> None:
        self.notes = notes
        self.documents = [Counter(tokenize_text(note.document)) for note in notes]
        self.lengths = [sum(document.values()) for document in self.documents]
        self.average_length = sum(self.lengths) / max(1, len(self.lengths))
        frequencies: Counter[str] = Counter()
        for document in self.documents:
            frequencies.update(document.keys())
        total = max(1, len(notes))
        self.idf = {
            token: math.log(1 + (total - frequency + 0.5) / (frequency + 0.5))
            for token, frequency in frequencies.items()
        }

    def search(self, query: str, topics: set[str] | None = None, limit: int = 8) -> list[KnowledgeNote]:
        query_tokens = tokenize_text(query)
        scored: list[tuple[float, KnowledgeNote]] = []
        for note, document, length in zip(self.notes, self.documents, self.lengths, strict=True):
            if topics is not None and note.topic not in topics:
                continue
            score = 0.0
            for token in query_tokens:
                frequency = document.get(token, 0)
                if not frequency:
                    continue
                denominator = frequency + 1.5 * (0.25 + 0.75 * length / max(1.0, self.average_length))
                score += self.idf.get(token, 0.0) * frequency * 2.5 / denominator
            if note.topic in query_tokens:
                score += 1.25
            if score > 0:
                scored.append((score, note))
        scored.sort(key=lambda item: (-item[0], item[1].id))
        return [note for _, note in scored[:limit]]


def tokenize_text(value: str) -> list[str]:
    return TOKEN_PATTERN.findall(value.lower().replace("_", " "))


@lru_cache(maxsize=1)
def load_coaching_knowledge() -> tuple[dict[str, dict[str, str]], tuple[KnowledgeNote, ...], BM25Index]:
    payload = json.loads(KNOWLEDGE_PATH.read_text())
    sources = {source["id"]: source for source in payload["sources"]}
    notes = tuple(
        KnowledgeNote(
            id=item["id"],
            topic=item["topic"],
            source_id=item["source_id"],
            tags=tuple(item["tags"]),
            summary=item["summary"],
            positive=tuple(item.get("positive", [])),
            action=tuple(item.get("action", [])),
        )
        for item in payload["notes"]
    )
    missing = {note.source_id for note in notes} - sources.keys()
    if missing:
        raise ValueError(f"Coaching notes reference unknown sources: {sorted(missing)}")
    return sources, notes, BM25Index(notes)


def retrieve_notes(query: str, topics: set[str] | None = None, limit: int = 8) -> list[KnowledgeNote]:
    return load_coaching_knowledge()[2].search(query, topics=topics, limit=limit)


def select_stable_phrase(values: tuple[str, ...], shot_id: int, key: str) -> str:
    if not values:
        return ""
    digest = hashlib.sha256(f"{shot_id}:{key}".encode()).digest()
    return values[digest[0] % len(values)]


def find_note_by_topic(notes: list[KnowledgeNote], topic: str) -> KnowledgeNote:
    match = next((note for note in notes if note.topic == topic), None)
    if match is not None:
        return match
    return next(note for note in load_coaching_knowledge()[1] if note.topic == topic)


def build_source_reference(source_id: str) -> dict[str, str]:
    source = load_coaching_knowledge()[0][source_id]
    return {
        "id": source["id"],
        "title": source["title"],
        "publisher": source["publisher"],
        "url": source["url"],
    }


def build_coaching_tip(
    tip_id: str,
    tone: str,
    text: str,
    note: KnowledgeNote,
    evidence: dict[str, str] | None,
    source_ids: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "id": tip_id,
        "tone": tone,
        "text": clean_coaching_text(text),
        "evidence": evidence,
        "source_ids": list(dict.fromkeys(source_ids or [note.source_id])),
    }


def clean_coaching_text(text: str) -> str:
    """Keep the compact Coach Notes style consistent across old and new tips."""
    return re.sub(r"[.!]+$", "", text.replace("—", "-").strip())


def make_coaching_tips_unique(tips: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Prevent a repeated phrase from taking two of the three coaching slots."""
    fallbacks = {
        "positive": "Keep this release shape on the next rep",
        "action": "Use five close shots and hold the finish",
        "consistency": "Add a few more reps before judging the pattern",
    }
    seen: set[str] = set()
    output: list[dict[str, Any]] = []
    for tip in tips:
        cleaned = clean_coaching_text(str(tip.get("text", "")))
        key = cleaned.casefold()
        if key in seen:
            replacement = fallbacks.get(str(tip.get("tone", "action")), "Repeat the motion slowly")
            suffix = 2
            while replacement.casefold() in seen:
                replacement = f"{fallbacks.get(str(tip.get('tone', 'action')), 'Repeat the motion slowly')} {suffix}"
                suffix += 1
            cleaned = replacement
            key = cleaned.casefold()
        seen.add(key)
        output.append({**tip, "text": cleaned})
    return output


def format_angle(value: float) -> str:
    return f"{value:.1f}°"


def determine_measurement_reliability(
    shot: ShotAnalysis, quality: dict[str, Any]
) -> tuple[bool, bool, bool]:
    tier = quality.get("tier", "limited")
    camera_motion = float(quality.get("camera_motion", 0.0))
    blur_score = float(quality.get("blur_score", 1.0))
    steady_enough = camera_motion <= 0.18 and blur_score >= 0.22 and tier != "insufficient"
    trajectory = bool(
        steady_enough
        and shot.confidence >= 0.62
        and float(shot.evidence.get("rim_track_confidence", 0.0)) >= 0.62
    )
    pose = bool(
        steady_enough
        and float(shot.evidence.get("pose_confidence", 0.0)) >= 0.60
        and float(quality.get("pose_coverage", 0.0)) >= 0.35
    )
    limited = tier != "good" or not trajectory or not pose
    return trajectory, pose, limited


def collect_reliable_metric_values(
    shots: list[ShotAnalysis], quality: dict[str, Any], metric: str
) -> list[float]:
    values: list[float] = []
    for shot in shots:
        trajectory, pose, _ = determine_measurement_reliability(shot, quality)
        value: float | None
        if metric == "entry angle":
            value = shot.entry_angle_deg if trajectory else None
        elif metric == "release speed":
            value = shot.release_speed_ms if trajectory else None
        elif metric == "release height":
            value = shot.release_height_m if trajectory else None
        elif metric in {"elbow extension", "knee angle", "shoulder angle", "hip angle"}:
            form_metric = {
                "elbow extension": "elbow",
                "knee angle": "knee",
                "shoulder angle": "shoulder",
                "hip angle": "hip",
            }[metric]
            value = shot.form.get(form_metric) if pose else None
        else:
            value = None
        if value is not None:
            values.append(float(value))
    return values


def find_least_consistent_metric(
    shots: list[ShotAnalysis], quality: dict[str, Any]
) -> tuple[str | None, float]:
    tolerances = {
        "entry angle": 3.0,
        "release speed": 0.06,
        "release height": 0.12,
        "elbow extension": 8.0,
        "knee angle": 10.0,
        "shoulder angle": 10.0,
        "hip angle": 10.0,
    }
    ranked: list[tuple[float, str]] = []
    for metric, tolerance in tolerances.items():
        values = collect_reliable_metric_values(shots, quality, metric)
        if len(values) < 3:
            continue
        median = float(np.median(values))
        spread = float(np.median(np.abs(np.asarray(values) - median)))
        if metric == "release speed":
            spread = spread / max(abs(median), 1e-6)
        ranked.append((spread / tolerance, metric))
    if not ranked:
        return None, 0.0
    score, metric = max(ranked, key=lambda item: (item[0], item[1]))
    return metric, score


def build_retrieval_query(shot: ShotAnalysis, quality: dict[str, Any], attempts: int) -> str:
    parts = [
        "basketball shooting coaching",
        shot.outcome,
        str(quality.get("tier", "limited")),
        "entry angle arc trajectory lift" if shot.entry_angle_deg is not None else "",
        "elbow knee shoulder hip body position leg drive follow through finish"
        if any(value is not None for value in shot.form.values())
        else "",
        "release consistency speed height variation repeat",
        "sample attempts" if attempts < 3 else "repeated attempts consistency",
        "camera blur footage" if quality.get("tier") != "good" else "",
    ]
    return " ".join(part for part in parts if part)


# Broad wording cues only. They are not universal "perfect" targets because
# camera angle, player build, and shooting distance all change the view.
BODY_WINDOWS = {
    "elbow": (155.0, 180.0),
    "knee": (135.0, 175.0),
    "shoulder": (85.0, 150.0),
    "hip": (140.0, 180.0),
}


def form_metric_value(shot: ShotAnalysis, metric: str, pose: bool) -> float | None:
    if not pose:
        return None
    value = shot.form.get(metric)
    return float(value) if value is not None else None


def body_metric_evidence(metric: str, value: float) -> dict[str, str]:
    labels = {
        "elbow": "Elbow extension",
        "knee": "Knee angle",
        "shoulder": "Shoulder angle",
        "hip": "Hip angle",
    }
    return {
        "metric": f"form.{metric}",
        "label": labels[metric],
        "value": format_angle(value),
    }


def body_metric_deviation(metric: str, value: float) -> float:
    ideal_min, ideal_max = BODY_WINDOWS[metric]
    return max(ideal_min - value, value - ideal_max, 0.0) / max(1.0, ideal_max - ideal_min)


def build_positive_form_tip(
    shot: ShotAnalysis,
    pose: bool,
    body_note: KnowledgeNote,
    joint_note: KnowledgeNote,
) -> tuple[str, dict[str, str] | None, list[str]] | None:
    metrics = {
        metric: form_metric_value(shot, metric, pose)
        for metric in BODY_WINDOWS
    }
    elbow = metrics["elbow"]
    knee = metrics["knee"]
    if elbow is not None and BODY_WINDOWS["elbow"][0] <= elbow <= BODY_WINDOWS["elbow"][1]:
        if knee is not None and BODY_WINDOWS["knee"][0] <= knee <= BODY_WINDOWS["knee"][1]:
            text = f"Your elbow finished at {format_angle(elbow)} and knee at {format_angle(knee)}. Keep that rhythm and hold the follow-through."
            evidence = body_metric_evidence("elbow", elbow)
        else:
            text = f"Your shooting elbow reached {format_angle(elbow)}. Keep the arm long and hold the wrist toward the rim."
            evidence = body_metric_evidence("elbow", elbow)
        return text, evidence, [body_note.source_id, joint_note.source_id]
    for metric, value in metrics.items():
        if value is None:
            continue
        ideal_min, ideal_max = BODY_WINDOWS[metric]
        if ideal_min <= value <= ideal_max:
            labels = {
                "knee": "Your knee dip",
                "shoulder": "Your shoulder line",
                "hip": "Your hip position",
            }
            label = labels.get(metric, "Your body position")
            text = f"{label} measured {format_angle(value)}. Keep that shape as the ball leaves your hand."
            return text, body_metric_evidence(metric, value), [body_note.source_id, joint_note.source_id]
    return None


def build_body_action_tip(
    shot: ShotAnalysis,
    pose: bool,
    body_note: KnowledgeNote,
    joint_note: KnowledgeNote,
) -> tuple[str, dict[str, str], list[str]] | None:
    candidates: list[tuple[float, str, str, list[str]]] = []
    for metric in BODY_WINDOWS:
        value = form_metric_value(shot, metric, pose)
        if value is None:
            continue
        severity = body_metric_deviation(metric, value)
        # Ignore tiny differences that are more likely camera or rounding noise
        # than a useful practice cue.
        if severity <= 0.08:
            continue
        if metric == "elbow" and value < 150:
            text = f"Your elbow finished at {format_angle(value)}. On five close shots, extend through the ball and freeze the wrist."
        elif metric == "elbow" and value > 185:
            text = f"Your elbow reached {format_angle(value)}. Keep the finish relaxed instead of forcing extra extension."
        elif metric == "elbow":
            text = f"Your elbow reached {format_angle(value)}. Keep the finish natural and hold the wrist toward the rim."
        elif metric == "knee" and value < 125:
            text = f"Your knee stayed at {format_angle(value)}. Drive up through the legs so the arm does not push."
        elif metric == "knee":
            text = f"Your knee was {format_angle(value)}. Add a small repeatable dip, then let the legs finish before the arm."
        elif metric == "hip" and value < 130:
            text = f"Your hip angle was {format_angle(value)}. Rise tall from the hips and keep your chest over your base."
        elif metric == "hip":
            text = f"Your hip angle was {format_angle(value)}. Stay stacked instead of leaning away as you lift."
        elif metric == "shoulder" and value < 80:
            text = f"Your shoulder angle was {format_angle(value)}. Relax that shoulder and lift the elbow on one line."
        else:
            text = f"Your shoulder angle was {format_angle(value)}. Keep the elbow under the ball instead of drifting wide."
        candidates.append((severity, metric, text, [body_note.source_id, joint_note.source_id]))
    if not candidates:
        return None
    _, metric, text, source_ids = max(candidates, key=lambda item: (item[0], item[1]))
    value = form_metric_value(shot, metric, pose)
    assert value is not None
    return text, body_metric_evidence(metric, value), source_ids


def format_metric_value(metric: str, value: float) -> str:
    if metric == "release speed":
        return f"{value:.1f} m/s"
    if metric == "release height":
        return f"{value:.2f} m"
    if metric == "entry angle":
        return format_angle(value)
    return format_angle(value)


def consistency_range_text(metric: str, values: list[float]) -> str:
    low = format_metric_value(metric, min(values))
    high = format_metric_value(metric, max(values))
    return f"{metric.title()} ranged from {low} to {high}."


def generate_coaching(shots: list[ShotAnalysis], quality: dict[str, Any]) -> dict[int, dict[str, Any]]:
    coaching: dict[int, dict[str, Any]] = {}
    attempts = len(shots)
    for shot in shots:
        trajectory, pose, limited = determine_measurement_reliability(shot, quality)
        ranked = retrieve_notes(build_retrieval_query(shot, quality, attempts), limit=12)
        entry_note = find_note_by_topic(ranked, "entry_angle")
        elbow_note = find_note_by_topic(ranked, "elbow")
        rhythm_note = find_note_by_topic(ranked, "rhythm")
        consistency_note = find_note_by_topic(ranked, "consistency")
        sample_note = find_note_by_topic(ranked, "sample_size")
        footage_note = find_note_by_topic(ranked, "footage")
        body_note = find_note_by_topic(ranked, "body_chain")
        joint_note = find_note_by_topic(ranked, "joint_angles")
        distance_note = find_note_by_topic(ranked, "distance_adjustment")

        tips: list[dict[str, Any]] = []
        if limited:
            text = select_stable_phrase(footage_note.positive, shot.id, "positive-footage")
            tips.append(build_coaching_tip("positive-footage", "positive", text, footage_note, None))
        else:
            positive_form = build_positive_form_tip(shot, pose, body_note, joint_note)
            if positive_form is not None:
                text, evidence, source_ids = positive_form
                tips.append(
                    build_coaching_tip(
                        "positive-form",
                        "positive",
                        text,
                        body_note,
                        evidence,
                        source_ids,
                    )
                )
            elif trajectory and shot.entry_angle_deg is not None:
                value = format_angle(shot.entry_angle_deg)
                if shot.release_height_m is not None:
                    height = f"{shot.release_height_m:.2f} m"
                    text = f"Entry angle was {value}; release height was {height}. Repeat that takeoff."
                    evidence = {
                        "metric": "entry_angle_deg",
                        "label": "Entry angle",
                        "value": value,
                    }
                else:
                    text = f"Entry angle was {value}. Repeat that lift before adding distance."
                    evidence = {
                        "metric": "entry_angle_deg",
                        "label": "Entry angle",
                        "value": value,
                    }
                tips.append(
                    build_coaching_tip(
                        "positive-trajectory",
                        "positive",
                        text,
                        entry_note,
                        evidence,
                        [entry_note.source_id, distance_note.source_id],
                    )
                )
            elif trajectory and shot.release_height_m is not None:
                height = f"{shot.release_height_m:.2f} m"
                text = f"Release height was {height}. Keep that takeoff shape through the follow-through."
                tips.append(
                    build_coaching_tip(
                        "positive-release-height",
                        "positive",
                        text,
                        distance_note,
                        {"metric": "release_height_m", "label": "Release height", "value": height},
                        [distance_note.source_id, body_note.source_id],
                    )
                )
            elif pose:
                text = select_stable_phrase(rhythm_note.positive, shot.id, "positive-rhythm")
                tips.append(build_coaching_tip("positive-rhythm", "positive", text, rhythm_note, None))
            else:
                text = select_stable_phrase(footage_note.positive, shot.id, "positive-footage")
                tips.append(build_coaching_tip("positive-footage", "positive", text, footage_note, None))

        if limited:
            text = select_stable_phrase(footage_note.action, shot.id, "action-footage")
            tips.append(build_coaching_tip("action-footage", "action", text, footage_note, None))
        else:
            body_action = build_body_action_tip(shot, pose, body_note, joint_note)
            if body_action is not None:
                text, evidence, source_ids = body_action
                tips.append(
                    build_coaching_tip(
                        "action-body-position",
                        "action",
                        text,
                        body_note,
                        evidence,
                        source_ids,
                    )
                )
            elif trajectory and shot.entry_angle_deg is not None:
                value = float(shot.entry_angle_deg)
                angle = format_angle(value)
                if value < 43:
                    text = f"Entry angle was {angle}. Add lift from the legs, not a harder arm push."
                elif value > 58:
                    text = f"Entry angle was {angle}. Keep the arc, but repeat the same knee dip."
                else:
                    text = f"Entry angle was {angle}. Match that lift for five close shots before stepping back."
                tips.append(
                    build_coaching_tip(
                        "action-entry-angle",
                        "action",
                        text,
                        entry_note,
                        {"metric": "entry_angle_deg", "label": "Entry angle", "value": angle},
                        [entry_note.source_id, distance_note.source_id],
                    )
                )
            elif trajectory and (shot.release_speed_ms is not None or shot.release_height_m is not None):
                speed = f"{shot.release_speed_ms:.1f} m/s" if shot.release_speed_ms is not None else "a repeatable speed"
                height = f" from {shot.release_height_m:.2f} m" if shot.release_height_m is not None else ""
                text = f"Your release was {speed}{height}. Repeat five easy reps and keep that lift the same."
                evidence = None
                if shot.release_speed_ms is not None:
                    evidence = {"metric": "release_speed_ms", "label": "Release speed", "value": speed}
                elif shot.release_height_m is not None:
                    evidence = {"metric": "release_height_m", "label": "Release height", "value": f"{shot.release_height_m:.2f} m"}
                tips.append(
                    build_coaching_tip(
                        "action-release-profile",
                        "action",
                        text,
                        consistency_note,
                        evidence,
                        [consistency_note.source_id, distance_note.source_id],
                    )
                )
            else:
                text = select_stable_phrase(rhythm_note.action, shot.id, "action-rhythm")
                tips.append(build_coaching_tip("action-rhythm", "action", text, rhythm_note, None))

        if attempts == 1:
            text = select_stable_phrase(sample_note.action, shot.id, "consistency-one")
            tips.append(
                build_coaching_tip(
                    "consistency-one",
                    "consistency",
                    text,
                    sample_note,
                    {"metric": "session.attempts", "label": "Analyzed shots", "value": "1 shot"},
                )
            )
        elif attempts == 2:
            text = "Two shots are a start, but that is still too small to call a pattern. Add a few more reps."
            tips.append(
                build_coaching_tip(
                    "consistency-two",
                    "consistency",
                    text,
                    sample_note,
                    {"metric": "session.attempts", "label": "Analyzed shots", "value": "2 shots"},
                )
            )
        else:
            metric, variability = find_least_consistent_metric(shots, quality)
            values = collect_reliable_metric_values(shots, quality, metric) if metric is not None else []
            if metric is None or not values:
                text = "A few measurements are missing, so the consistency call is still fuzzy. Keep the next reps from one spot."
                evidence = {"metric": "session.attempts", "label": "Analyzed shots", "value": f"{attempts} shots"}
            elif variability < 0.85:
                text = f"{metric.title()} stayed fairly steady. Keep the same dip and follow-through for five more reps."
                evidence = {
                    "metric": metric.replace(" ", "_"),
                    "label": metric.title(),
                    "value": consistency_range_text(metric, values),
                }
            else:
                text = f"{consistency_range_text(metric, values)} Do five same-spot reps and freeze that finish."
                evidence = {
                    "metric": metric.replace(" ", "_"),
                    "label": metric.title(),
                    "value": consistency_range_text(metric, values),
                }
            tips.append(
                build_coaching_tip(
                    "consistency-session",
                    "consistency",
                    text,
                    consistency_note,
                    evidence,
                    [consistency_note.source_id, joint_note.source_id],
                )
            )

        tips = make_coaching_tips_unique(tips[:3])
        source_ids = list(dict.fromkeys(source_id for tip in tips for source_id in tip["source_ids"]))
        sources = [build_source_reference(source_id) for source_id in source_ids]
        coaching[shot.id] = {
            "intro": f"Here’s what stood out on Shot {shot.id}",
            "limited": limited,
            "matched_source_count": len(sources),
            "tips": tips,
            "sources": sources,
        }
    return coaching


def attach_coaching(shots: list[ShotAnalysis], quality: dict[str, Any]) -> None:
    coaching = generate_coaching(shots, quality)
    for shot in shots:
        shot.coaching = coaching.get(shot.id)

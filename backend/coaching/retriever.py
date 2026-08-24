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
) -> dict[str, Any]:
    return {
        "id": tip_id,
        "tone": tone,
        "text": text.replace("—", "-"),
        "evidence": evidence,
        "source_ids": [note.source_id],
    }


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
        else:
            value = shot.form.get("elbow") if pose else None
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
        "elbow extension follow through finish" if shot.form.get("elbow") is not None else "",
        "release consistency speed height variation repeat",
        "sample attempts" if attempts < 3 else "repeated attempts consistency",
        "camera blur footage" if quality.get("tier") != "good" else "",
    ]
    return " ".join(part for part in parts if part)


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

        tips: list[dict[str, Any]] = []
        if limited:
            text = select_stable_phrase(footage_note.positive, shot.id, "positive-footage")
            tips.append(build_coaching_tip("positive-footage", "positive", text, footage_note, None))
        elif trajectory and shot.entry_angle_deg is not None and shot.outcome == "make":
            value = format_angle(shot.entry_angle_deg)
            text = select_stable_phrase(entry_note.positive, shot.id, "positive-entry").format(value=value)
            if shot.release_height_m is not None:
                height = f"{shot.release_height_m:.2f} m"
                text = f"{text.rstrip('.')} Release height was {height}; repeat that same takeoff."
            tips.append(
                build_coaching_tip(
                    "positive-entry",
                    "positive",
                    text,
                    entry_note,
                    {"metric": "entry_angle_deg", "label": "Entry angle", "value": value},
                )
            )
        elif pose and shot.form.get("elbow") is not None and float(shot.form["elbow"]) >= 155:
            value = format_angle(float(shot.form["elbow"]))
            text = select_stable_phrase(elbow_note.positive, shot.id, "positive-elbow").format(value=value)
            tips.append(
                build_coaching_tip(
                    "positive-elbow",
                    "positive",
                    text,
                    elbow_note,
                    {"metric": "form.elbow", "label": "Elbow extension", "value": value},
                )
            )
        else:
            text = select_stable_phrase(rhythm_note.positive, shot.id, "positive-rhythm")
            tips.append(build_coaching_tip("positive-rhythm", "positive", text, rhythm_note, None))

        if limited:
            text = select_stable_phrase(footage_note.action, shot.id, "action-footage")
            tips.append(build_coaching_tip("action-footage", "action", text, footage_note, None))
        elif pose and shot.form.get("elbow") is not None:
            elbow = float(shot.form["elbow"])
            value = format_angle(elbow)
            templates = elbow_note.action if elbow < 150 else elbow_note.positive
            text = select_stable_phrase(templates, shot.id, "action-elbow").format(value=value)
            tips.append(
                build_coaching_tip(
                    "action-elbow",
                    "action",
                    text,
                    elbow_note,
                    {"metric": "form.elbow", "label": "Elbow extension", "value": value},
                )
            )
        elif trajectory and shot.entry_angle_deg is not None:
            value = format_angle(shot.entry_angle_deg)
            text = select_stable_phrase(entry_note.action, shot.id, "action-entry").format(value=value)
            tips.append(
                build_coaching_tip(
                    "action-entry",
                    "action",
                    text,
                    entry_note,
                    {"metric": "entry_angle_deg", "label": "Entry angle", "value": value},
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
            tips.append(build_coaching_tip("action-release-profile", "action", text, consistency_note, evidence))
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
            if metric is None:
                text = "A few measurements are missing, so the consistency call is still fuzzy. Keep the next reps from one spot."
                evidence = {"metric": "session.attempts", "label": "Analyzed shots", "value": f"{attempts} shots"}
            elif variability < 0.85:
                text = select_stable_phrase(consistency_note.positive, shot.id, "consistency-steady")
                evidence = {"metric": metric.replace(" ", "_"), "label": metric.title(), "value": "Steady"}
            else:
                text = select_stable_phrase(
                    consistency_note.action, shot.id, "consistency-variable"
                ).format(metric=metric)
                evidence = {"metric": metric.replace(" ", "_"), "label": metric.title(), "value": "Most variable"}
            tips.append(
                build_coaching_tip(
                    "consistency-session", "consistency", text, consistency_note, evidence
                )
            )

        tips = tips[:3]
        source_ids = list(dict.fromkeys(source_id for tip in tips for source_id in tip["source_ids"]))
        sources = [build_source_reference(source_id) for source_id in source_ids]
        coaching[shot.id] = {
            "intro": f"Here’s what stood out on Shot {shot.id}.",
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

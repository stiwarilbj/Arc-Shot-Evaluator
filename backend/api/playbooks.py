"""Local persistence routes for ARCade Hoops's lightweight basketball playbook editor."""

from __future__ import annotations

import errno
import hashlib
import json
import math
import os
import re
import tempfile
import time
import uuid
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response

from backend.config import PLAYBOOKS_DIR


router = APIRouter(prefix="/api/playbooks", tags=["playbooks"])
PLAYBOOK_ID = re.compile(r"^[a-z0-9][a-z0-9-]{7,63}$")
MAX_NAME_LENGTH = 80
# Match ECMAScript String.trim, including BOM and excluding control separators.
NAME_WHITESPACE = " \t\n\r\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
MAX_PLAYERS = 5
MAX_DEFENDERS = 5
MAX_ARROWS = 30
MAX_BRANCHES = 8
MAX_READ_CHECKPOINTS = 8
MAX_ROLE_CUES = 600
MAX_SPACING_GATES = 30
MAX_FLIPBOOK_STORIES = 9
MAX_FLIPBOOK_PANELS = 12
MAX_FLIPBOOK_MARKS = 30
MAX_FLIPBOOK_STEPS = 8
MAX_BAIT_PAYOFFS = 30
MAX_DOCUMENT_BYTES = 256 * 1024
MAX_SAVED_FILE_BYTES = 1024 * 1024  # Includes private idempotency receipts.
MAX_JSON_DEPTH = 32
HISTORY_LIMIT = 8
HISTORY_ERROR = "Saved-play history failed its integrity check · Stored records have been preserved; use explicit recovery to copy a verified revision"
SAVE_CONFLICT = "This play was changed by another tab or client · Your draft is still in memory · Save a copy or reopen the latest saved play before updating it"
# Version-1 save precision; Python round uses binary float, nearest/ties-to-even.
COORDINATE_DECIMAL_PLACES = 4
TIMING_DECIMAL_PLACES = 2
PLAYBOOK_LOCK_TIMEOUT_SECONDS = 2.0
PLAYBOOK_LOCK_POLL_SECONDS = 0.025
ALLOWED_ARROW_KINDS = {"movement", "pass", "screen", "slip-screen", "handoff", "pick-roll", "pick-pop", "off-ball-screen", "pin-down", "backdoor-cut"}
ALLOWED_ARROW_PATHS = {"straight", "curve"}
ALLOWED_DEFENSE_SCHEMES = {"auto", "man-to-man", "pack-line", "zone-2-3", "zone-3-2", "zone-1-3-1", "zone-2-1-2", "zone-1-2-2", "matchup-1-1-3", "box-and-one", "triangle-and-two"}
ALLOWED_DEFENSE_STRATEGIES = {"off", "contain", "help", "switch", "trap-rotate", "fight-over", "go-under", "drop", "hedge", "deny-lanes", "protect-paint"}
ALLOWED_OFFBALL_STYLES = {"off", "spacing", "cuts", "read-react"}
ALLOWED_PLAYER_BADGES = {
    "playmaker", "off-dribble-creator", "deep-range", "catch-and-shoot", "slasher",
    "rim-finisher", "cutter", "screen-setter", "roll-threat", "post-scorer",
}
ALLOWED_DEFENDER_BADGES = {"lockdown", "paint-protector", "helper"}
TIMING_EVENTS = {"start", "complete", "catch", "screen-set", "screen-use", "route-point"}
TIMING_PHASES = {"main", "approach", "use", "release"}
ROLE_CUE_PHASES = {"hold", "perform", "receive", "screen", "screen-use", "roll", "pop", "cut", "pass", "handoff", "move", "wait"}
SPACING_EVENTS = {"start", "complete", "catch", "screen-set", "screen-use", "route-point"}


def _validate_timing_path(arrows: list[dict]) -> None:
    timed = ["timingPlan" in arrow for arrow in arrows]
    if any(timed) and not all(timed):
        raise HTTPException(400, "Timing must be initialized for every action in this play path")
    if not any(timed):
        return
    by_id = {arrow["id"]: arrow for arrow in arrows}
    graph: dict[str, list[str]] = {arrow["id"]: [] for arrow in arrows}
    sync: dict[str, list[dict]] = {}
    for arrow in arrows:
        plan = arrow["timingPlan"]
        if plan.get("syncId"):
            sync.setdefault(plan["syncId"], []).append(arrow)
        for wait in plan.get("waits", []):
            source = by_id.get(wait["actionId"])
            if source is None:
                raise HTTPException(400, "Timing wait points outside this play ending")
            if wait["event"] == "catch" and source["kind"] not in {"pass", "handoff"}:
                raise HTTPException(400, "Catch waits require a pass or handoff")
            screen_kinds = {"screen", "slip-screen", "pick-roll", "pick-pop", "off-ball-screen", "pin-down"}
            if wait["event"] in {"screen-set", "screen-use"} and source["kind"] not in screen_kinds:
                raise HTTPException(400, "Screen waits require an action that uses a screen")
            graph[arrow["id"]].append(source["id"])
    state: dict[str, int] = {}

    def visit(action_id: str) -> None:
        if state.get(action_id) == 1:
            raise HTTPException(400, "Timing waits cannot form a cycle")
        if state.get(action_id) == 2:
            return
        state[action_id] = 1
        for dependency in graph[action_id]:
            visit(dependency)
        state[action_id] = 2

    for action_id in graph:
        visit(action_id)
    sync_id_by_action = {
        arrow["id"]: arrow["timingPlan"].get("syncId")
        for arrow in arrows
        if arrow["timingPlan"].get("syncId")
    }

    def timing_node(action_id: str) -> str:
        return f"sync:{sync_id_by_action[action_id]}" if action_id in sync_id_by_action else f"action:{action_id}"

    event_graph: dict[str, list[str]] = {}
    for arrow in arrows:
        event_graph.setdefault(timing_node(arrow["id"]), [])
    for arrow in arrows:
        source_node = timing_node(arrow["id"])
        for dependency in graph[arrow["id"]]:
            target_node = timing_node(dependency)
            if source_node == target_node:
                raise HTTPException(400, "Pinned actions cannot wait on one another")
            event_graph[source_node].append(target_node)
    event_state: dict[str, int] = {}

    def visit_event(node: str) -> None:
        if event_state.get(node) == 1:
            raise HTTPException(400, "Timing waits cannot form a cycle through synchronized actions")
        if event_state.get(node) == 2:
            return
        event_state[node] = 1
        for dependency in event_graph[node]:
            visit_event(dependency)
        event_state[node] = 2

    for node in event_graph:
        visit_event(node)
    for members in sync.values():
        if len({arrow["timingPlan"]["startAtMs"] for arrow in members}) != 1:
            raise HTTPException(400, "Pinned actions must share one planned start time")
        ids = {arrow["id"] for arrow in members}
        owners: set[int] = set()
        transfers = 0
        for arrow in members:
            if arrow["kind"] in {"pass", "handoff"}:
                transfers += 1
            kind = arrow["kind"]
            if kind in {"off-ball-screen", "pin-down"}:
                participants = (arrow.get("screener_id"), arrow.get("cutter_id"))
            elif kind in {"screen", "slip-screen", "pick-roll", "pick-pop"}:
                participants = (arrow.get("screener_id"), arrow.get("handler_id"))
            elif kind in {"movement", "backdoor-cut"}:
                participants = (arrow.get("actor_id"),)
            elif kind == "handoff":
                participants = (arrow.get("actor_id"), arrow.get("recipient_id"))
            elif kind == "pass":
                # A receiver follows the pass preparation route from its start
                # until the catch, so that route owns the receiver during a pin
                participants = (arrow.get("recipient_id"),)
            else:
                participants = ()
            for participant in participants:
                if participant is not None:
                    if participant in owners:
                        raise HTTPException(400, "Pinned actions cannot claim the same movement owner")
                    owners.add(participant)
            if any(dependency in ids for dependency in graph[arrow["id"]]):
                raise HTTPException(400, "Pinned actions cannot wait on one another")
        if transfers > 1:
            raise HTTPException(400, "A pinned group cannot start competing ball transfers")


def _extension_set(value: str | None) -> set[str]:
    return {item.strip() for item in (value or "").split(",") if item.strip()}


def _has_timing(value: dict) -> bool:
    arrows = list(value.get("arrows") or [])
    arrows.extend(arrow for branch in (value.get("branches") or []) for arrow in (branch.get("continuation") or []))
    return any("timingPlan" in arrow for arrow in arrows)


def _has_read_coach(value: dict) -> bool:
    lesson = value.get("readCoach")
    return isinstance(lesson, dict) and bool(lesson.get("checkpoints"))


def _has_role_cues(value: dict) -> bool:
    lesson = value.get("roleCues")
    return isinstance(lesson, dict) and bool(lesson.get("cues"))


def _has_spacing_gates(value: dict) -> bool:
    lesson = value.get("spacingGates")
    return isinstance(lesson, dict) and isinstance(lesson.get("gates"), list)


def _has_flipbooks(value: dict) -> bool:
    lesson = value.get("flipbooks")
    return isinstance(lesson, dict) and isinstance(lesson.get("stories"), list)


def _has_bait_payoffs(value: dict) -> bool:
    # Presence, including an empty list, proves the client understands this
    # extension and prevents an older writer from silently stripping it
    return "baitPayoffs" in value


def _has_chalk_talk(value: dict) -> bool:
    lesson = value.get("flipbooks")
    if not isinstance(lesson, dict) or not isinstance(lesson.get("stories"), list):
        return False
    return any(isinstance(story, dict) and isinstance(story.get("panels"), list)
        and any(isinstance(panel, dict) and "chalkTalk" in panel for panel in story["panels"])
        for story in lesson["stories"])


def _bait_payoffs(value: object, players: list[dict], defenders: list[dict], arrows: list[dict], branches: list[dict]) -> dict:
    if not isinstance(value, dict) or set(value) != {"version", "connections"} or value.get("version") != 1:
        raise HTTPException(400, "Bait & Payoff data is invalid")
    connections = value.get("connections")
    if not isinstance(connections, list) or len(connections) > MAX_BAIT_PAYOFFS:
        raise HTTPException(400, f"A play can contain at most {MAX_BAIT_PAYOFFS} Bait & Payoff connections")
    main_by_id = {arrow["id"]: arrow for arrow in arrows}
    branch_by_id = {branch["id"]: branch for branch in branches}
    paths = _resolved_action_paths({"arrows": arrows, "branches": branches})
    player_ids = {marker["id"] for marker in players}
    defender_ids = {marker["id"] for marker in defenders} or set(player_ids)
    seen: set[str] = set()
    clean: list[dict] = []
    event_names = {"start", "complete", "catch", "screen-set", "screen-use", "route-point"}
    screen_set_kinds = {"screen", "pick-roll", "pick-pop", "off-ball-screen", "pin-down"}
    screen_use_kinds = screen_set_kinds | {"slip-screen", "handoff"}
    for item in connections:
        allowed = {"id", "baitActionId", "payoffActionId", "title", "explanation", "scope", "branchId", "baitSignature", "payoffSignature", "reaction"}
        if not isinstance(item, dict) or set(item) - allowed:
            raise HTTPException(400, "Bait & Payoff connection fields are invalid")
        connection_id = item.get("id")
        bait_id, payoff_id = item.get("baitActionId"), item.get("payoffActionId")
        if not isinstance(connection_id, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", connection_id) or connection_id in seen:
            raise HTTPException(400, "Bait & Payoff identities must be unique short labels")
        seen.add(connection_id)
        if not isinstance(bait_id, str) or not re.fullmatch(r"[a-z0-9-]{1,64}", bait_id) or not isinstance(payoff_id, str) or not re.fullmatch(r"[a-z0-9-]{1,64}", payoff_id) or bait_id == payoff_id:
            raise HTTPException(400, "Bait and payoff must reference distinct stable action identities")
        title, explanation = item.get("title"), item.get("explanation")
        if not isinstance(title, str) or not title.strip(NAME_WHITESPACE) or len(title) > 60:
            raise HTTPException(400, "Bait & Payoff title must contain 1-60 characters")
        if not isinstance(explanation, str) or not explanation.strip(NAME_WHITESPACE) or len(explanation) > 1000:
            raise HTTPException(400, "Bait & Payoff explanation must contain 1-1000 characters")
        scope, branch_id = item.get("scope"), item.get("branchId")
        if scope not in {"shared", "ending"}:
            raise HTTPException(400, "Bait & Payoff scope is invalid")
        if scope == "shared":
            if branch_id is not None:
                raise HTTPException(400, "Shared Bait & Payoff connections cannot name an ending")
            path_actions = main_by_id
        else:
            if not isinstance(branch_id, str) or branch_id not in branch_by_id:
                raise HTTPException(400, "Ending Bait & Payoff connection must reference an existing ending")
            path_actions = {arrow["id"]: arrow for arrow in paths[branch_id]}
        bait, payoff = path_actions.get(bait_id), path_actions.get(payoff_id)
        if bait is None or payoff is None:
            raise HTTPException(400, "Bait & Payoff actions must remain in the selected path")
        bait_signature, payoff_signature = item.get("baitSignature"), item.get("payoffSignature")
        if not isinstance(bait_signature, str) or not re.fullmatch(r"[0-9a-f]{8}", bait_signature) or not isinstance(payoff_signature, str) or not re.fullmatch(r"[0-9a-f]{8}", payoff_signature):
            raise HTTPException(400, "Bait & Payoff action review signatures are invalid")
        clean_item = {"id": connection_id, "baitActionId": bait_id, "payoffActionId": payoff_id,
            "title": title.strip(NAME_WHITESPACE), "explanation": explanation.strip(NAME_WHITESPACE), "scope": scope,
            "baitSignature": bait_signature, "payoffSignature": payoff_signature}
        if branch_id is not None:
            clean_item["branchId"] = branch_id
        reaction = item.get("reaction")
        if reaction is not None:
            if not isinstance(reaction, dict) or set(reaction) != {"defenderId", "area", "direction", "checkpoint"}:
                raise HTTPException(400, "Defender reaction check fields are invalid")
            defender_id = reaction.get("defenderId")
            if not _integer(defender_id) or defender_id not in defender_ids:
                raise HTTPException(400, "Reaction check must reference a defender on this court")
            direction = reaction.get("direction")
            if direction not in {"enter", "leave"}:
                raise HTTPException(400, "Reaction direction must be enter or leave")
            area = reaction.get("area")
            if not isinstance(area, dict) or set(area) - {"shape", "center", "radiusFeet", "widthFeet", "heightFeet"}:
                raise HTTPException(400, "Reaction area is invalid")
            center = _point(area.get("center"), "Reaction area center")
            if area.get("shape") == "circle":
                radius = area.get("radiusFeet")
                if not isinstance(radius, (int, float)) or isinstance(radius, bool) or not math.isfinite(radius) or not 0.5 <= radius <= 25 or "widthFeet" in area or "heightFeet" in area:
                    raise HTTPException(400, "Reaction radius must be 0.5-25 feet")
                if min(center["x"] * .5, (100 - center["x"]) * .5, center["y"] * .47, (100 - center["y"]) * .47) < radius - 1e-6:
                    raise HTTPException(400, "Reaction area must stay within the playable court")
                clean_area = {"shape": "circle", "center": center, "radiusFeet": round(float(radius), 2)}
            elif area.get("shape") == "rectangle":
                width, height = area.get("widthFeet"), area.get("heightFeet")
                if not isinstance(width, (int, float)) or isinstance(width, bool) or not math.isfinite(width) or not 1 <= width <= 50 or not isinstance(height, (int, float)) or isinstance(height, bool) or not math.isfinite(height) or not 1 <= height <= 47 or "radiusFeet" in area:
                    raise HTTPException(400, "Reaction rectangle dimensions are invalid")
                if min(center["x"] * .5, (100 - center["x"]) * .5) < width / 2 - 1e-6 or min(center["y"] * .47, (100 - center["y"]) * .47) < height / 2 - 1e-6:
                    raise HTTPException(400, "Reaction area must stay within the playable court")
                clean_area = {"shape": "rectangle", "center": center, "widthFeet": round(float(width), 2), "heightFeet": round(float(height), 2)}
            else:
                raise HTTPException(400, "Reaction area shape must be circle or rectangle")
            checkpoint = reaction.get("checkpoint")
            checkpoint_fields = {"actionId", "event", "routePlayerId", "routePhase", "routeSegment", "progress"}
            if not isinstance(checkpoint, dict) or set(checkpoint) - checkpoint_fields or not {"actionId", "event"}.issubset(checkpoint):
                raise HTTPException(400, "Reaction checkpoint fields are invalid")
            checkpoint_action = path_actions.get(checkpoint.get("actionId")) if isinstance(checkpoint.get("actionId"), str) else None
            event = checkpoint.get("event")
            if checkpoint_action is None or event not in event_names or checkpoint_action["id"] not in {bait_id, payoff_id}:
                raise HTTPException(400, "Reaction checkpoint must belong to a linked action and supported milestone")
            if event == "catch" and checkpoint_action["kind"] not in {"pass", "handoff"}:
                raise HTTPException(400, "Catch checkpoints require a pass or handoff")
            if event == "screen-set" and checkpoint_action["kind"] not in screen_set_kinds:
                raise HTTPException(400, "Screen-set checkpoints require a screen action")
            if event == "screen-use" and checkpoint_action["kind"] not in screen_use_kinds:
                raise HTTPException(400, "Screen-use checkpoints require a screen or handoff action")
            clean_checkpoint = {"actionId": checkpoint_action["id"], "event": event}
            if event == "route-point":
                route_player, phase, segment, progress = checkpoint.get("routePlayerId"), checkpoint.get("routePhase"), checkpoint.get("routeSegment"), checkpoint.get("progress")
                if not _integer(route_player) or route_player not in player_ids or phase != "main" or segment != 0 or not isinstance(progress, (int, float)) or isinstance(progress, bool) or not math.isfinite(progress) or not 0 < progress < 1:
                    raise HTTPException(400, "Route-point checkpoint needs a player, main route, and progress between zero and one")
                clean_checkpoint.update({"routePlayerId": route_player, "routePhase": phase, "routeSegment": segment, "progress": round(float(progress), 4)})
            elif any(key in checkpoint for key in ("routePlayerId", "routePhase", "routeSegment", "progress")):
                raise HTTPException(400, "Only route-point checkpoints can specify route progress")
            clean_item["reaction"] = {"defenderId": defender_id, "direction": direction, "area": clean_area, "checkpoint": clean_checkpoint}
        clean.append(clean_item)
    return {"version": 1, "connections": clean}


def _flipbook_point(value: object, label: str) -> dict[str, float]:
    if not isinstance(value, dict) or any(not isinstance(value.get(axis), (int, float)) or isinstance(value.get(axis), bool)
                                          or not math.isfinite(value[axis]) or not 0 <= value[axis] <= 100 for axis in ("x", "y")):
        raise HTTPException(400, f"{label} must contain finite court coordinates")
    return {"x": float(value["x"]), "y": float(value["y"])}


def _flipbook_chalk_talk(value: object) -> dict:
    if not isinstance(value, dict) or set(value) != {"version", "steps"} or value.get("version") != 1:
        raise HTTPException(400, "Chalk Talk data is invalid")
    steps = value.get("steps")
    if not isinstance(steps, list) or len(steps) > MAX_FLIPBOOK_STEPS:
        raise HTTPException(400, f"A walkthrough panel can contain at most {MAX_FLIPBOOK_STEPS} reveal steps")
    point_counts = {"circle": (2, 2), "spotlight": (2, 2), "callout": (1, 1), "attention-line": (2, 2), "freehand": (2, 256), "text": (1, 1)}
    step_ids: set[str] = set()
    mark_ids: set[str] = set()
    clean_steps = []
    mark_count = 0
    for step in steps:
        if not isinstance(step, dict) or set(step) != {"id", "label", "marks"}:
            raise HTTPException(400, "Chalk Talk reveal step fields are invalid")
        step_id, label, marks = step.get("id"), step.get("label"), step.get("marks")
        if not isinstance(step_id, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", step_id) or step_id in step_ids:
            raise HTTPException(400, "Chalk Talk reveal step identities must be unique")
        if not isinstance(label, str) or len(label) > 80 or not isinstance(marks, list):
            raise HTTPException(400, "Chalk Talk reveal step label or marks are invalid")
        step_ids.add(step_id)
        clean_marks = []
        for mark in marks:
            mark_count += 1
            if mark_count > MAX_FLIPBOOK_MARKS:
                raise HTTPException(400, f"A walkthrough panel can contain at most {MAX_FLIPBOOK_MARKS} Chalk Talk marks")
            if not isinstance(mark, dict) or set(mark) - {"id", "kind", "points", "text", "number"}:
                raise HTTPException(400, "Chalk Talk mark fields are invalid")
            mark_id, kind, points = mark.get("id"), mark.get("kind"), mark.get("points")
            if not isinstance(mark_id, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", mark_id) or mark_id in mark_ids:
                raise HTTPException(400, "Chalk Talk mark identities must be unique")
            if kind not in point_counts or not isinstance(points, list) or not point_counts[kind][0] <= len(points) <= point_counts[kind][1]:
                raise HTTPException(400, "Chalk Talk mark kind or geometry is invalid")
            mark_ids.add(mark_id)
            clean_mark = {"id": mark_id, "kind": kind, "points": [_flipbook_point(point, "Chalk Talk mark") for point in points]}
            text = mark.get("text")
            if text is not None:
                if not isinstance(text, str) or len(text) > 160:
                    raise HTTPException(400, "Chalk Talk text must be 160 characters or fewer")
                clean_mark["text"] = text
            number = mark.get("number")
            if number is not None:
                if kind != "callout" or not _integer(number) or not 1 <= number <= 30:
                    raise HTTPException(400, "Chalk Talk callout number is invalid")
                clean_mark["number"] = number
            if kind == "callout" and number is None:
                raise HTTPException(400, "Numbered callouts need a number")
            if kind == "text" and (not isinstance(text, str) or not text.strip()):
                raise HTTPException(400, "Text marks need readable text")
            clean_marks.append(clean_mark)
        clean_steps.append({"id": step_id, "label": label, "marks": clean_marks})
    return {"version": 1, "steps": clean_steps}


def _flipbooks(value: object, playbook_id: str, players: list[dict], branches: list[dict]) -> dict:
    if not isinstance(value, dict) or set(value) != {"version", "stories"} or value.get("version") != 1:
        raise HTTPException(400, "Play Flipbook format is invalid")
    stories = value.get("stories")
    if not isinstance(stories, list) or len(stories) > MAX_FLIPBOOK_STORIES:
        raise HTTPException(400, "A play can contain one walkthrough for Main and each ending")
    branch_by_id = {branch["id"]: branch for branch in branches}
    player_ids = {player["id"] for player in players}
    story_keys: set[str] = set()
    clean_stories = []
    for story in stories:
        if not isinstance(story, dict) or set(story) != {"id", "playName", "endingId", "endingLabel", "recording", "panels"}:
            raise HTTPException(400, "Walkthrough fields are invalid")
        story_id, play_name, ending_id, label = story.get("id"), story.get("playName"), story.get("endingId"), story.get("endingLabel")
        if not isinstance(story_id, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", story_id):
            raise HTTPException(400, "Walkthrough identity is invalid")
        if not isinstance(play_name, str) or not play_name.strip() or len(play_name) > 80:
            raise HTTPException(400, "Walkthrough play name must contain 1-80 characters")
        if ending_id is not None and (not isinstance(ending_id, str) or ending_id not in branch_by_id):
            raise HTTPException(400, "Walkthrough must belong to Main or an existing ending")
        ending_key = ending_id or "main"
        if ending_key in story_keys:
            raise HTTPException(400, "A play can contain only one walkthrough per ending")
        story_keys.add(ending_key)
        if not isinstance(label, str) or not label.strip() or len(label) > 40:
            raise HTTPException(400, "Walkthrough ending label must contain 1-40 characters")

        session = story.get("recording")
        required = {"version", "engineVersion", "seed", "initialDrawing", "initialSettings", "resolvedDefenseScheme", "hoop", "positionMs", "events"}
        if not isinstance(session, dict) or set(session) != required or session.get("version") != 1 \
                or not _integer(session.get("engineVersion")) or session["engineVersion"] < 1 \
                or not _integer(session.get("seed")) or not 0 <= session["seed"] <= 0xFFFFFFFF \
                or session.get("resolvedDefenseScheme") not in ALLOWED_DEFENSE_SCHEMES - {"auto"} \
                or not isinstance(session.get("positionMs"), (int, float)) or isinstance(session.get("positionMs"), bool) \
                or not math.isfinite(session["positionMs"]) or session["positionMs"] <= 0 \
                or not isinstance(session.get("events"), list) or len(session["events"]) > 200000:
            raise HTTPException(400, "Walkthrough replay session is invalid")
        source = session["initialDrawing"]
        if not isinstance(source, dict) or any(key in source for key in ("branches", "readCoach", "roleCues", "spacingGates", "flipbooks", "baitPayoffs")):
            raise HTTPException(400, "Walkthrough recording must use a flattened executable drawing")
        _document(source, playbook_id=playbook_id)
        if not isinstance(session.get("initialSettings"), dict):
            raise HTTPException(400, "Walkthrough simulation settings are invalid")
        settings = session["initialSettings"]
        if settings.get("offenseOffBall") not in ALLOWED_OFFBALL_STYLES or settings.get("defenseScheme") not in ALLOWED_DEFENSE_SCHEMES \
                or settings.get("defenseStrategy") not in ALLOWED_DEFENSE_STRATEGIES \
                or not isinstance(settings.get("offBallIntensity"), (int, float)) or isinstance(settings.get("offBallIntensity"), bool) \
                or not math.isfinite(settings["offBallIntensity"]) or not isinstance(settings.get("automaticActions"), dict) \
                or set(settings["automaticActions"]) != {"screen", "handoff", "pickRoll", "offBallScreen"} \
                or any(not isinstance(enabled, bool) for enabled in settings["automaticActions"].values()) \
                or settings.get("offenseMode", "adaptive") not in {"adaptive", "scripted"}:
            raise HTTPException(400, "Walkthrough simulation settings are invalid")
        _flipbook_point(session.get("hoop"), "Walkthrough hoop")
        expected_time = 0.0
        action_ids = {arrow["id"] for arrow in source.get("arrows", [])}
        for event in session["events"]:
            if not isinstance(event, dict) or not isinstance(event.get("atMs"), (int, float)) or isinstance(event.get("atMs"), bool) \
                    or not math.isfinite(event["atMs"]) or abs(event["atMs"] - expected_time) >= 1e-5 \
                    or not isinstance(event.get("elapsedMs"), (int, float)) or isinstance(event.get("elapsedMs"), bool) or not math.isfinite(event["elapsedMs"]) \
                    or not isinstance(event.get("accumulatorMs"), (int, float)) or isinstance(event.get("accumulatorMs"), bool) or not math.isfinite(event["accumulatorMs"]):
                raise HTTPException(400, "Walkthrough replay timeline is invalid")
            if event.get("kind") == "advance":
                delta, end = event.get("deltaMs"), event.get("endMs")
                if set(event) != {"kind", "atMs", "elapsedMs", "accumulatorMs", "deltaMs", "endMs"} \
                        or not isinstance(delta, (int, float)) or isinstance(delta, bool) or not math.isfinite(delta) or not 0 < delta <= 50 \
                        or not isinstance(end, (int, float)) or isinstance(end, bool) or not math.isfinite(end) or end <= event["atMs"]:
                    raise HTTPException(400, "Walkthrough replay step is invalid")
                expected_time = end
            elif event.get("kind") == "settings":
                if set(event) != {"kind", "atMs", "elapsedMs", "accumulatorMs", "settings"} or not isinstance(event.get("settings"), dict):
                    raise HTTPException(400, "Walkthrough settings event is invalid")
            elif event.get("kind") == "edit":
                if set(event) - {"kind", "atMs", "elapsedMs", "accumulatorMs", "drawing", "relocation"} or not isinstance(event.get("drawing"), dict):
                    raise HTTPException(400, "Walkthrough edit event is invalid")
                drawing = event["drawing"]
                if any(key in drawing for key in ("branches", "readCoach", "roleCues", "spacingGates", "flipbooks", "baitPayoffs")):
                    raise HTTPException(400, "Walkthrough edits must remain flattened")
                normalized = _document(drawing, playbook_id=playbook_id)
                action_ids.update(arrow["id"] for arrow in normalized["arrows"])
            else:
                raise HTTPException(400, "Walkthrough replay event kind is unsupported")
        if abs(expected_time - session["positionMs"]) >= 1e-5:
            raise HTTPException(400, "Walkthrough recording must contain its complete timeline")
        captured = source
        for event in reversed(session["events"]):
            if event.get("kind") == "edit":
                captured = event["drawing"]
                break
        expected_players = {marker["id"] for marker in captured.get("players", [])}
        expected_defenders = {marker["id"] for marker in captured.get("defenders", [])} or set(range(1, len(expected_players) + 1))
        panels = story.get("panels")
        if not isinstance(panels, list) or not 1 <= len(panels) <= MAX_FLIPBOOK_PANELS:
            raise HTTPException(400, "Walkthrough needs 1-12 panels")
        panel_ids: set[str] = set()
        previous_time = -1.0
        clean_panels = []
        for panel in panels:
            if not isinstance(panel, dict) or set(panel) - {"id", "atMs", "caption", "focusPlayerIds", "routeIds", "snapshot", "chalkTalk"} or not {"id", "atMs", "caption", "focusPlayerIds", "routeIds", "snapshot"}.issubset(panel):
                raise HTTPException(400, "Walkthrough panel fields are invalid")
            panel_id, at_ms, caption = panel.get("id"), panel.get("atMs"), panel.get("caption")
            if not isinstance(panel_id, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", panel_id) or panel_id in panel_ids:
                raise HTTPException(400, "Walkthrough panel identities must be unique")
            panel_ids.add(panel_id)
            if not isinstance(at_ms, (int, float)) or isinstance(at_ms, bool) or not math.isfinite(at_ms) or not previous_time < at_ms <= session["positionMs"]:
                raise HTTPException(400, "Walkthrough panels must be in chronological order")
            previous_time = at_ms
            if not isinstance(caption, str) or len(caption) > 160:
                raise HTTPException(400, "Walkthrough caption must be 160 characters or fewer")
            focus = panel.get("focusPlayerIds")
            if not isinstance(focus, list) or len(focus) > MAX_PLAYERS or any(not _integer(item) or item not in player_ids for item in focus) or len(set(focus)) != len(focus):
                raise HTTPException(400, "Walkthrough focus players are invalid")
            snapshot = panel.get("snapshot")
            if not isinstance(snapshot, dict) or set(snapshot) != {"atMs", "players", "defenders", "ball", "ballHandlerId", "ballPhase", "shotPhase", "routes"} \
                    or snapshot.get("atMs") != at_ms:
                raise HTTPException(400, "Walkthrough court snapshot must match its panel time")
            def validate_position_roster(raw_roster, expected_ids, label):
                if not isinstance(raw_roster, list) or len(raw_roster) > MAX_PLAYERS:
                    raise HTTPException(400, f"Walkthrough {label} roster is invalid")
                found = set()
                result = []
                for marker in raw_roster:
                    if not isinstance(marker, dict) or set(marker) != {"id", "x", "y"} or not _integer(marker.get("id")) or marker["id"] not in expected_ids or marker["id"] in found:
                        raise HTTPException(400, f"Walkthrough {label} identity is invalid")
                    found.add(marker["id"])
                    point = _flipbook_point(marker, f"Walkthrough {label}")
                    result.append({"id": marker["id"], **point})
                if found != expected_ids:
                    raise HTTPException(400, f"Walkthrough {label} roster is incomplete")
                return result
            clean_players = validate_position_roster(snapshot.get("players"), expected_players, "players")
            clean_defenders = validate_position_roster(snapshot.get("defenders"), expected_defenders, "defenders")
            clean_ball = None if snapshot.get("ball") is None else _flipbook_point(snapshot["ball"], "Walkthrough ball")
            handler = snapshot.get("ballHandlerId")
            if handler is not None and (not _integer(handler) or handler not in player_ids):
                raise HTTPException(400, "Walkthrough ball handler is invalid")
            if snapshot.get("ballPhase") not in {"held", "pass-in-flight", "handoff-pending", "loose", "shot-setup", "shot-in-flight", "shot-result"} \
                    or snapshot.get("shotPhase") not in {"idle", "setup", "air", "result"}:
                raise HTTPException(400, "Walkthrough ball state is invalid")
            raw_routes = snapshot.get("routes")
            if not isinstance(raw_routes, list) or len(raw_routes) > 100:
                raise HTTPException(400, "Walkthrough routes are invalid")
            route_ids: set[str] = set()
            clean_routes = []
            for route in raw_routes:
                allowed = {"id", "actionId", "sequence", "kind", "playerId", "scope", "importance", "start", "end", "control", "via", "points"}
                if not isinstance(route, dict) or set(route) - allowed:
                    raise HTTPException(400, "Walkthrough route fields are invalid")
                route_id, route_player, action_id = route.get("id"), route.get("playerId"), route.get("actionId")
                generated_action = isinstance(action_id, str) and (
                    re.fullmatch(r"auto-(?:offball|handoff|pick-roll|screen)-(?:[1-9]|[12]\d|30)", action_id) is not None
                    or re.fullmatch(r"adaptive-read-(?:movement|pass)", action_id) is not None
                )
                if not isinstance(route_id, str) or route_id in route_ids or not _integer(route_player) or route_player not in player_ids \
                        or action_id is not None and (not isinstance(action_id, str) or action_id not in action_ids and not generated_action) \
                        or route.get("scope") not in {"on-ball", "off-ball"} or route.get("importance") not in {"main", "adjustment"} \
                        or not isinstance(route.get("kind"), str):
                    raise HTTPException(400, "Walkthrough route identity is invalid")
                route_ids.add(route_id)
                clean_route = {"id": route_id, "actionId": action_id, "sequence": route.get("sequence"), "kind": route["kind"], "playerId": route_player,
                    "scope": route["scope"], "importance": route["importance"], "start": _flipbook_point(route.get("start"), "Walkthrough route start"),
                    "end": _flipbook_point(route.get("end"), "Walkthrough route end")}
                if route.get("sequence") is not None and (not _integer(route["sequence"]) or not 1 <= route["sequence"] <= MAX_ARROWS):
                    raise HTTPException(400, "Walkthrough route sequence is invalid")
                for field in ("control", "via"):
                    if route.get(field) is not None:
                        clean_route[field] = _flipbook_point(route[field], f"Walkthrough route {field}")
                if "points" in route:
                    if not isinstance(route["points"], list) or len(route["points"]) > 128:
                        raise HTTPException(400, "Walkthrough route points are invalid")
                    clean_route["points"] = [_flipbook_point(point, "Walkthrough route point") for point in route["points"]]
                clean_routes.append(clean_route)
            route_selection = panel.get("routeIds")
            if not isinstance(route_selection, list) or len(route_selection) > 100 or any(not isinstance(item, str) or item not in route_ids for item in route_selection) or len(set(route_selection)) != len(route_selection):
                raise HTTPException(400, "Walkthrough selected routes are invalid")
            # Keep the nested snapshot clock on the same numeric representation
            # as the normalized panel clock so create receipts remain stable
            # when their document is validated a second time.
            clean_snapshot = {"atMs": float(at_ms), "players": clean_players, "defenders": clean_defenders, "ball": clean_ball,
                "ballHandlerId": handler, "ballPhase": snapshot["ballPhase"], "shotPhase": snapshot["shotPhase"], "routes": clean_routes}
            clean_panel = {"id": panel_id, "atMs": float(at_ms), "caption": caption, "focusPlayerIds": list(focus),
                "routeIds": list(route_selection), "snapshot": clean_snapshot}
            if "chalkTalk" in panel:
                clean_panel["chalkTalk"] = _flipbook_chalk_talk(panel["chalkTalk"])
            clean_panels.append(clean_panel)
        clean_stories.append({"id": story_id, "playName": play_name, "endingId": ending_id, "endingLabel": label, "recording": session, "panels": clean_panels})
    return {"version": 1, "stories": clean_stories}


def _spacing_gates(value: object, players: list[dict], arrows: list[dict], branches: list[dict]) -> dict:
    if not isinstance(value, dict) or set(value) != {"version", "gates"} or value.get("version") != 1:
        raise HTTPException(400, "Spacing gate data is invalid")
    gates = value.get("gates")
    if not isinstance(gates, list) or len(gates) > MAX_SPACING_GATES:
        raise HTTPException(400, f"A play can contain at most {MAX_SPACING_GATES} spacing gates")
    player_ids = {marker["id"] for marker in players}
    main_by_id = {arrow["id"]: arrow for arrow in arrows}
    branch_by_id = {branch["id"]: branch for branch in branches}
    gate_ids: set[str] = set()
    clean: list[dict] = []
    for gate in gates:
        allowed = {"id", "playerId", "area", "rule", "trigger", "beforeSeconds", "afterSeconds", "instruction", "scope", "branchId"}
        if not isinstance(gate, dict) or set(gate) - allowed:
            raise HTTPException(400, "Spacing gate contains unsupported fields")
        gate_id = gate.get("id")
        if not isinstance(gate_id, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", gate_id) or gate_id in gate_ids:
            raise HTTPException(400, "Spacing gate identities must be unique short labels")
        gate_ids.add(gate_id)
        player_id = gate.get("playerId")
        if not _integer(player_id) or player_id not in player_ids:
            raise HTTPException(400, "Spacing gates must reference an offensive player")
        rule, scope = gate.get("rule"), gate.get("scope")
        if rule not in {"inside", "outside"} or scope not in {"shared", "ending"}:
            raise HTTPException(400, "Spacing gate rule or scope is invalid")
        branch_id = gate.get("branchId")
        if scope == "shared" and branch_id is not None:
            raise HTTPException(400, "Shared spacing gates cannot name an ending")
        if scope == "ending" and (not isinstance(branch_id, str) or branch_id not in branch_by_id):
            raise HTTPException(400, "Ending spacing gates must reference an existing ending")
        area = gate.get("area")
        if not isinstance(area, dict) or set(area) - {"shape", "center", "radiusFeet", "widthFeet", "heightFeet"}:
            raise HTTPException(400, "Spacing gate area is invalid")
        center = _point(area.get("center"), "Spacing gate center")
        if area.get("shape") == "circle":
            radius = area.get("radiusFeet")
            if not isinstance(radius, (int, float)) or isinstance(radius, bool) or not math.isfinite(radius) or not 0.5 <= radius <= 25 or "widthFeet" in area or "heightFeet" in area:
                raise HTTPException(400, "Spacing gate circle radius must be 0.5-25 feet")
            if min(center["x"] * 0.5, (100 - center["x"]) * 0.5, center["y"] * 0.47, (100 - center["y"]) * 0.47) < radius - 1e-6:
                raise HTTPException(400, "Spacing gate must stay within the playable court")
            clean_area = {"shape": "circle", "center": center, "radiusFeet": round(float(radius), 2)}
        elif area.get("shape") == "rectangle":
            width, height = area.get("widthFeet"), area.get("heightFeet")
            if any(not isinstance(n, (int, float)) or isinstance(n, bool) or not math.isfinite(n) for n in (width, height)) or not 1 <= width <= 50 or not 1 <= height <= 47 or "radiusFeet" in area:
                raise HTTPException(400, "Spacing gate rectangle dimensions are invalid")
            if min(center["x"] * 0.5, (100 - center["x"]) * 0.5) < width / 2 - 1e-6 or min(center["y"] * 0.47, (100 - center["y"]) * 0.47) < height / 2 - 1e-6:
                raise HTTPException(400, "Spacing gate must stay within the playable court")
            clean_area = {"shape": "rectangle", "center": center, "widthFeet": round(float(width), 2), "heightFeet": round(float(height), 2)}
        else:
            raise HTTPException(400, "Spacing gate shape must be circle or rectangle")
        times = []
        for field in ("beforeSeconds", "afterSeconds"):
            seconds = gate.get(field)
            if not isinstance(seconds, (int, float)) or isinstance(seconds, bool) or not math.isfinite(seconds) or not 0 <= seconds <= 5 or abs(seconds * 10 - round(seconds * 10)) > 1e-6:
                raise HTTPException(400, f"Spacing gate {field} must use 0.1-second steps up to five seconds")
            times.append(round(float(seconds), 1))
        instruction = gate.get("instruction")
        if instruction is not None and (not isinstance(instruction, str) or len(instruction) > 120):
            raise HTTPException(400, "Spacing gate instruction must be 120 characters or fewer")
        trigger = gate.get("trigger")
        trigger_fields = {"actionId", "event", "routePlayerId", "routePhase", "routeSegment", "progress"}
        if not isinstance(trigger, dict) or set(trigger) - trigger_fields:
            raise HTTPException(400, "Spacing gate checkpoint is invalid")
        action_id, event = trigger.get("actionId"), trigger.get("event")
        if not isinstance(action_id, str) or not re.fullmatch(r"[a-z0-9-]{1,64}", action_id) or event not in SPACING_EVENTS:
            raise HTTPException(400, "Spacing gate checkpoint must reference a supported action milestone")
        action = main_by_id.get(action_id) if scope == "shared" else next((arrow for arrow in branch_by_id[branch_id]["continuation"] if arrow["id"] == action_id), None)
        if action is None:
            raise HTTPException(400, "Spacing gate checkpoint must stay in its shared opening or selected ending")
        if event == "catch" and action["kind"] not in {"pass", "handoff"}:
            raise HTTPException(400, "Catch checkpoints require a pass or handoff")
        if event == "screen-set" and action["kind"] not in {"screen", "pick-roll", "pick-pop", "off-ball-screen", "pin-down"}:
            raise HTTPException(400, "Screen-set checkpoints require a screen action")
        if event == "screen-use" and action["kind"] not in {"screen", "slip-screen", "pick-roll", "pick-pop", "off-ball-screen", "pin-down", "handoff"}:
            raise HTTPException(400, "Screen-use checkpoints require a screen or handoff action")
        clean_trigger = {"actionId": action_id, "event": event}
        if event == "route-point":
            route_player = trigger.get("routePlayerId")
            phase, segment, progress = trigger.get("routePhase"), trigger.get("routeSegment"), trigger.get("progress")
            if not _integer(route_player) or route_player not in player_ids or phase not in TIMING_PHASES or not _integer(segment) or not 0 <= segment <= 63 or not isinstance(progress, (int, float)) or isinstance(progress, bool) or not math.isfinite(progress) or not 0 < progress < 1:
                raise HTTPException(400, "Route checkpoints need a player, route phase, segment, and progress between zero and one")
            clean_trigger.update({"routePlayerId": route_player, "routePhase": phase, "routeSegment": segment, "progress": round(float(progress), 4)})
        elif set(trigger) - {"actionId", "event"}:
            raise HTTPException(400, "Only route checkpoints can specify a route point")
        clean.append({"id": gate_id, "playerId": player_id, "area": clean_area, "rule": rule, "trigger": clean_trigger,
            "beforeSeconds": times[0], "afterSeconds": times[1], **({"instruction": instruction.strip()} if isinstance(instruction, str) and instruction.strip() else {}),
            "scope": scope, **({"branchId": branch_id} if branch_id is not None else {})})
    return {"version": 1, "gates": clean}


def _role_cues(value: object, players: list[dict], arrows: list[dict], branches: list[dict]) -> dict:
    if not isinstance(value, dict) or set(value) != {"version", "cues"} or value.get("version") != 1:
        raise HTTPException(400, "Role rehearsal cue data is invalid")
    cues = value.get("cues")
    if not isinstance(cues, list) or len(cues) > MAX_ROLE_CUES:
        raise HTTPException(400, f"Role rehearsal may contain at most {MAX_ROLE_CUES} cues")
    player_ids = {marker["id"] for marker in players}
    main_ids = {arrow["id"] for arrow in arrows}
    branch_by_id = {branch["id"]: branch for branch in branches}
    keys: set[tuple] = set()
    clean: list[dict] = []
    for cue in cues:
        if not isinstance(cue, dict) or set(cue) - {"playerId", "actionId", "phase", "scope", "branchId", "text", "signature"}:
            raise HTTPException(400, "Role rehearsal cue fields are invalid")
        player_id, action_id, phase, scope = cue.get("playerId"), cue.get("actionId"), cue.get("phase"), cue.get("scope")
        text, signature = cue.get("text"), cue.get("signature")
        if not _integer(player_id) or player_id not in player_ids:
            raise HTTPException(400, "Role rehearsal cues must reference an offensive player")
        if not isinstance(action_id, str) or not (action_id == "stationary" or re.fullmatch(r"[a-z0-9-]{1,64}", action_id)):
            raise HTTPException(400, "Role rehearsal cue action identity is invalid")
        if phase not in ROLE_CUE_PHASES or scope not in {"shared", "ending"}:
            raise HTTPException(400, "Role rehearsal cue phase or scope is invalid")
        if not isinstance(text, str) or not text.strip() or len(text) > 240:
            raise HTTPException(400, "Role rehearsal cue wording must contain 1-240 characters")
        if not isinstance(signature, str) or not re.fullmatch(r"[0-9a-f]{8}", signature):
            raise HTTPException(400, "Role rehearsal cue signature is invalid")
        branch_id = cue.get("branchId")
        if action_id == "stationary":
            if phase != "hold":
                raise HTTPException(400, "Stationary role cues must describe holding position")
            if scope == "shared":
                if branch_id is not None:
                    raise HTTPException(400, "Shared role cues cannot name an ending")
            elif not isinstance(branch_id, str) or branch_id not in branch_by_id:
                raise HTTPException(400, "Ending stationary cue must reference an existing ending")
        elif scope == "shared":
            if branch_id is not None or action_id not in main_ids:
                raise HTTPException(400, "Shared role cues must reference a Main action")
        else:
            branch = branch_by_id.get(branch_id) if isinstance(branch_id, str) else None
            if branch is None or action_id not in {arrow["id"] for arrow in branch["continuation"]}:
                raise HTTPException(400, "Ending role cues must reference an action in that ending")
        key = (scope, branch_id or "", player_id, action_id, phase)
        if key in keys:
            raise HTTPException(400, "Role rehearsal cue identities must be unique")
        keys.add(key)
        clean.append({"playerId": player_id, "actionId": action_id, "phase": phase, "scope": scope,
            **({"branchId": branch_id} if branch_id is not None else {}), "text": text.strip(), "signature": signature})
    return {"version": 1, "cues": clean}


def _resolved_action_paths(value: dict) -> dict[str, list[dict]]:
    main = list(value.get("arrows") or [])
    paths = {"__main__": main}
    for branch in value.get("branches") or []:
        ordered = sorted(enumerate(main), key=lambda entry: (entry[1].get("sequence", entry[0] + 1), entry[0]))
        anchors = set(branch["fork"]["actionIds"])
        anchor_sequences = [arrow.get("sequence", index + 1) for index, arrow in ordered if arrow["id"] in anchors]
        if anchor_sequences:
            cutoff = min(anchor_sequences)
        else:
            later = [arrow.get("sequence", index + 1) for index, arrow in ordered if arrow.get("sequence", index + 1) >= branch["fork"]["sequence"]]
            cutoff = min(later) if later else None
        shared_entries = [(index, arrow) for index, arrow in ordered if cutoff is None or arrow.get("sequence", index + 1) < cutoff]
        shared = [arrow for _, arrow in shared_entries]
        shared_ids = {arrow["id"] for arrow in shared}
        max_shared = max((arrow.get("sequence", index + 1) for index, arrow in shared_entries), default=0)
        continuation = sorted(enumerate(branch.get("continuation") or []), key=lambda entry: (entry[1].get("sequence", entry[0] + 1), entry[0]))
        continuation = [(index, arrow) for index, arrow in continuation if arrow["id"] not in shared_ids]
        groups = list(dict.fromkeys(arrow.get("sequence", index + 1) for index, arrow in continuation))
        rebased = {sequence: max_shared + index + 1 for index, sequence in enumerate(groups)}
        paths[branch["id"]] = shared + [{**arrow, "sequence": rebased[arrow.get("sequence", index + 1)]} for index, arrow in continuation]
    return paths


def _timing_source_change(current: dict, candidate: dict) -> str | None:
    signature_fields = ("id", "kind", "sequence", "path", "start", "end", "control", "exit_target", "actor_id", "recipient_id", "screener_id", "handler_id", "cutter_id")
    old_paths, new_paths = _resolved_action_paths(current), _resolved_action_paths(candidate)
    for path_id, new_path in new_paths.items():
        old_path = old_paths.get(path_id)
        if old_path is None:
            continue
        old_by_id = {arrow["id"]: arrow for arrow in old_path}
        new_by_id = {arrow["id"]: arrow for arrow in new_path}
        for dependent in new_path:
            old_dependent = old_by_id.get(dependent["id"])
            old_waits = {wait["id"]: wait for wait in (old_dependent or {}).get("timingPlan", {}).get("waits", [])}
            for wait in dependent.get("timingPlan", {}).get("waits", []):
                source_id = wait["actionId"]
                old_source, new_source = old_by_id.get(source_id), new_by_id.get(source_id)
                if old_source is None or new_source is None or old_waits.get(wait["id"]) != wait:
                    continue  # A new or edited wait is an explicit retarget
                if any(old_source.get(field) != new_source.get(field) for field in signature_fields):
                    return f"Move {old_source.get('sequence', '?')} is referenced by a timing wait. Remove or retarget that wait before changing the action"
    return None


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def _path(playbook_id: str) -> Path:
    if not PLAYBOOK_ID.fullmatch(playbook_id):
        raise HTTPException(400, "Invalid playbook id")
    return PLAYBOOKS_DIR / f"{playbook_id}.json"


def _integer(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and abs(value) <= 9007199254740991 and math.isfinite(value) and value == int(value)


def _point(value: object, label: str) -> dict[str, float]:
    if not isinstance(value, dict) or any(not isinstance(value.get(axis), (int, float)) or isinstance(value.get(axis), bool) for axis in ("x", "y")):
        raise HTTPException(400, f"{label} must contain numeric x and y")
    x, y = value["x"], value["y"]
    if not 0 <= x <= 100 or not 0 <= y <= 100:
        raise HTTPException(400, f"{label} must stay inside the court")
    return {"x": round(float(x), COORDINATE_DECIMAL_PLACES), "y": round(float(y), COORDINATE_DECIMAL_PLACES)}


def _markers(
    value: object,
    label: str,
    limit: int,
    *,
    player_ratings: bool = False,
    badge_catalog: set[str] | None = None,
) -> list[dict]:
    if not isinstance(value, list) or len(value) > limit:
        raise HTTPException(400, f"{label} must contain at most {limit} markers")
    result: list[dict] = []
    ids: set[int] = set()
    for marker in value:
        if not isinstance(marker, dict) or not _integer(marker.get("id")) or marker["id"] < 1:
            raise HTTPException(400, f"{label} markers need positive integer ids")
        if marker["id"] in ids:
            raise HTTPException(400, f"{label} marker ids must be unique")
        ids.add(marker["id"])
        clean_marker = {"id": marker["id"], **_point(marker, f"{label} marker")}
        if player_ratings:
            ratings = marker.get("ratings", {})
            if not isinstance(ratings, dict):
                raise HTTPException(400, "Player ratings must be an object")
            clean_ratings: dict[str, int] = {}
            for key in ("threePoint", "midrange", "finishing"):
                rating = ratings.get(key, 3)
                if not _integer(rating) or not 1 <= rating <= 5:
                    raise HTTPException(400, "Player ratings must be integers from 1 to 5")
                clean_ratings[key] = rating
            clean_marker["ratings"] = clean_ratings
        allowed_badges = badge_catalog or (ALLOWED_PLAYER_BADGES if player_ratings else None)
        if allowed_badges is not None:
            badges = marker.get("badges", [])
            if not isinstance(badges, list) or any(not isinstance(badge, str) or badge not in allowed_badges for badge in badges):
                raise HTTPException(400, f"{label} badges must use supported badge ids")
            if len(badges) != len(set(badges)):
                raise HTTPException(400, f"{label} badges must be unique")
            clean_marker["badges"] = list(badges)
        result.append(clean_marker)
    return result


def _read_coach(value: object, playbook_id: str) -> dict:
    if not isinstance(value, dict) or set(value) != {"version", "checkpoints"} or value.get("version") != 1:
        raise HTTPException(400, "Read Coach lesson format is invalid")
    checkpoints = value.get("checkpoints")
    if not isinstance(checkpoints, list) or len(checkpoints) > MAX_READ_CHECKPOINTS:
        raise HTTPException(400, f"Read Coach supports at most {MAX_READ_CHECKPOINTS} checkpoints")
    ids: set[str] = set()
    clean: list[dict] = []

    def valid_settings(settings: object) -> bool:
        if not isinstance(settings, dict) or settings.get("offenseOffBall") not in ALLOWED_OFFBALL_STYLES \
                or settings.get("defenseScheme") not in ALLOWED_DEFENSE_SCHEMES \
                or settings.get("defenseStrategy") not in ALLOWED_DEFENSE_STRATEGIES:
            return False
        intensity = settings.get("offBallIntensity")
        automatic = settings.get("automaticActions")
        return isinstance(intensity, (int, float)) and not isinstance(intensity, bool) and math.isfinite(intensity) \
            and isinstance(automatic, dict) and set(automatic) == {"screen", "handoff", "pickRoll", "offBallScreen"} \
            and all(isinstance(enabled, bool) for enabled in automatic.values()) \
            and settings.get("offenseMode", "adaptive") in {"adaptive", "scripted"}

    for checkpoint in checkpoints:
        if not isinstance(checkpoint, dict) or set(checkpoint) != {"id", "question", "session", "snapshot", "choices", "correctChoiceId", "explanation"}:
            raise HTTPException(400, "Read checkpoint fields are invalid")
        checkpoint_id = checkpoint.get("id")
        question, explanation = checkpoint.get("question"), checkpoint.get("explanation")
        if not isinstance(checkpoint_id, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", checkpoint_id) or checkpoint_id in ids:
            raise HTTPException(400, "Read checkpoint identities must be unique")
        ids.add(checkpoint_id)
        if not isinstance(question, str) or not question.strip() or len(question) > 240:
            raise HTTPException(400, "Read checkpoint question must contain 1-240 characters")
        if not isinstance(explanation, str) or not explanation.strip() or len(explanation) > 2000:
            raise HTTPException(400, "Read checkpoint explanation must contain 1-2000 characters")
        session = checkpoint.get("session")
        required_session_fields = {"version", "engineVersion", "seed", "initialDrawing", "initialSettings", "resolvedDefenseScheme", "hoop", "positionMs", "events"}
        if not isinstance(session, dict) or set(session) != required_session_fields or session.get("version") != 1 \
                or not _integer(session.get("engineVersion")) or session["engineVersion"] < 1 \
                or not _integer(session.get("seed")) or not 0 <= session["seed"] <= 0xFFFFFFFF \
                or session.get("resolvedDefenseScheme") not in ALLOWED_DEFENSE_SCHEMES - {"auto"} \
                or not isinstance(session.get("positionMs"), (int, float)) or isinstance(session.get("positionMs"), bool) \
                or not math.isfinite(session["positionMs"]) or session["positionMs"] < 0 \
                or not isinstance(session.get("events"), list) or len(session["events"]) > 200000 \
                or not valid_settings(session.get("initialSettings")):
            raise HTTPException(400, "Read checkpoint replay session is invalid")
        source = session["initialDrawing"]
        if not isinstance(source, dict) or "readCoach" in source or "roleCues" in source or "spacingGates" in source or "flipbooks" in source or "baitPayoffs" in source or "branches" in source:
            raise HTTPException(400, "Read checkpoint snapshots must be flattened and cannot contain lessons")
        _document(source, playbook_id=playbook_id, validate_timing_edges=True)
        _point(session.get("hoop"), "Read checkpoint hoop")
        expected_time = 0.0
        for event in session["events"]:
            if not isinstance(event, dict) or not isinstance(event.get("kind"), str) or not isinstance(event.get("atMs"), (int, float)) \
                    or isinstance(event.get("atMs"), bool) or not math.isfinite(event["atMs"]) \
                    or abs(event["atMs"] - expected_time) >= 1e-5 \
                    or not isinstance(event.get("elapsedMs"), (int, float)) or isinstance(event.get("elapsedMs"), bool) or not math.isfinite(event["elapsedMs"]) \
                    or not isinstance(event.get("accumulatorMs"), (int, float)) or isinstance(event.get("accumulatorMs"), bool) or not math.isfinite(event["accumulatorMs"]):
                raise HTTPException(400, "Read checkpoint replay timeline is invalid")
            if event["kind"] == "advance":
                if set(event) != {"kind", "atMs", "elapsedMs", "accumulatorMs", "deltaMs", "endMs"}:
                    raise HTTPException(400, "Read checkpoint replay step is invalid")
                delta, end = event.get("deltaMs"), event.get("endMs")
                if not isinstance(delta, (int, float)) or isinstance(delta, bool) or not math.isfinite(delta) or not 0 < delta <= 50 \
                        or not isinstance(end, (int, float)) or isinstance(end, bool) or not math.isfinite(end) or end <= event["atMs"]:
                    raise HTTPException(400, "Read checkpoint replay step is invalid")
                expected_time = end
            elif event["kind"] == "settings":
                if set(event) != {"kind", "atMs", "elapsedMs", "accumulatorMs", "settings"} or not valid_settings(event.get("settings")):
                    raise HTTPException(400, "Read checkpoint replay settings are invalid")
            elif event["kind"] == "edit":
                if set(event) - {"kind", "atMs", "elapsedMs", "accumulatorMs", "drawing", "relocation"} or "drawing" not in event:
                    raise HTTPException(400, "Read checkpoint replay edit is invalid")
                drawing = event["drawing"]
                if not isinstance(drawing, dict) or "readCoach" in drawing or "roleCues" in drawing or "spacingGates" in drawing or "flipbooks" in drawing or "baitPayoffs" in drawing or "branches" in drawing:
                    raise HTTPException(400, "Read checkpoint replay edits must be flattened")
                _document(drawing, playbook_id=playbook_id)
                relocation = event.get("relocation")
                if relocation is not None:
                    if not isinstance(relocation, dict) or set(relocation) != {"type", "id", "point"} or relocation.get("type") not in {"player", "defender", "ball"}:
                        raise HTTPException(400, "Read checkpoint relocation is invalid")
                    _point(relocation.get("point"), "Read checkpoint relocation")
            else:
                raise HTTPException(400, "Read checkpoint replay event kind is unsupported")
        if abs(expected_time - session["positionMs"]) >= 1e-5:
            raise HTTPException(400, "Read checkpoint replay must end at its captured time")
        snapshot = checkpoint.get("snapshot")
        if not isinstance(snapshot, dict) or set(snapshot) != {"players", "defenders", "ball", "ballHandlerId", "atMs"} \
                or not isinstance(snapshot.get("atMs"), (int, float)) or isinstance(snapshot.get("atMs"), bool) \
                or not math.isfinite(snapshot["atMs"]) or abs(snapshot["atMs"] - session["positionMs"]) >= 1e-5:
            raise HTTPException(400, "Read checkpoint court snapshot is invalid")
        captured_source = source
        for event in reversed(session["events"]):
            if event.get("kind") == "edit":
                captured_source = event["drawing"]
                break
        snapshot_players = _markers(snapshot.get("players"), "Read checkpoint players", MAX_PLAYERS, player_ratings=True)
        snapshot_defenders = _markers(snapshot.get("defenders"), "Read checkpoint defenders", MAX_DEFENDERS, badge_catalog=ALLOWED_DEFENDER_BADGES)
        source_players = _markers(captured_source.get("players", []), "Captured players", MAX_PLAYERS, player_ratings=True)
        source_defenders = _markers(captured_source.get("defenders", []), "Captured defenders", MAX_DEFENDERS, badge_catalog=ALLOWED_DEFENDER_BADGES)
        expected_defender_ids = {marker["id"] for marker in source_defenders}
        if not source_defenders:
            # Simulations add deterministic goal-side defenders when a play
            # has no authored defense. They are part of the captured court but
            # do not rewrite the play's original roster.
            expected_defender_ids = set(range(1, len(source_players) + 1))
        if {marker["id"] for marker in snapshot_players} != {marker["id"] for marker in source_players} \
                or {marker["id"] for marker in snapshot_defenders} != expected_defender_ids:
            raise HTTPException(400, "Read checkpoint roster does not match its recorded situation")
        clean_ball = None if snapshot.get("ball") is None else _point(snapshot.get("ball"), "Read checkpoint ball")
        handler_id = snapshot.get("ballHandlerId")
        if not _integer(handler_id) or handler_id not in {marker["id"] for marker in snapshot_players} or clean_ball is None:
            raise HTTPException(400, "Read checkpoint must capture a held ball and its handler")
        choices = checkpoint.get("choices")
        if not isinstance(choices, list) or not 2 <= len(choices) <= 3:
            raise HTTPException(400, "Read checkpoints need two or three choices")
        choice_ids: set[str] = set()
        clean_choices: list[dict] = []
        for choice in choices:
            if not isinstance(choice, dict) or set(choice) != {"id", "label", "arrows"}:
                raise HTTPException(400, "Read choice fields are invalid")
            choice_id, label, arrows = choice.get("id"), choice.get("label"), choice.get("arrows")
            if not isinstance(choice_id, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", choice_id) or choice_id in choice_ids:
                raise HTTPException(400, "Read choice identities must be unique")
            choice_ids.add(choice_id)
            if not isinstance(label, str) or not 1 <= len(label.strip(NAME_WHITESPACE)) <= 80 or not isinstance(arrows, list) or len(arrows) > MAX_ARROWS:
                raise HTTPException(400, "Read choice label or actions are invalid")
            candidate = {**source, "name": f"{source.get('name', 'Read choice')} · {label}"[:MAX_NAME_LENGTH], "arrows": arrows}
            _document(candidate, playbook_id=playbook_id)
            clean_choices.append({"id": choice_id, "label": label.strip(NAME_WHITESPACE), "arrows": arrows})
        correct = checkpoint.get("correctChoiceId")
        if not isinstance(correct, str) or correct not in choice_ids:
            raise HTTPException(400, "Read Coach must mark one intended choice")
        clean.append({"id": checkpoint_id, "question": question.strip(NAME_WHITESPACE), "session": session,
            "snapshot": {"players": snapshot_players, "defenders": snapshot_defenders, "ball": clean_ball,
                "ballHandlerId": handler_id, "atMs": snapshot["atMs"]},
            "choices": clean_choices, "correctChoiceId": correct, "explanation": explanation.strip(NAME_WHITESPACE)})
    return {"version": 1, "checkpoints": clean}


def _document(payload: object, *, playbook_id: str, created_at: str | None = None, validate_timing_edges: bool = True) -> dict:
    if not isinstance(payload, dict):
        raise HTTPException(400, "Playbook must be an object")
    if "version" in payload and (not _integer(payload["version"]) or payload["version"] != 1):
        raise HTTPException(400, "Only version-1 plays are supported")
    if "revision" in payload and (not isinstance(payload["revision"], str) or not re.fullmatch(r"[0-9a-f]{32}", payload["revision"])):
        raise HTTPException(400, "Invalid saved revision")
    name = payload.get("name", "Untitled play")
    if not isinstance(name, str) or not name.strip(NAME_WHITESPACE) or len(name.strip(NAME_WHITESPACE)) > MAX_NAME_LENGTH:
        raise HTTPException(400, f"Play name must be 1-{MAX_NAME_LENGTH} characters")
    players = _markers(payload.get("players", []), "Players", MAX_PLAYERS, player_ratings=True)
    defenders = _markers(payload.get("defenders", []), "Defenders", MAX_DEFENDERS, badge_catalog=ALLOWED_DEFENDER_BADGES)
    ball = payload.get("ball")
    clean_ball = None if ball is None else _point(ball, "Ball")
    raw_arrows = payload.get("arrows", [])
    if not isinstance(raw_arrows, list) or len(raw_arrows) > MAX_ARROWS:
        raise HTTPException(400, f"Arrows must contain at most {MAX_ARROWS} items")
    arrows: list[dict] = []
    arrow_ids: set[str] = set()
    for arrow in raw_arrows:
        if not isinstance(arrow, dict) or not isinstance(arrow.get("id"), str) or not re.fullmatch(r"[a-z0-9-]{1,64}", arrow["id"]):
            raise HTTPException(400, "Arrow ids must be short text labels")
        if arrow["id"] in arrow_ids:
            raise HTTPException(400, "Arrow ids must be unique")
        if not isinstance(arrow.get("kind"), str) or arrow["kind"] not in ALLOWED_ARROW_KINDS:
            raise HTTPException(400, "Arrow kind is not supported")
        arrow_ids.add(arrow["id"])
        sequence = arrow.get("sequence", len(arrows) + 1)
        if not _integer(sequence) or not 1 <= sequence <= MAX_ARROWS:
            raise HTTPException(400, "Arrow sequence must be a positive integer")
        path = arrow.get("path", "straight")
        if not isinstance(path, str) or path not in ALLOWED_ARROW_PATHS:
            raise HTTPException(400, "Arrow path must be straight or curve")
        timing = arrow.get("timing", 1.2)
        if not isinstance(timing, (int, float)) or isinstance(timing, bool) or not 0.5 <= timing <= 4:
            raise HTTPException(400, "Arrow timing must be between 0.5 and 4 seconds")
        control_value = arrow.get("control")
        control = None if control_value is None else _point(control_value, "Arrow control")
        clean_arrow = {"id": arrow["id"], "kind": arrow["kind"], "sequence": sequence, "path": path, "timing": round(float(timing), TIMING_DECIMAL_PLACES), "control": control, "start": _point(arrow.get("start"), "Arrow start"), "end": _point(arrow.get("end"), "Arrow end")}
        if "timingPlan" in arrow:
            plan = arrow["timingPlan"]
            if not isinstance(plan, dict) or not _integer(plan.get("startAtMs")) or not 0 <= plan["startAtMs"] <= 120_000:
                raise HTTPException(400, "Action start time must be 0–120 seconds")
            clean_plan = {"startAtMs": plan["startAtMs"]}
            if "syncId" in plan:
                sync_id = plan["syncId"]
                if not isinstance(sync_id, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", sync_id):
                    raise HTTPException(400, "Synchronization identity is invalid")
                clean_plan["syncId"] = sync_id
            if "waits" in plan:
                waits = plan["waits"]
                if not isinstance(waits, list) or len(waits) > MAX_ARROWS:
                    raise HTTPException(400, "An action can have at most 30 timing waits")
                clean_waits = []
                wait_ids: set[str] = set()
                for wait in waits:
                    if not isinstance(wait, dict) or not isinstance(wait.get("id"), str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", wait["id"]) or wait["id"] in wait_ids:
                        raise HTTPException(400, "Timing wait identities must be unique")
                    if set(wait) - {"id", "actionId", "event", "playerId", "routePhase", "routeSegment", "progress"}:
                        raise HTTPException(400, "Timing wait contains unsupported fields")
                    wait_ids.add(wait["id"])
                    source_id, event = wait.get("actionId"), wait.get("event")
                    if not isinstance(source_id, str) or not re.fullmatch(r"[a-z0-9-]{1,64}", source_id) or source_id == arrow["id"]:
                        raise HTTPException(400, "Timing wait must name a different action")
                    if event not in TIMING_EVENTS:
                        raise HTTPException(400, "Timing wait event is not supported")
                    clean_wait = {"id": wait["id"], "actionId": source_id, "event": event}
                    player_id = wait.get("playerId")
                    if player_id is not None:
                        if not _integer(player_id) or player_id not in {marker["id"] for marker in players}:
                            raise HTTPException(400, "Timing wait player must be on the court")
                        clean_wait["playerId"] = player_id
                    if event == "route-point":
                        phase, segment, progress = wait.get("routePhase"), wait.get("routeSegment"), wait.get("progress")
                        if player_id is None or phase not in TIMING_PHASES or not _integer(segment) or not 0 <= segment <= 63 or not isinstance(progress, (int, float)) or isinstance(progress, bool) or not math.isfinite(progress) or not 0 < progress < 1:
                            raise HTTPException(400, "Route-point waits need a player, route phase, segment, and interior progress value")
                        clean_wait["routePhase"] = phase
                        clean_wait["routeSegment"] = segment
                        clean_wait["progress"] = round(float(progress), 4)
                    elif any(key in wait for key in ("playerId", "routePhase", "routeSegment", "progress")):
                        raise HTTPException(400, "Only route-point waits can specify a player or route progress")
                    clean_waits.append(clean_wait)
                clean_plan["waits"] = clean_waits
            if set(plan) - {"startAtMs", "syncId", "waits"}:
                raise HTTPException(400, "Action timing contains unsupported fields")
            clean_arrow["timingPlan"] = clean_plan
        player_ids = {marker["id"] for marker in players}
        for field in ("actor_id", "recipient_id", "screener_id", "handler_id", "cutter_id"):
            participant = arrow.get(field)
            if participant is not None and (not _integer(participant) or participant not in player_ids):
                raise HTTPException(400, "Action participants must be offensive players")
        if arrow.get("exit_target") is not None:
            _point(arrow["exit_target"], "Screen exit target")
        if arrow["kind"] in {"screen", "slip-screen", "pick-roll", "pick-pop"}:
            screener_id, handler_id = arrow.get("screener_id"), arrow.get("handler_id")
            if arrow["kind"] == "pick-pop" and (screener_id is None or handler_id is None):
                raise HTTPException(400, "Pick and pop actions need screener_id and handler_id")
            if screener_id is not None and (not _integer(screener_id) or screener_id not in player_ids):
                raise HTTPException(400, "On-ball screener must be an offensive player")
            if handler_id is not None and (not _integer(handler_id) or handler_id not in player_ids):
                raise HTTPException(400, "On-ball handler must be an offensive player")
            if screener_id is not None and screener_id == handler_id:
                raise HTTPException(400, "On-ball screen players must be distinct")
            if screener_id is not None:
                clean_arrow["screener_id"] = screener_id
            if handler_id is not None:
                clean_arrow["handler_id"] = handler_id
        if arrow["kind"] in {"off-ball-screen", "pin-down"}:
            screener_id, cutter_id = arrow.get("screener_id"), arrow.get("cutter_id")
            if not _integer(screener_id) or not _integer(cutter_id):
                raise HTTPException(400, "Off-ball screens need screener_id and cutter_id")
            if screener_id == cutter_id or screener_id not in player_ids or cutter_id not in player_ids:
                raise HTTPException(400, "Off-ball screen players must be distinct offensive players")
            clean_arrow["screener_id"] = screener_id
            clean_arrow["cutter_id"] = cutter_id
        for field in ("actor_id", "recipient_id"):
            participant = arrow.get(field)
            if participant is not None:
                if not _integer(participant) or participant not in player_ids:
                    raise HTTPException(400, "Action participants must be offensive players")
                clean_arrow[field] = participant
        if arrow.get("recipient_id") is not None and (arrow["kind"] not in {"pass", "handoff"} or arrow.get("recipient_id") == arrow.get("actor_id")):
            raise HTTPException(400, "Transfer participants must be distinct")
        if arrow["kind"] == "backdoor-cut":
            actor_id = arrow.get("actor_id")
            if not _integer(actor_id) or actor_id not in player_ids:
                raise HTTPException(400, "Backdoor cuts need an offensive actor_id")
            clean_arrow["actor_id"] = actor_id
        if arrow["kind"] in {"pick-pop", "pin-down"}:
            exit_target = _point(arrow.get("exit_target"), "Screen exit target")
            clean_arrow["exit_target"] = exit_target
        arrows.append(clean_arrow)
    defenders_visible = payload.get("defenders_visible", False)
    if not isinstance(defenders_visible, bool):
        raise HTTPException(400, "defenders_visible must be boolean")
    now = _now()
    result = {
        "version": 1,
        "id": playbook_id,
        "name": name.strip(NAME_WHITESPACE),
        "created_at": created_at or now,
        "updated_at": now,
        "defenders_visible": defenders_visible,
        "players": players,
        "defenders": defenders,
        "ball": clean_ball,
        "arrows": arrows,
    }
    raw_branches = payload.get("branches")
    nested_payload = {key: value for key, value in payload.items() if key not in {"roleCues", "spacingGates", "flipbooks", "baitPayoffs"}}
    if raw_branches is not None:
        if not isinstance(raw_branches, list) or len(raw_branches) > MAX_BRANCHES:
            raise HTTPException(400, f"A play can have at most {MAX_BRANCHES} endings")
        branches: list[dict] = []
        branch_ids: set[str] = set()
        for branch in raw_branches:
            if not isinstance(branch, dict) or not isinstance(branch.get("id"), str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", branch["id"]):
                raise HTTPException(400, "Ending identities must be unique short labels")
            branch_id = branch["id"]
            if branch_id in branch_ids:
                raise HTTPException(400, "Ending identities must be unique short labels")
            branch_ids.add(branch_id)
            label = branch.get("label")
            if not isinstance(label, str) or not 1 <= len(label.strip(NAME_WHITESPACE)) <= 40:
                raise HTTPException(400, "Ending labels must contain 1-40 characters")
            fork = branch.get("fork")
            if not isinstance(fork, dict) or not isinstance(fork.get("actionIds"), list) or not 1 <= len(fork["actionIds"]) <= MAX_ARROWS:
                raise HTTPException(400, "Ending fork reference is invalid")
            fork_ids = fork["actionIds"]
            fork_sequence = fork.get("sequence")
            if any(not isinstance(action_id, str) or not re.fullmatch(r"[a-z0-9-]{1,64}", action_id) for action_id in fork_ids) or len(set(fork_ids)) != len(fork_ids):
                raise HTTPException(400, "Ending fork reference is invalid")
            if not _integer(fork_sequence) or not 1 <= fork_sequence <= MAX_ARROWS:
                raise HTTPException(400, "Ending fork sequence is invalid")
            continuation_value = branch.get("continuation")
            if not isinstance(continuation_value, list) or len(continuation_value) > MAX_ARROWS:
                raise HTTPException(400, "Ending actions must contain at most 30 actions")
            continuation = _document({**nested_payload, "arrows": continuation_value, "branches": []}, playbook_id=playbook_id, created_at=created_at, validate_timing_edges=False)["arrows"]
            ordered_main = sorted(enumerate(arrows), key=lambda entry: (entry[1]["sequence"], entry[0]))
            anchor_ids = set(fork_ids)
            anchor_sequences = [arrow["sequence"] for _, arrow in ordered_main if arrow["id"] in anchor_ids]
            if anchor_sequences:
                cutoff = min(anchor_sequences)
            else:
                later = [arrow["sequence"] for _, arrow in ordered_main if arrow["sequence"] >= fork_sequence]
                cutoff = min(later) if later else None
            shared = [arrow for _, arrow in ordered_main if cutoff is None or arrow["sequence"] < cutoff]
            max_shared = max((arrow["sequence"] for arrow in shared), default=0)
            ordered_continuation = sorted(enumerate(continuation), key=lambda entry: (entry[1]["sequence"], entry[0]))
            continuation_groups = list(dict.fromkeys(arrow["sequence"] for _, arrow in ordered_continuation))
            rebased_sequence = {sequence: max_shared + index + 1 for index, sequence in enumerate(continuation_groups)}
            resolved = shared + [{**arrow, "sequence": rebased_sequence[arrow["sequence"]]} for _, arrow in ordered_continuation]
            if len(resolved) > MAX_ARROWS:
                raise HTTPException(400, "Each resolved ending must contain at most 30 actions")
            _document({**nested_payload, "arrows": resolved, "branches": []}, playbook_id=playbook_id, created_at=created_at)
            if validate_timing_edges:
                _validate_timing_path(resolved)
                shared_ids = {arrow["id"] for arrow in shared}
                shared_sync = {arrow["timingPlan"]["syncId"] for arrow in shared if arrow.get("timingPlan", {}).get("syncId")}
                continuation_sync = {arrow["timingPlan"]["syncId"] for arrow in continuation if arrow.get("timingPlan", {}).get("syncId") and arrow["id"] not in shared_ids}
                if shared_sync & continuation_sync:
                    raise HTTPException(400, "Pinned actions cannot cross a shared-opening boundary")
            branches.append({"id": branch_id, "label": label.strip(NAME_WHITESPACE), "fork": {"actionIds": list(fork_ids), "sequence": fork_sequence}, "continuation": continuation})
        if branches:
            result["branches"] = branches
    if "readCoach" in payload:
        result["readCoach"] = _read_coach(payload["readCoach"], playbook_id)
    if "roleCues" in payload:
        result["roleCues"] = _role_cues(payload["roleCues"], players, arrows, result.get("branches", []))
    if "spacingGates" in payload:
        result["spacingGates"] = _spacing_gates(payload["spacingGates"], players, arrows, result.get("branches", []))
    if "flipbooks" in payload:
        result["flipbooks"] = _flipbooks(payload["flipbooks"], playbook_id, players, result.get("branches", []))
    if "baitPayoffs" in payload:
        result["baitPayoffs"] = _bait_payoffs(payload["baitPayoffs"], players, defenders, arrows, result.get("branches", []))
    if validate_timing_edges:
        _validate_timing_path(result["arrows"])
    return result


def _check_json_depth(text: str) -> None:
    depth = 0
    quoted = escaped = False
    for character in text:
        if quoted:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                quoted = False
        elif character == '"':
            quoted = True
        elif character in "[{":
            depth += 1
            if depth > MAX_JSON_DEPTH:
                raise ValueError("Playbook JSON exceeds the nesting limit of 32")
        elif character in "]}":
            depth -= 1


async def _request_document(request: Request) -> dict:
    # A dependency, rather than a Body parameter: FastAPI must not parse or
    # buffer the entire request before enforcing the received-byte budget.
    content = bytearray()
    async for chunk in request.stream():
        if len(content) + len(chunk) > MAX_DOCUMENT_BYTES:
            raise HTTPException(413, "Playbook JSON exceeds the 256 KiB document limit")
        content.extend(chunk)
    try:
        text = content.decode("utf-8-sig")
        _check_json_depth(text)
        value = json.loads(text)
    except (ValueError, RecursionError) as error:
        raise HTTPException(400, "Playbook JSON is invalid or exceeds the nesting limit of 32") from error
    if not isinstance(value, dict):
        raise HTTPException(400, "Playbook must be an object")
    return value


def _read_legacy(path: Path, *, include_creation: bool = False) -> dict:
    try:
        with path.open("rb") as stream:
            content = stream.read(MAX_SAVED_FILE_BYTES + 1)
        if len(content) > MAX_SAVED_FILE_BYTES:
            raise ValueError("Saved play exceeds its byte limit")
        text = content.decode("utf-8-sig")
        _check_json_depth(text)
        value = json.loads(text)
    except OSError as error:
        raise HTTPException(503, "Playbook storage is temporarily unavailable; retry") from error
    except (ValueError, TypeError) as error:
        raise HTTPException(500, "Saved play could not be read") from error
    if not isinstance(value, dict):
        raise HTTPException(500, "Saved play is invalid")
    try:
        if not isinstance(value.get("id"), str) or not value["id"] or not isinstance(value.get("name"), str) or any(not isinstance(value.get(field), list) for field in ("players", "defenders", "arrows")):
            raise HTTPException(400, "Saved play is incomplete")
        if value["id"] != path.stem:
            raise HTTPException(400, "Saved play identity does not match its filename")
        _document(value, playbook_id=value["id"])
    except HTTPException as error:
        raise HTTPException(500, "Saved play is invalid") from error
    if not include_creation:
        value.pop("_creation", None)
        value.pop("_history", None)
    return value


def _sync_directory(path: Path) -> None:
    # Python's Windows file API cannot open directories for fsync. On other
    # platforms, ignore only explicit lack of filesystem support, never I/O errors.
    if os.name == "nt":
        return
    descriptor: int | None = None
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        os.fsync(descriptor)
    except OSError as error:
        if error.errno not in {errno.EINVAL, errno.ENOTSUP, errno.EOPNOTSUPP, errno.ENOSYS}:
            raise
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _sync_file(path: Path) -> None:
    with path.open("rb") as stream:
        os.fsync(stream.fileno())


def _uncertain_file_operation(operation: str) -> HTTPException:
    return HTTPException(503, f"The play may have been {operation}, but storage synchronization could not be confirmed · Refresh the saved library before retrying", headers={"X-ARC-Playbook-Outcome": "uncertain"})


def _write(path: Path, value: dict) -> None:
    temporary: Path | None = None
    replacing = False
    content = json.dumps(value, indent=2, allow_nan=False) + "\n"
    if len(content.encode("utf-8")) > MAX_SAVED_FILE_BYTES:
        raise HTTPException(413, "Saved-play history exceeds the file byte limit · Stored data has been preserved")
    try:
        _check_json_depth(content)
    except ValueError as error:
        raise HTTPException(400, "Saved-play history exceeds the nesting limit · Stored data has been preserved") from error
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, prefix=".playbook-", delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        replacing = True
        os.replace(temporary, path)
        _sync_directory(path.parent)
    except OSError as error:
        if replacing:
            raise _uncertain_file_operation("saved") from error
        raise HTTPException(500, "Playbook could not be saved") from error
    finally:
        if temporary is not None:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass  # Never replace the operation's outcome with a cleanup error.


def _delete_file(path: Path, *, retain_receipt: bool) -> None:
    changing = False
    try:
        if retain_receipt:
            _sync_file(path)
            deleted = path.parent / ".deleted"
            deleted.mkdir(parents=True, exist_ok=True)
            changing = True
            os.replace(path, deleted / path.name)
            _sync_directory(deleted)
        else:
            changing = True
            path.unlink()
        _sync_directory(path.parent)
    except OSError as error:
        if changing:
            raise _uncertain_file_operation("deleted") from error
        raise HTTPException(500, "Playbook could not be deleted") from error


def _checksum(value: object) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode("utf-8")).hexdigest()


def _revision_path(playbook_id: str, revision: str) -> Path:
    _path(playbook_id)
    if not isinstance(revision, str) or not re.fullmatch(r"[a-f0-9]{32}", revision):
        raise HTTPException(500, HISTORY_ERROR)
    return PLAYBOOKS_DIR / ".revisions" / playbook_id / f"{revision}.json"


def _raw_record(path: Path) -> dict:
    try:
        with path.open("rb") as stream:
            raw = stream.read(MAX_SAVED_FILE_BYTES + 1)
        if len(raw) > MAX_SAVED_FILE_BYTES:
            raise ValueError("oversized history")
        text = raw.decode("utf-8-sig")
        _check_json_depth(text)
        result = json.loads(text)
        if not isinstance(result, dict):
            raise ValueError("invalid record")
        return result
    except OSError as error:
        raise HTTPException(503, "Playbook storage is temporarily unavailable; retry") from error
    except (ValueError, TypeError) as error:
        raise HTTPException(500, HISTORY_ERROR) from error


def _ref(entry: dict) -> dict:
    return {"revision": entry["revision"], "checksum": entry["checksum"]}


def _validate_ref(value: object) -> None:
    if not isinstance(value, dict) or set(value) != {"revision", "checksum"} or not isinstance(value["revision"], str) or not re.fullmatch(r"[a-f0-9]{32}", value["revision"]) or not isinstance(value["checksum"], str) or not re.fullmatch(r"[a-f0-9]{64}", value["checksum"]):
        raise HTTPException(500, HISTORY_ERROR)


def _read_revision(playbook_id: str, reference: dict) -> dict:
    _validate_ref(reference)
    try:
        value = _raw_record(_revision_path(playbook_id, reference["revision"]))
    except HTTPException as error:
        if isinstance(error.__cause__, FileNotFoundError):
            raise HTTPException(500, HISTORY_ERROR) from error
        raise
    try:
        if set(value) != {"version", "id", "revision", "parent", "kind", "document", "creation", "checksum"} or value["version"] != 1 or value["id"] != playbook_id or _ref(value) != reference or value["kind"] not in {"save", "delete"}:
            raise ValueError()
        if value["parent"] is not None:
            _validate_ref(value["parent"])
        if _checksum({key: item for key, item in value.items() if key != "checksum"}) != value["checksum"]:
            raise ValueError()
        if value["kind"] == "delete":
            if value["document"] is not None:
                raise ValueError()
        else:
            document = value["document"]
            if not isinstance(document, dict) or document.get("id") != playbook_id or document.get("revision", value["revision"]) != value["revision"]:
                raise ValueError()
            _document(document, playbook_id=playbook_id)
            if any(not isinstance(document.get(key), str) or not document[key] for key in ("created_at", "updated_at")):
                raise ValueError()
        if value["creation"] is not None:
            receipt = value["creation"]
            if not isinstance(receipt, dict) or not isinstance(receipt.get("result"), dict) or receipt["result"].get("id") != playbook_id or _creation_request(_document(receipt["result"], playbook_id=playbook_id)) != receipt.get("request"):
                raise ValueError()
    except (KeyError, TypeError, ValueError, HTTPException) as error:
        raise HTTPException(500, HISTORY_ERROR) from error
    return value


def _head_payload(value: dict) -> dict:
    return {key: item for key, item in value.items() if key != "_history"} | {"_history": {key: item for key, item in value["_history"].items() if key != "checksum"}}


def _verify_head(value: dict, *, deleted: bool) -> list[dict]:
    try:
        history = value["_history"]
        if set(history) != {"version", "entries", "anchor", "deleted", "checksum"} or history["version"] != 1 or history["deleted"] is not deleted or _checksum(_head_payload(value)) != history["checksum"]:
            raise ValueError()
        references = history["entries"]
        if not isinstance(references, list) or not 1 <= len(references) <= HISTORY_LIMIT:
            raise ValueError()
        parent = history["anchor"]
        if parent is not None:
            _validate_ref(parent)
        seen = {parent["revision"]} if parent else set()
        entries = []
        for reference in references:
            entry = _read_revision(value["id"], reference)
            if entry["parent"] != parent or entry["revision"] in seen:
                raise ValueError()
            seen.add(entry["revision"])
            entries.append(entry)
            parent = reference
        tail = entries[-1]
        public = {key: item for key, item in value.items() if key not in {"_creation", "_history"}}
        if (tail["kind"] == "delete") != deleted or (not deleted and tail["document"] != public) or tail["creation"] != value.get("_creation"):
            raise ValueError()
        return entries
    except (KeyError, ValueError, TypeError) as error:
        raise HTTPException(500, HISTORY_ERROR) from error


def _read(path: Path, *, include_creation: bool = False) -> dict:
    value = _read_legacy(path, include_creation=True)
    if "_history" in value:
        _verify_head(value, deleted=path.parent.name == ".deleted")
    if not include_creation:
        value.pop("_creation", None)
        value.pop("_history", None)
    return value


def _publish_revision(playbook_id: str, document: dict | None, creation: dict | None, parent: dict | None, revision: str | None = None) -> dict:
    payload = {"version": 1, "id": playbook_id, "revision": revision or uuid.uuid4().hex, "parent": parent,
               "kind": "delete" if document is None else "save", "document": document, "creation": creation}
    value = {**payload, "checksum": _checksum(payload)}
    path = _revision_path(playbook_id, value["revision"])
    if path.exists():
        if _read_revision(playbook_id, _ref(value)) != value:
            raise HTTPException(500, HISTORY_ERROR)
    else:
        _write(path, value)
        # Newly created directory entries also need barriers before a head may
        # depend on their contents. Existing directories use the same barriers.
        try:
            _sync_directory(path.parent.parent)
            _sync_directory(PLAYBOOKS_DIR)
        except OSError as error:
            raise _uncertain_file_operation("saved") from error
    _read_revision(playbook_id, _ref(value))
    return _ref(value)


def _commit_revision(path: Path, stored: dict, current: dict | None = None, *, deleted: bool = False) -> None:
    playbook_id = stored["id"]
    entries, anchor = [], None
    if current is not None:
        if "_history" in current:
            entries = list(current["_history"]["entries"])
            anchor = current["_history"]["anchor"]
        else:
            document = {key: item for key, item in current.items() if key != "_creation"}
            document = {**document, "version": 1, "defenders_visible": current.get("defenders_visible", False),
                        "created_at": current.get("created_at", "1970-01-01T00:00:00+0000"), "updated_at": current.get("updated_at", "1970-01-01T00:00:00+0000")}
            entries.append(_publish_revision(playbook_id, document, current.get("_creation"), None, current.get("revision")))
    document = None if deleted else {key: item for key, item in stored.items() if key not in {"_creation", "_history"}}
    entries.append(_publish_revision(playbook_id, document, stored.get("_creation"), entries[-1] if entries else None, None if deleted else document.get("revision")))
    if len(entries) > HISTORY_LIMIT:
        anchor = entries.pop(0)
    head = {key: item for key, item in stored.items() if key != "_history"}
    head["_history"] = {"version": 1, "entries": entries, "anchor": anchor, "deleted": deleted}
    head["_history"]["checksum"] = _checksum(_head_payload(head))
    _verify_head(head, deleted=deleted)
    _write(path, head)  # This atomic, durable head replacement is the commit.
    # Retention is after commit. Never remove unreadable or corrupt records, or
    # allow a cleanup failure to turn an acknowledged commit into a failed save.
    retained = {entry["revision"] for entry in entries}
    try:
        for candidate in (PLAYBOOKS_DIR / ".revisions" / playbook_id).glob("*.json"):
            if candidate.stem in retained:
                continue
            try:
                raw = _raw_record(candidate)
                if raw.get("revision") != candidate.stem:
                    continue
                _read_revision(playbook_id, _ref(raw))
                candidate.unlink()
            except (HTTPException, OSError, KeyError):
                pass
    except OSError:
        pass


def _deleted_path(path: Path) -> Path:
    return PLAYBOOKS_DIR / ".deleted" / path.name


def _confirm_head(path: Path) -> dict:
    value = _read(path, include_creation=True)
    try:
        if "_history" in value:
            for reference in value["_history"]["entries"]:
                _sync_file(_revision_path(value["id"], reference["revision"]))
            _sync_directory(PLAYBOOKS_DIR / ".revisions" / value["id"])
            _sync_directory(PLAYBOOKS_DIR / ".revisions")
        _sync_file(path)
        _sync_directory(path.parent)
        _sync_directory(PLAYBOOKS_DIR)
    except OSError as error:
        raise _uncertain_file_operation("saved") from error
    return {key: item for key, item in value.items() if key not in {"_creation", "_history"}}


@contextmanager
def _playbook_lock(path: Path):
    """Cross-thread/process transaction lock; keep the inode after release.

    Unlinking a lock file would let a waiter and a new client lock different
    inodes for the same play. Atomic JSON replacement remains in _write.
    """
    try:
        directory = path.parent / ".locks"
        directory.mkdir(parents=True, exist_ok=True)
        lock = (directory / f"{path.stem}.lock").open("a+b")
    except OSError as error:
        raise HTTPException(503, "Playbook storage is busy or unavailable; retry") from error
    with lock:
        try:
            if os.name == "nt":
                import msvcrt
                if os.fstat(lock.fileno()).st_size == 0:
                    lock.write(b"\0")
                    lock.flush()
                lock.seek(0)
            else:
                import fcntl
            deadline = time.monotonic() + PLAYBOOK_LOCK_TIMEOUT_SECONDS
            while True:
                if time.monotonic() >= deadline:
                    raise HTTPException(503, "Playbook storage is busy or unavailable; retry")
                try:
                    if os.name == "nt":
                        lock.seek(0)
                        msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
                    else:
                        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except OSError as error:
                    if error.errno == errno.EINTR:
                        continue
                    busy = {errno.EAGAIN, errno.EWOULDBLOCK}
                    if os.name == "nt":
                        busy.update({errno.EACCES, errno.EDEADLK})
                    if error.errno not in busy:
                        raise
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise
                    time.sleep(min(PLAYBOOK_LOCK_POLL_SECONDS, remaining))
        except OSError as error:
            raise HTTPException(503, "Playbook storage is busy or unavailable; retry") from error
        try:
            # A descheduled waiter may acquire an available lock after expiry.
            # Release it without entering the transaction in that case.
            if time.monotonic() >= deadline:
                raise HTTPException(503, "Playbook storage is busy or unavailable; retry")
            yield
        finally:
            if os.name == "nt":
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def _saved_play_instant(value: object) -> int | float:
    """UTC nanoseconds, matching the browser's supported ISO timestamp forms."""
    if not isinstance(value, str):
        return -math.inf
    match = re.fullmatch(r"([0-9]{4})-([0-9]{2})-([0-9]{2})(?:T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,9}))?(Z|[+-][0-9]{2}:?[0-9]{2}))?", value)
    if not match:
        return -math.inf
    year, month, day, hour, minute, second, fraction, zone = match.groups()
    try:
        date = datetime(int(year), int(month), int(day), int(hour or 0), int(minute or 0), int(second or 0))
        delta = date - datetime(1970, 1, 1)
        nanoseconds = (delta.days * 86400 + delta.seconds) * 1_000_000_000 + int((fraction or "").ljust(9, "0"))
        if zone and zone != "Z":
            digits = zone[1:].replace(":", "")
            hours, minutes = int(digits[:2]), int(digits[2:])
            if hours > 23 or minutes > 59:
                return -math.inf
            nanoseconds -= (hours * 60 + minutes) * (1 if zone[0] == "+" else -1) * 60_000_000_000
        return nanoseconds
    except ValueError:
        return -math.inf


@router.get("")
def list_playbooks(response: Response) -> list[dict]:
    response.headers["X-ARC-Playbook-Extensions"] = "branches-v1,timing-v1,read-coach-v1,role-rehearsal-v1,spacing-gates-v1,play-flipbook-v1,bait-payoff-v1,chalk-talk-v1"
    try:
        PLAYBOOKS_DIR.mkdir(parents=True, exist_ok=True)
        paths = sorted(PLAYBOOKS_DIR.iterdir())
    except OSError as error:
        raise HTTPException(503, "Playbook storage is temporarily unavailable; retry") from error
    result: list[dict] = []
    issues: list[dict[str, str]] = []
    for path in paths:
        if not path.name.endswith(".json"):
            continue
        try:
            with _playbook_lock(path):
                if not path.is_file() or _deleted_path(path).exists():
                    continue  # A deletion completed after directory enumeration.
                value = _read(path)
        except (HTTPException, OSError) as error:
            kind = "unavailable" if isinstance(error, OSError) or error.status_code == 503 else "invalid"
            issues.append({"file": path.name, "kind": kind})
            continue
        result.append(value)
    response.headers["X-ARC-Playbook-Status"] = "partial" if issues else "complete"
    if issues:
        response.headers["X-ARC-Playbook-Warnings"] = ", ".join(issue["file"] for issue in issues)
        response.headers["X-ARC-Playbook-Issues"] = json.dumps(issues, separators=(",", ":"))
    result.sort(key=lambda item: (-_saved_play_instant(item.get("updated_at")), item["id"]))
    return result


def _creation_request(value: dict) -> str:
    return json.dumps({key: item for key, item in value.items() if key not in {"id", "created_at", "updated_at", "revision"}}, sort_keys=True, separators=(",", ":"))


def _replay_creation(path: Path, request: str) -> dict:
    stored = _read(path, include_creation=True)
    receipt = stored.get("_creation")
    if not isinstance(receipt, dict) or receipt.get("request") != request:
        raise HTTPException(409, "This creation identity is already in use for a different drawing")
    result = receipt.get("result")
    if not isinstance(result, dict) or result.get("id") != stored["id"] or result.get("version") != 1:
        raise HTTPException(500, "The creation receipt could not be read")
    try:
        if _creation_request(_document(result, playbook_id=stored["id"])) != request:
            raise HTTPException(400, "Invalid receipt content")
        if any(not isinstance(result.get(key), str) or not result[key] for key in ("created_at", "updated_at")):
            raise HTTPException(400, "Invalid receipt timestamps")
    except HTTPException as error:
        raise HTTPException(500, "The creation receipt could not be read") from error
    # A retry must not bypass synchronization after an earlier ambiguous save
    # or tombstone move. Validate first; never rewrite the original receipt.
    _confirm_head(path)
    return result


@router.post("")
def create_playbook(payload: Annotated[dict, Depends(_request_document)], create_id: Annotated[str | None, Header(alias="X-ARC-Create-ID")] = None, extensions: Annotated[str | None, Header(alias="X-ARC-Playbook-Extensions")] = None) -> dict:
    supported = _extension_set(extensions)
    if payload.get("branches") and "branches-v1" not in supported:
        raise HTTPException(409, "This server requires a branch-aware client before saving endings")
    if _has_timing(payload) and "timing-v1" not in supported:
        raise HTTPException(409, "This server requires a timing-aware client before saving action schedules")
    if _has_read_coach(payload) and "read-coach-v1" not in supported:
        raise HTTPException(409, "This server requires a Read Coach-aware client before saving lessons")
    if _has_role_cues(payload) and "role-rehearsal-v1" not in supported:
        raise HTTPException(409, "This server requires a My Role-aware client before saving cue wording")
    if _has_spacing_gates(payload) and "spacing-gates-v1" not in supported:
        raise HTTPException(409, "This server requires a spacing-gate-aware client before saving spacing instructions")
    if _has_flipbooks(payload) and "play-flipbook-v1" not in supported:
        raise HTTPException(409, "This server requires a Play Flipbook-aware client before saving walkthroughs")
    if _has_bait_payoffs(payload) and "bait-payoff-v1" not in supported:
        raise HTTPException(409, "This server requires a Bait & Payoff-aware client before saving connections")
    if _has_chalk_talk(payload) and "chalk-talk-v1" not in supported:
        raise HTTPException(409, "This server requires a Chalk Talk-aware client before saving panel annotations")
    if create_id is not None and not re.fullmatch(r"play-[0-9a-f]{32}", create_id):
        raise HTTPException(400, "Invalid create identity")
    playbook_id = create_id or f"play-{uuid.uuid4().hex[:12]}"
    value = {**_document(payload, playbook_id=playbook_id), "revision": uuid.uuid4().hex}
    path = _path(playbook_id)
    with _playbook_lock(path):
        request = _creation_request(value)
        deleted = PLAYBOOKS_DIR / ".deleted" / path.name
        if path.exists() or deleted.exists():
            if create_id is not None:
                return _replay_creation(deleted if deleted.exists() else path, request)
            raise HTTPException(409, "This creation identity is already in use")
        # One atomic file replacement commits both the drawing and original
        # result. Keep the private receipt through edits and deletion.
        stored = {**value, "_creation": {"request": request, "result": value}} if create_id else value
        _commit_revision(path, stored)
    return value


@router.get("/{playbook_id}")
def get_playbook(playbook_id: str) -> dict:
    path = _path(playbook_id)
    with _playbook_lock(path):
        if _deleted_path(path).exists():
            _confirm_head(_deleted_path(path))
            raise HTTPException(404, "Playbook not found")
        if not path.is_file():
            raise HTTPException(404, "Playbook not found")
        return _confirm_head(path)


@router.put("/{playbook_id}")
def update_playbook(playbook_id: str, payload: Annotated[dict, Depends(_request_document)], if_match: Annotated[str | None, Header(alias="If-Match")] = None, extensions: Annotated[str | None, Header(alias="X-ARC-Playbook-Extensions")] = None) -> dict:
    path = _path(playbook_id)
    with _playbook_lock(path):
        if _deleted_path(path).exists() or not path.is_file():
            raise HTTPException(404, "Playbook not found")
        current = _read(path, include_creation=True)
        current_has_branches = bool(current.get("branches"))
        supported = _extension_set(extensions)
        if current_has_branches and ("branches-v1" not in supported or "branches" not in payload):
            raise HTTPException(409, "This play contains endings and requires an explicit branch-aware update · The saved play is unchanged")
        if payload.get("branches") and "branches-v1" not in supported:
            raise HTTPException(409, "This play contains endings and requires a branch-aware client · The saved play is unchanged")
        current_has_timing = _has_timing(current)
        if current_has_timing and ("timing-v1" not in supported or not _has_timing(payload)):
            raise HTTPException(409, "This play contains action timing and requires a timing-aware update · The saved play is unchanged")
        if _has_timing(payload) and "timing-v1" not in supported:
            raise HTTPException(409, "This server requires a timing-aware client before saving action schedules")
        current_has_read_coach = _has_read_coach(current)
        if current_has_read_coach and ("read-coach-v1" not in supported or not _has_read_coach(payload)):
            raise HTTPException(409, "This play contains Read Coach lessons and requires an explicit Read Coach-aware update · The saved play is unchanged")
        if _has_read_coach(payload) and "read-coach-v1" not in supported:
            raise HTTPException(409, "This server requires a Read Coach-aware client before saving lessons")
        current_has_role_cues = _has_role_cues(current)
        if current_has_role_cues and ("role-rehearsal-v1" not in supported or "roleCues" not in payload):
            raise HTTPException(409, "This play contains My Role cue wording and requires an explicit My Role-aware update · The saved play is unchanged")
        if "roleCues" in payload and "role-rehearsal-v1" not in supported:
            raise HTTPException(409, "This server requires a My Role-aware client before saving cue wording")
        if _has_role_cues(payload) and "role-rehearsal-v1" not in supported:
            raise HTTPException(409, "This server requires a My Role-aware client before saving cue wording")
        current_has_spacing_gates = _has_spacing_gates(current)
        if current_has_spacing_gates and ("spacing-gates-v1" not in supported or "spacingGates" not in payload):
            raise HTTPException(409, "This play contains spacing gates and requires an explicit spacing-gate-aware update · The saved play is unchanged")
        if "spacingGates" in payload and "spacing-gates-v1" not in supported:
            raise HTTPException(409, "This server requires a spacing-gate-aware client before saving spacing instructions")
        current_has_flipbooks = _has_flipbooks(current)
        if current_has_flipbooks and ("play-flipbook-v1" not in supported or not _has_flipbooks(payload)):
            raise HTTPException(409, "This play contains walkthroughs and requires an explicit Flipbook-aware update · The saved play is unchanged")
        if "flipbooks" in payload and "play-flipbook-v1" not in supported:
            raise HTTPException(409, "This server requires a Play Flipbook-aware client before saving walkthroughs")
        if _has_flipbooks(payload) and "play-flipbook-v1" not in supported:
            raise HTTPException(409, "This server requires a Play Flipbook-aware client before saving walkthroughs")
        current_has_bait_payoffs = _has_bait_payoffs(current)
        if current_has_bait_payoffs and ("bait-payoff-v1" not in supported or "baitPayoffs" not in payload):
            raise HTTPException(409, "This play contains Bait & Payoff connections and requires an explicit Bait & Payoff-aware update · The saved play is unchanged")
        if "baitPayoffs" in payload and "bait-payoff-v1" not in supported:
            raise HTTPException(409, "This server requires a Bait & Payoff-aware client before saving connections")
        current_has_chalk_talk = _has_chalk_talk(current)
        if current_has_chalk_talk and ("chalk-talk-v1" not in supported or not _has_chalk_talk(payload)):
            raise HTTPException(409, "This play contains Chalk Talk annotations and requires an explicit Chalk Talk-aware update · The saved play is unchanged")
        if _has_chalk_talk(payload) and "chalk-talk-v1" not in supported:
            raise HTTPException(409, "This server requires a Chalk Talk-aware client before saving panel annotations")
        # Compare inside the same transaction as replacement. Legacy documents
        # get one explicit precondition until their first revisioned save.
        if if_match is None:
            raise HTTPException(428, "A saved revision is required before updating this play · Reopen it and retry; your draft is still in memory")
        if not re.fullmatch(r'"(?:[0-9a-f]{32}|legacy)"', if_match):
            raise HTTPException(400, "Invalid saved revision precondition")
        if if_match != f'"{current.get("revision", "legacy")}"':
            raise HTTPException(409, SAVE_CONFLICT)
        value = _document(payload, playbook_id=playbook_id, created_at=str(current.get("created_at", _now())))
        connection_error = _timing_source_change(current, value)
        if connection_error:
            raise HTTPException(409, connection_error)
        value["revision"] = uuid.uuid4().hex
        stored = {**value, "_creation": current["_creation"]} if "_creation" in current else value
        _commit_revision(path, stored, current)
        return value


@router.delete("/{playbook_id}")
def delete_playbook(playbook_id: str) -> dict:
    path = _path(playbook_id)
    with _playbook_lock(path):
        deleted = _deleted_path(path)
        if deleted.exists():
            _confirm_head(deleted)
            return {"deleted": True, "id": playbook_id}
        if not path.is_file():
            raise HTTPException(404, "Playbook not found")
        current = _read(path, include_creation=True)
        try:
            _sync_file(path)
        except OSError as error:
            raise HTTPException(500, "Playbook could not be deleted") from error
        # Publish the durable tombstone first. Even if cleanup is interrupted,
        # every reader and writer gives this record priority over the old head.
        try:
            _commit_revision(deleted, current, current, deleted=True)
        except HTTPException as error:
            if error.headers and error.headers.get("X-ARC-Playbook-Outcome") == "uncertain":
                raise _uncertain_file_operation("deleted") from error
            raise
        _delete_file(path, retain_receipt=False)
        return {"deleted": True, "id": playbook_id}


@router.get("/{playbook_id}/history")
def playbook_history(playbook_id: str) -> dict:
    path = _path(playbook_id)
    with _playbook_lock(path):
        deleted = _deleted_path(path)
        head = deleted if deleted.exists() else path
        value = None
        if head.exists():
            try:
                value = _raw_record(head)
            except HTTPException as error:
                if error.status_code == 503:
                    raise  # Storage access failure is not proof of corruption.
        directory = PLAYBOOKS_DIR / ".revisions" / playbook_id
        if value is None and not directory.is_dir():
            raise HTTPException(404, "Saved-play history not found")
        # Legacy reads stay lossless and read-only. Their first accepted mutation
        # publishes this baseline as an immutable revision in the transaction.
        if value is not None and "_history" not in value:
            document = _read(head)
            revision = document.get("revision") or _checksum(document)[:32]
            return {"id": playbook_id, "integrity": "verified", "deleted": head == deleted,
                    "revisions": [{"revision": revision, "parent": None, "checksum": _checksum(document),
                                   "kind": "save", "valid": True, "committed": True, "document": document}]}
        verified, committed = False, set()
        try:
            _read(head)
            verified = True
        except HTTPException:
            pass
        references = []
        if value and value.get("id") == playbook_id and isinstance(value.get("_history"), dict):
            history = value["_history"]
            if isinstance(history.get("entries"), list) and len(history["entries"]) <= HISTORY_LIMIT:
                references = list(history["entries"])
                try:
                    if _checksum(_head_payload(value)) == history.get("checksum"):
                        committed = {reference.get("revision") for reference in references if isinstance(reference, dict)}
                except (ValueError, TypeError):
                    pass
        # Orphans are explicit diagnostic records, never automatic recovery or
        # current documents. Even a malformed head can leave usable immutable
        # evidence. Bound inspection without deleting any additional records.
        known = {reference.get("revision") for reference in references if isinstance(reference, dict)}
        try:
            candidates = sorted(directory.glob("*.json"))
        except OSError as error:
            raise HTTPException(503, "Playbook storage is temporarily unavailable; retry") from error
        if len(candidates) > HISTORY_LIMIT + 24:
            raise HTTPException(500, "Too many abandoned revisions to inspect safely · Stored records have been preserved for manual recovery")
        for candidate in candidates:
            if candidate.stem in known:
                continue
            try:
                raw = _raw_record(candidate)
                if raw.get("revision") != candidate.stem:
                    raise KeyError("Mismatched revision filename")
                references.append(_ref(raw))
            except (HTTPException, KeyError):
                references.append({"revision": candidate.stem, "checksum": ""})
        revisions = []
        for reference in references:
            entry = None
            try:
                entry = _read_revision(playbook_id, reference)
            except HTTPException:
                pass
            revision = reference.get("revision", "") if isinstance(reference, dict) else ""
            revisions.append({"revision": revision,
                              "checksum": reference.get("checksum", "") if isinstance(reference, dict) else "",
                              "parent": entry["parent"]["revision"] if entry and entry["parent"] else None,
                              "kind": entry["kind"] if entry else "save", "valid": entry is not None,
                              "committed": True if revision in committed else (None if value is None else False),
                              **({"document": entry["document"]} if entry and entry["document"] is not None else {})})
        return {"id": playbook_id, "integrity": "verified" if verified else "damaged",
                "deleted": head == deleted if verified else None, "revisions": revisions}

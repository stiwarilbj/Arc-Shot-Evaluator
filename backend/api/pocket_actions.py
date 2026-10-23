"""Private, versioned persistence for reusable Playbook combinations."""
from __future__ import annotations

import json
import math
import os
import re
import tempfile
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Header, HTTPException, Request

from backend.api.playbooks import _playbook_lock
from backend.config import POCKET_ACTIONS_DIR

router = APIRouter(prefix="/api/pocket-actions", tags=["pocket-actions"])
POCKET_ID = re.compile(r"^pocket-[a-z0-9-]{8,72}$")
ACTION_ID = re.compile(r"^pact-[a-z0-9-]{1,48}$")
ROLE_ID = re.compile(r"^role-[a-z0-9-]{1,32}$")
KINDS = {"movement", "pass", "screen", "slip-screen", "handoff", "pick-roll", "pick-pop", "off-ball-screen", "pin-down", "backdoor-cut"}
EVENTS = {"start", "complete", "catch", "screen-set", "screen-use", "route-point"}
PHASES = {"main", "approach", "use", "release"}
FIELDS = {"id", "version", "revision", "name", "createdAt", "updatedAt", "roles", "actions", "requiredBallRole", "summary", "starter"}
MAX_BYTES = 256 * 1024


def _path(pocket_id: str) -> Path:
    if not POCKET_ID.fullmatch(pocket_id):
        raise HTTPException(400, "Invalid pocket action identity")
    return POCKET_ACTIONS_DIR / f"{pocket_id}.json"


def _point(value: object, label: str) -> dict[str, float]:
    if not isinstance(value, dict):
        raise HTTPException(400, f"{label} must be a court point")
    points: dict[str, float] = {}
    for axis in ("x", "y"):
        raw = value.get(axis)
        if isinstance(raw, bool) or not isinstance(raw, (int, float)) or not math.isfinite(raw) or not 0 <= raw <= 100:
            raise HTTPException(400, f"{label} must stay inside the court")
        points[axis] = round(float(raw), 4)
    return points


def _validate(value: object) -> dict:
    if not isinstance(value, dict) or set(value) - FIELDS:
        raise HTTPException(400, "Pocket action has an invalid document shape")
    pocket_id = value.get("id")
    if not isinstance(pocket_id, str) or not POCKET_ID.fullmatch(pocket_id):
        raise HTTPException(400, "Invalid pocket action identity")
    if value.get("version") != 1 or not isinstance(value.get("revision"), str) or not 1 <= len(value["revision"]) <= 128:
        raise HTTPException(400, "Unsupported pocket action version")
    name = value.get("name")
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 60:
        raise HTTPException(400, "Pocket action names must contain 1-60 characters")
    def valid_timestamp(raw: object) -> bool:
        if not isinstance(raw, str) or not raw:
            return False
        try:
            datetime.fromisoformat(raw.replace("Z", "+00:00"))
            return True
        except ValueError:
            return False
    if not valid_timestamp(value.get("createdAt")) or not valid_timestamp(value.get("updatedAt")):
        raise HTTPException(400, "Pocket timestamps are required")
    if value.get("summary") is not None and (not isinstance(value["summary"], str) or len(value["summary"]) > 300) or value.get("starter") is not None and not isinstance(value["starter"], bool):
        raise HTTPException(400, "Pocket metadata is invalid")
    raw_roles, raw_actions = value.get("roles"), value.get("actions")
    if not isinstance(raw_roles, list) or not 1 <= len(raw_roles) <= 5 or not isinstance(raw_actions, list) or not 1 <= len(raw_actions) <= 30:
        raise HTTPException(400, "Pocket actions need one to five roles and one to thirty actions")
    roles: list[dict] = []
    role_ids: set[str] = set()
    for raw in raw_roles:
        if not isinstance(raw, dict) or set(raw) - {"id", "label", "entry", "sourcePlayerId"}:
            raise HTTPException(400, "Pocket role has an invalid document shape")
        role_id, label = raw.get("id"), raw.get("label")
        if not isinstance(role_id, str) or not ROLE_ID.fullmatch(role_id) or role_id in role_ids or not isinstance(label, str) or not 1 <= len(label.strip()) <= 40:
            raise HTTPException(400, "Pocket role identity or label is invalid")
        role_ids.add(role_id)
        role = {"id": role_id, "label": label.strip(), "entry": _point(raw.get("entry"), "Pocket role entry")}
        source_id = raw.get("sourcePlayerId")
        if source_id is not None:
            if isinstance(source_id, bool) or not isinstance(source_id, int) or source_id < 1 or source_id > 5:
                raise HTTPException(400, "Pocket role source is invalid")
            role["sourcePlayerId"] = source_id
        roles.append(role)
    actions: list[dict] = []
    action_ids: set[str] = set()
    for raw in raw_actions:
        if not isinstance(raw, dict) or set(raw) - {"id", "arrow", "participants", "startAtMs", "durationMs", "syncGroup", "waits"}:
            raise HTTPException(400, "Pocket action has an invalid document shape")
        action_id = raw.get("id")
        if not isinstance(action_id, str) or not ACTION_ID.fullmatch(action_id) or action_id in action_ids:
            raise HTTPException(400, "Pocket action identities must be unique")
        action_ids.add(action_id)
        arrow = raw.get("arrow")
        if not isinstance(arrow, dict) or set(arrow) - {"id", "kind", "start", "end", "sequence", "path", "control", "timing", "exit_target"} or not isinstance(arrow.get("kind"), str) or arrow["kind"] not in KINDS or arrow.get("id") != action_id:
            raise HTTPException(400, "Pocket route is invalid")
        clean_arrow = {"id": action_id, "kind": arrow["kind"], "start": _point(arrow.get("start"), "Pocket route start"), "end": _point(arrow.get("end"), "Pocket route end")}
        sequence = arrow.get("sequence")
        if sequence is None:
            sequence = 1
        if isinstance(sequence, bool) or not isinstance(sequence, int) or not 1 <= sequence <= 30:
            raise HTTPException(400, "Pocket move numbers must be from 1 to 30")
        clean_arrow["sequence"] = sequence
        path = arrow.get("path", "straight")
        if not isinstance(path, str) or path not in {"straight", "curve"}:
            raise HTTPException(400, "Pocket route type is invalid")
        if path == "curve" and arrow.get("control") is None:
            raise HTTPException(400, "Curved pocket routes require a control point")
        clean_arrow["path"] = path
        for point_key, label in (("control", "Pocket curve control"), ("exit_target", "Pocket screen exit")):
            if arrow.get(point_key) is not None:
                clean_arrow[point_key] = _point(arrow[point_key], label)
        timing = arrow.get("timing", 1.2)
        if isinstance(timing, bool) or not isinstance(timing, (int, float)) or not math.isfinite(timing) or not .5 <= timing <= 4:
            raise HTTPException(400, "Pocket move duration must be 0.5-4 seconds")
        clean_arrow["timing"] = round(float(timing), 2)
        participants = raw.get("participants")
        if not isinstance(participants, dict) or set(participants) - {"actor", "recipient", "screener", "handler", "cutter"} or any(not isinstance(role, str) or role not in role_ids for role in participants.values()):
            raise HTTPException(400, "Pocket action references an unknown role")
        kind = arrow["kind"]
        required = {"movement": {"actor"}, "backdoor-cut": {"actor"}, "pass": {"actor", "recipient"}, "handoff": {"actor", "recipient"}, "screen": {"screener", "handler"}, "slip-screen": {"screener", "handler"}, "pick-roll": {"screener", "handler"}, "pick-pop": {"screener", "handler"}, "off-ball-screen": {"screener", "cutter"}, "pin-down": {"screener", "cutter"}}[kind]
        if not required.issubset(participants) or len({participants[field] for field in required}) != len(required):
            raise HTTPException(400, "Pocket action is missing a required participant role")
        start_ms, duration_ms = raw.get("startAtMs"), raw.get("durationMs")
        if isinstance(start_ms, bool) or not isinstance(start_ms, (int, float)) or not math.isfinite(start_ms) or not 0 <= start_ms <= 120000 or isinstance(duration_ms, bool) or not isinstance(duration_ms, (int, float)) or not math.isfinite(duration_ms) or not 500 <= duration_ms <= 120000:
            raise HTTPException(400, "Pocket timing is invalid")
        waits = raw.get("waits")
        if not isinstance(waits, list) or len(waits) > 30:
            raise HTTPException(400, "Pocket waits are invalid")
        sync_group = raw.get("syncGroup")
        if sync_group is not None and (not isinstance(sync_group, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", sync_group)):
            raise HTTPException(400, "Pocket synchronization identity is invalid")
        actions.append({"id": action_id, "arrow": clean_arrow, "participants": dict(participants), "startAtMs": round(float(start_ms)), "durationMs": round(float(duration_ms)), **({"syncGroup": sync_group} if sync_group else {}), "waits": waits})
    wait_ids: set[str] = set()
    for action in actions:
        clean_waits = []
        for wait in action["waits"]:
            if not isinstance(wait, dict) or set(wait) - {"id", "sourceAction", "event", "playerRole", "routePhase", "routeSegment", "progress"}:
                raise HTTPException(400, "Pocket wait has an invalid shape")
            wait_id, source_id, event = wait.get("id"), wait.get("sourceAction"), wait.get("event")
            player_role = wait.get("playerRole")
            if not isinstance(wait_id, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", wait_id) or wait_id in wait_ids or not isinstance(source_id, str) or source_id not in action_ids or source_id == action["id"] or not isinstance(event, str) or event not in EVENTS or player_role is not None and (not isinstance(player_role, str) or player_role not in role_ids):
                raise HTTPException(400, "Pocket wait must reference an internal action and role")
            source_kind = next(item["arrow"]["kind"] for item in actions if item["id"] == source_id)
            if event == "catch" and source_kind not in {"pass", "handoff"} or event in {"screen-set", "screen-use"} and source_kind not in {"screen", "slip-screen", "pick-roll", "pick-pop", "off-ball-screen", "pin-down"}:
                raise HTTPException(400, "Pocket wait does not match its source action")
            normalized_wait = {"id": wait_id, "sourceAction": source_id, "event": event}
            if event == "route-point":
                phase, segment, progress, player_role = wait.get("routePhase"), wait.get("routeSegment"), wait.get("progress"), wait.get("playerRole")
                if player_role is None or not isinstance(phase, str) or phase not in PHASES or isinstance(segment, bool) or not isinstance(segment, int) or not 0 <= segment <= 63 or isinstance(progress, bool) or not isinstance(progress, (int, float)) or not math.isfinite(progress) or not 0 < progress < 1:
                    raise HTTPException(400, "Pocket route wait progress is invalid")
                normalized_wait.update({"playerRole": player_role, "routePhase": phase, "routeSegment": segment, "progress": float(progress)})
            elif any(key in wait for key in ("playerRole", "routePhase", "routeSegment", "progress")):
                raise HTTPException(400, "Only route-point waits can include route details")
            wait_ids.add(wait_id)
            clean_waits.append(normalized_wait)
        action["waits"] = clean_waits
    graph = {action["id"]: [wait["sourceAction"] for wait in action["waits"]] for action in actions}
    visiting: set[str] = set()
    visited: set[str] = set()
    def visit(action_id: str) -> None:
        if action_id in visiting:
            raise HTTPException(400, "Pocket waits cannot form a cycle")
        if action_id in visited:
            return
        visiting.add(action_id)
        for dependency in graph[action_id]:
            visit(dependency)
        visiting.remove(action_id)
        visited.add(action_id)
    for action_id in graph:
        visit(action_id)
    sync_by_action: dict[str, str] = {}
    sync_groups: dict[str, list[dict]] = {}
    for action in actions:
        group = action.get("syncGroup")
        if group:
            sync_by_action[action["id"]] = group
            sync_groups.setdefault(group, []).append(action)
    for members in sync_groups.values():
        if len({member["startAtMs"] for member in members}) != 1:
            raise HTTPException(400, "Pinned pocket actions need one planned start time")
        owners: set[str] = set()
        transfers = 0
        for member in members:
            kind = member["arrow"]["kind"]
            if kind in {"pass", "handoff"}:
                transfers += 1
                participants = (member["participants"].get("actor"), member["participants"].get("recipient")) if kind == "handoff" else (member["participants"].get("recipient"),)
            elif kind in {"screen", "slip-screen", "pick-roll", "pick-pop"}:
                participants = (member["participants"].get("screener"), member["participants"].get("handler"))
            elif kind in {"off-ball-screen", "pin-down"}:
                participants = (member["participants"].get("screener"), member["participants"].get("cutter"))
            else:
                participants = (member["participants"].get("actor"),)
            for participant in participants:
                if participant is not None:
                    if participant in owners:
                        raise HTTPException(400, "Pinned pocket actions cannot claim the same movement role")
                    owners.add(participant)
            if any(wait["sourceAction"] in {item["id"] for item in members} for wait in member["waits"]):
                raise HTTPException(400, "Pinned pocket actions cannot wait on one another")
        if transfers > 1:
            raise HTTPException(400, "A pinned pocket group cannot start competing ball transfers")
    def event_node(action_id: str) -> str:
        return f"sync:{sync_by_action[action_id]}" if action_id in sync_by_action else f"action:{action_id}"
    event_graph: dict[str, set[str]] = {}
    for action in actions:
        node = event_node(action["id"])
        event_graph.setdefault(node, set())
        for wait in action["waits"]:
            dependency = event_node(wait["sourceAction"])
            if node == dependency:
                raise HTTPException(400, "Pinned pocket actions cannot wait on one another")
            event_graph[node].add(dependency)
            event_graph.setdefault(dependency, set())
    event_state: dict[str, int] = {}
    def visit_event(node: str) -> None:
        if event_state.get(node) == 1:
            raise HTTPException(400, "Pocket waits cannot form a cycle through synchronized actions")
        if event_state.get(node) == 2:
            return
        event_state[node] = 1
        for dependency in event_graph[node]:
            visit_event(dependency)
        event_state[node] = 2
    for node in event_graph:
        visit_event(node)
    required = value.get("requiredBallRole")
    if required is not None and (not isinstance(required, str) or required not in role_ids):
        raise HTTPException(400, "Pocket possession role is invalid")
    result = {"version": 1, "id": pocket_id, "revision": value["revision"], "name": name.strip(), "createdAt": value["createdAt"], "updatedAt": value["updatedAt"], "roles": roles, "actions": actions}
    if required is not None:
        result["requiredBallRole"] = required
    if isinstance(value.get("summary"), str):
        result["summary"] = value["summary"][:300]
    if value.get("starter") is True:
        result["starter"] = True
    return result


async def _body(request: Request) -> dict:
    data = bytearray()
    async for chunk in request.stream():
        if len(data) + len(chunk) > MAX_BYTES:
            raise HTTPException(413, "Pocket JSON exceeds the 256 KiB limit")
        data.extend(chunk)
    try:
        value = json.loads(data.decode("utf-8-sig"))
    except (UnicodeDecodeError, ValueError, RecursionError) as error:
        raise HTTPException(400, "Pocket JSON is invalid") from error
    return _validate(value)


def _read(path: Path) -> dict:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, RecursionError) as error:
        raise HTTPException(503, "Pocket library is unreadable; stored files were preserved") from error
    value = _validate(raw)
    if value["id"] != path.stem:
        raise HTTPException(503, "Pocket identity does not match its file; stored files were preserved")
    return value


def _write(path: Path, value: dict) -> None:
    content = json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n"
    if len(content.encode("utf-8")) > MAX_BYTES:
        raise HTTPException(413, "Pocket action exceeds the 256 KiB limit")
    temp: Path | None = None
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, prefix=".pocket-", delete=False) as stream:
            temp = Path(stream.name)
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
        try:
            descriptor = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        except OSError:
            pass
    except OSError as error:
        raise HTTPException(503, "Pocket storage is unavailable; retry") from error
    finally:
        if temp is not None:
            try:
                temp.unlink(missing_ok=True)
            except OSError:
                pass


@router.get("")
def list_pocket_actions() -> list[dict]:
    try:
        paths = sorted(POCKET_ACTIONS_DIR.glob("pocket-*.json")) if POCKET_ACTIONS_DIR.exists() else []
    except OSError as error:
        raise HTTPException(503, "Pocket library is unavailable; retry") from error
    values = []
    for path in paths:
        with _playbook_lock(path):
            values.append(_read(path))
    return sorted(values, key=lambda item: (item["name"].casefold(), item["id"]))


@router.get("/{pocket_id}")
def get_pocket_action(pocket_id: str) -> dict:
    path = _path(pocket_id)
    with _playbook_lock(path):
        if not path.is_file():
            raise HTTPException(404, "Pocket action not found")
        return _read(path)


@router.post("", status_code=201)
async def create_pocket_action(request: Request) -> dict:
    value = await _body(request)
    path = _path(value["id"])
    with _playbook_lock(path):
        if path.exists():
            existing = _read(path)
            if {key: item for key, item in existing.items() if key not in {"revision", "createdAt", "updatedAt"}} == {key: item for key, item in value.items() if key not in {"revision", "createdAt", "updatedAt"}}:
                return existing
            raise HTTPException(409, "This pocket identity already exists")
        value["revision"] = uuid.uuid4().hex
        value["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        _write(path, value)
        return value


@router.put("/{pocket_id}")
async def update_pocket_action(pocket_id: str, request: Request, if_match: Annotated[str | None, Header(alias="If-Match")] = None) -> dict:
    path = _path(pocket_id)
    value = await _body(request)
    if value["id"] != pocket_id:
        raise HTTPException(400, "Pocket identity does not match the request")
    with _playbook_lock(path):
        if not path.is_file():
            raise HTTPException(404, "Pocket action not found")
        current = _read(path)
        if if_match is None or if_match.strip('"') != current["revision"]:
            raise HTTPException(409, "This pocket changed elsewhere · Reload it before saving")
        value["revision"] = uuid.uuid4().hex
        value["createdAt"] = current["createdAt"]
        value["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        _write(path, value)
        return value


@router.delete("/{pocket_id}")
def delete_pocket_action(pocket_id: str) -> dict:
    path = _path(pocket_id)
    with _playbook_lock(path):
        if not path.exists():
            raise HTTPException(404, "Pocket action not found")
        _read(path)
        try:
            path.unlink()
        except OSError as error:
            raise HTTPException(503, "Pocket action could not be deleted; retry") from error
        return {"deleted": True, "id": pocket_id}

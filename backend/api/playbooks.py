"""Local persistence routes for ARC's lightweight basketball playbook editor."""

from __future__ import annotations

import json
import os
import re
import tempfile
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException, Response

from backend.config import PLAYBOOKS_DIR


router = APIRouter(prefix="/api/playbooks", tags=["playbooks"])
PLAYBOOK_ID = re.compile(r"^[a-z0-9][a-z0-9-]{7,63}$")
MAX_NAME_LENGTH = 80
MAX_PLAYERS = 5
MAX_DEFENDERS = 5
MAX_ARROWS = 30
ALLOWED_ARROW_KINDS = {"movement", "pass", "screen", "handoff", "pick-roll", "pick-pop", "off-ball-screen", "pin-down", "backdoor-cut"}
ALLOWED_ARROW_PATHS = {"straight", "curve"}


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def _path(playbook_id: str) -> Path:
    if not PLAYBOOK_ID.fullmatch(playbook_id):
        raise HTTPException(400, "Invalid playbook id")
    return PLAYBOOKS_DIR / f"{playbook_id}.json"


def _point(value: object, label: str) -> dict[str, float]:
    if not isinstance(value, dict) or not isinstance(value.get("x"), (int, float)) or not isinstance(value.get("y"), (int, float)):
        raise HTTPException(400, f"{label} must contain numeric x and y")
    x, y = float(value["x"]), float(value["y"])
    if not 0 <= x <= 100 or not 0 <= y <= 100:
        raise HTTPException(400, f"{label} must stay inside the court")
    return {"x": round(x, 4), "y": round(y, 4)}


def _markers(value: object, label: str, limit: int, *, player_ratings: bool = False) -> list[dict]:
    if not isinstance(value, list) or len(value) > limit:
        raise HTTPException(400, f"{label} must contain at most {limit} markers")
    result: list[dict] = []
    ids: set[int] = set()
    for marker in value:
        if not isinstance(marker, dict) or not isinstance(marker.get("id"), int) or marker["id"] < 1:
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
                if not isinstance(rating, int) or isinstance(rating, bool) or not 1 <= rating <= 5:
                    raise HTTPException(400, "Player ratings must be integers from 1 to 5")
                clean_ratings[key] = rating
            clean_marker["ratings"] = clean_ratings
        result.append(clean_marker)
    return result


def _document(payload: object, *, playbook_id: str, created_at: str | None = None) -> dict:
    if not isinstance(payload, dict):
        raise HTTPException(400, "Playbook must be an object")
    name = payload.get("name", "Untitled play")
    if not isinstance(name, str) or not name.strip() or len(name.strip()) > MAX_NAME_LENGTH:
        raise HTTPException(400, f"Play name must be 1-{MAX_NAME_LENGTH} characters")
    players = _markers(payload.get("players", []), "Players", MAX_PLAYERS, player_ratings=True)
    defenders = _markers(payload.get("defenders", []), "Defenders", MAX_DEFENDERS)
    ball = payload.get("ball")
    clean_ball = None if ball is None else _point(ball, "Ball")
    raw_arrows = payload.get("arrows", [])
    if not isinstance(raw_arrows, list) or len(raw_arrows) > MAX_ARROWS:
        raise HTTPException(400, f"Arrows must contain at most {MAX_ARROWS} items")
    arrows: list[dict] = []
    arrow_ids: set[str] = set()
    for arrow in raw_arrows:
        if not isinstance(arrow, dict) or not isinstance(arrow.get("id"), str) or not re.fullmatch(r"[a-z0-9-]{4,64}", arrow["id"]):
            raise HTTPException(400, "Arrow ids must be short text labels")
        if arrow["id"] in arrow_ids:
            raise HTTPException(400, "Arrow ids must be unique")
        if arrow.get("kind") not in ALLOWED_ARROW_KINDS:
            raise HTTPException(400, "Arrow kind is not supported")
        arrow_ids.add(arrow["id"])
        sequence = arrow.get("sequence", len(arrows) + 1)
        if not isinstance(sequence, int) or isinstance(sequence, bool) or not 1 <= sequence <= MAX_ARROWS:
            raise HTTPException(400, "Arrow sequence must be a positive integer")
        path = arrow.get("path", "straight")
        if path not in ALLOWED_ARROW_PATHS:
            raise HTTPException(400, "Arrow path must be straight or curve")
        timing = arrow.get("timing", 1.2)
        if not isinstance(timing, (int, float)) or isinstance(timing, bool) or not 0.5 <= float(timing) <= 4:
            raise HTTPException(400, "Arrow timing must be between 0.5 and 4 seconds")
        control_value = arrow.get("control")
        control = None if control_value is None else _point(control_value, "Arrow control")
        clean_arrow = {"id": arrow["id"], "kind": arrow["kind"], "sequence": sequence, "path": path, "timing": round(float(timing), 2), "control": control, "start": _point(arrow.get("start"), "Arrow start"), "end": _point(arrow.get("end"), "Arrow end")}
        player_ids = {marker["id"] for marker in players}
        if arrow["kind"] in {"screen", "pick-roll", "pick-pop"}:
            screener_id, handler_id = arrow.get("screener_id"), arrow.get("handler_id")
            if arrow["kind"] == "pick-pop" and (screener_id is None or handler_id is None):
                raise HTTPException(400, "Pick and pop actions need screener_id and handler_id")
            if screener_id is not None and (not isinstance(screener_id, int) or isinstance(screener_id, bool) or screener_id not in player_ids):
                raise HTTPException(400, "On-ball screener must be an offensive player")
            if handler_id is not None and (not isinstance(handler_id, int) or isinstance(handler_id, bool) or handler_id not in player_ids):
                raise HTTPException(400, "On-ball handler must be an offensive player")
            if screener_id is not None and screener_id == handler_id:
                raise HTTPException(400, "On-ball screen players must be distinct")
            if screener_id is not None:
                clean_arrow["screener_id"] = screener_id
            if handler_id is not None:
                clean_arrow["handler_id"] = handler_id
        if arrow["kind"] in {"off-ball-screen", "pin-down"}:
            screener_id, cutter_id = arrow.get("screener_id"), arrow.get("cutter_id")
            if not isinstance(screener_id, int) or isinstance(screener_id, bool) or not isinstance(cutter_id, int) or isinstance(cutter_id, bool):
                raise HTTPException(400, "Off-ball screens need screener_id and cutter_id")
            if screener_id == cutter_id or screener_id not in player_ids or cutter_id not in player_ids:
                raise HTTPException(400, "Off-ball screen players must be distinct offensive players")
            clean_arrow["screener_id"] = screener_id
            clean_arrow["cutter_id"] = cutter_id
        if arrow["kind"] == "backdoor-cut":
            actor_id = arrow.get("actor_id")
            if not isinstance(actor_id, int) or isinstance(actor_id, bool) or actor_id not in player_ids:
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
    return {
        "version": 1,
        "id": playbook_id,
        "name": name.strip(),
        "created_at": created_at or now,
        "updated_at": now,
        "defenders_visible": defenders_visible,
        "players": players,
        "defenders": defenders,
        "ball": clean_ball,
        "arrows": arrows,
    }


def _read(path: Path) -> dict:
    try:
        value = json.loads(path.read_text())
    except (OSError, ValueError, TypeError) as error:
        raise HTTPException(500, "Saved play could not be read") from error
    if not isinstance(value, dict):
        raise HTTPException(500, "Saved play is invalid")
    return value


def _write(path: Path, value: dict) -> None:
    PLAYBOOKS_DIR.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=PLAYBOOKS_DIR, prefix=".playbook-", delete=False) as stream:
            json.dump(value, stream, indent=2)
            stream.write("\n")
            temporary = Path(stream.name)
        os.replace(temporary, path)
    except OSError as error:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
        raise HTTPException(500, "Playbook could not be saved") from error


@router.get("")
def list_playbooks(response: Response) -> list[dict]:
    PLAYBOOKS_DIR.mkdir(parents=True, exist_ok=True)
    result: list[dict] = []
    warnings: list[str] = []
    for path in PLAYBOOKS_DIR.glob("*.json"):
        try:
            value = _read(path)
        except HTTPException:
            warnings.append(path.name)
            continue
        result.append(value)
    if warnings:
        response.headers["X-ARC-Playbook-Warnings"] = ", ".join(sorted(warnings))
    return sorted(result, key=lambda item: str(item.get("updated_at", "")), reverse=True)


@router.post("")
def create_playbook(payload: dict) -> dict:
    playbook_id = f"play-{uuid.uuid4().hex[:12]}"
    value = _document(payload, playbook_id=playbook_id)
    _write(_path(playbook_id), value)
    return value


@router.get("/{playbook_id}")
def get_playbook(playbook_id: str) -> dict:
    path = _path(playbook_id)
    if not path.is_file():
        raise HTTPException(404, "Playbook not found")
    return _read(path)


@router.put("/{playbook_id}")
def update_playbook(playbook_id: str, payload: dict) -> dict:
    path = _path(playbook_id)
    if not path.is_file():
        raise HTTPException(404, "Playbook not found")
    current = _read(path)
    value = _document(payload, playbook_id=playbook_id, created_at=str(current.get("created_at", _now())))
    _write(path, value)
    return value


@router.delete("/{playbook_id}")
def delete_playbook(playbook_id: str) -> dict:
    path = _path(playbook_id)
    if not path.is_file():
        raise HTTPException(404, "Playbook not found")
    try:
        path.unlink()
    except OSError as error:
        raise HTTPException(500, "Playbook could not be deleted") from error
    return {"deleted": True, "id": playbook_id}

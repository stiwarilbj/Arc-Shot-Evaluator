"""Account-free private media backups. No model loading or raw source footage."""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import shutil
import tempfile
import uuid
import zipfile

import cv2
from .video_validation import validate_finished_video

MAX_ARCHIVE = 512 * 1024 * 1024
MAX_FILE = 100 * 1024 * 1024
MAX_METADATA = 8 * 1024 * 1024
KINDS = ("highlight", "quiz", "reveal")


def checksum(path: Path):
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def valid_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-zA-Z0-9-]{1,100}", value):
        raise ValueError("Invalid clip identity")
    return value


def player(value):
    if (
        not isinstance(value, dict)
        or not isinstance(value.get("id"), str)
        or not 1 <= len(value["id"]) <= 100
        or not isinstance(value.get("name"), str)
        or not 1 <= len(value["name"].strip()) <= 100
        or len(value["name"]) > 100
        or not isinstance(value.get("aliases"), list)
        or len(value["aliases"]) > 20
        or any(
            not isinstance(alias, str) or len(alias) > 100 for alias in value["aliases"]
        )
    ):
        raise ValueError("Invalid player label")
    return {"id": value["id"], "name": value["name"], "aliases": value["aliases"][:]}


def metadata(value):
    if (
        not isinstance(value, dict)
        or value.get("version") != 1
        or type(value.get("duration")) not in (int, float)
        or not 0 < value["duration"] <= 15
        or type(value.get("quiz")) is not bool
        or value.get("mime") not in ("video/mp4", "video/webm")
        or value.get("presentation") not in (None, "silhouette")
    ):
        raise ValueError("Invalid clip metadata")
    if not isinstance(value.get("createdAt"), str):
        raise ValueError("Invalid clip date")
    datetime.fromisoformat(value["createdAt"].replace("Z", "+00:00"))
    return {
        "version": 1,
        "id": valid_id(value.get("id")),
        "player": player(value.get("player")),
        "duration": value["duration"],
        "createdAt": value["createdAt"],
        "mime": value["mime"],
        "quiz": value["quiz"],
        **(
            {"presentation": "silhouette"}
            if value.get("presentation") == "silhouette"
            else {}
        ),
    }


def kinds(value):
    return KINDS if value["quiz"] else ("highlight",)


def suffix(value):
    return ".mp4" if value["mime"] == "video/mp4" else ".webm"


def library_contents(root: Path):
    records, files = [], {}
    for path in sorted((root / "saved").glob("*/clip.json")):
        if path.parent.name.startswith("."):
            continue
        value = metadata(json.loads(path.read_text()))
        refs = {}
        for kind in kinds(value):
            video = path.parent / (kind + suffix(value))
            size = video.stat().st_size
            if not 0 < size <= MAX_FILE:
                raise ValueError("A saved video is empty or exceeds the backup limit")
            digest = checksum(video)
            name = f"media/{digest}{suffix(value)}"
            refs[kind] = {"path": name, "sha256": digest, "bytes": size}
            files[name] = video
        records.append({**value, "files": refs})
    manifest = {
        "format": "arc-jumper-library",
        "version": 1,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "clips": records,
    }
    return manifest, files


def export_archive(root: Path, destination: Path):
    manifest, files = library_contents(root)
    if (
        len(manifest["clips"]) > 1000
        or sum(p.stat().st_size for p in files.values()) > MAX_ARCHIVE - MAX_METADATA
    ):
        raise ValueError("Backups are limited to 1000 clips and 512 MiB")
    encoded = json.dumps(manifest, allow_nan=False).encode()
    if len(encoded) > MAX_METADATA:
        raise ValueError("Backup metadata is too large")
    with zipfile.ZipFile(
        destination, "w", compression=zipfile.ZIP_STORED, allowZip64=False
    ) as archive:
        archive.writestr("manifest.json", encoded)
        for name, path in files.items():
            archive.write(path, name)
    if destination.stat().st_size > MAX_ARCHIVE:
        raise ValueError("Backups are limited to 512 MiB")


def inspect_archive(source: Path):
    if not 22 <= source.stat().st_size <= MAX_ARCHIVE:
        raise ValueError("Choose an ARCade Hoops backup ZIP no larger than 512 MiB")
    archive = zipfile.ZipFile(source)
    try:
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        if (
            not 1 <= len(entries) <= 3001
            or len(set(names)) != len(names)
            or "manifest.json" not in names
        ):
            raise ValueError("Missing or duplicate backup files")
        for entry in entries:
            if (
                (
                    entry.filename != "manifest.json"
                    and not re.fullmatch(
                        r"media/[a-f0-9]{64}\.(mp4|webm)", entry.filename
                    )
                )
                or entry.flag_bits & ~0x800
                or entry.compress_type != zipfile.ZIP_STORED
                or entry.compress_size != entry.file_size
                or not 0
                < entry.file_size
                <= (MAX_METADATA if entry.filename == "manifest.json" else MAX_FILE)
            ):
                raise ValueError("Unsafe or unsupported backup file")
        value = json.loads(archive.read("manifest.json"))
        if (
            not isinstance(value, dict)
            or value.get("format") != "arc-jumper-library"
            or value.get("version") != 1
            or not isinstance(value.get("clips"), list)
            or len(value["clips"]) > 1000
            or not isinstance(value.get("createdAt"), str)
        ):
            raise ValueError("Invalid ARCade Hoops backup manifest")
        datetime.fromisoformat(value["createdAt"].replace("Z", "+00:00"))
        expected = set()
        identities = set()
        for raw in value["clips"]:
            clip = metadata(raw)
            if clip["id"] in identities:
                raise ValueError("Duplicate clip identities")
            identities.add(clip["id"])
            refs = raw.get("files")
            if not isinstance(refs, dict) or set(refs) != set(kinds(clip)):
                raise ValueError("Incomplete clip variants")
            for ref in refs.values():
                if (
                    not isinstance(ref, dict)
                    or not isinstance(ref.get("sha256"), str)
                    or not re.fullmatch(r"[a-f0-9]{64}", ref["sha256"])
                    or ref.get("path") != f"media/{ref['sha256']}{suffix(clip)}"
                    or type(ref.get("bytes")) is not int
                    or not 0 < ref["bytes"] <= MAX_FILE
                ):
                    raise ValueError("Invalid backup media reference")
                entry = archive.getinfo(ref["path"])
                if entry.file_size != ref["bytes"]:
                    raise ValueError("Backup file size changed")
                expected.add(ref["path"])
        if set(names) != expected | {"manifest.json"}:
            raise ValueError("Missing or unexpected backup files")
        return archive, value
    except BaseException:
        archive.close()
        raise


def import_archive(root: Path, source: Path, lock):
    archive, manifest = inspect_archive(source)
    saved = root / "saved"
    saved.mkdir(parents=True, exist_ok=True)
    with (
        archive,
        tempfile.TemporaryDirectory(prefix=".restore-", dir=saved) as temporary,
    ):
        stage = Path(temporary)
        verified = set()
        records = []
        # Verify every file and prepare complete directories before touching saved media.
        for raw in manifest["clips"]:
            value = metadata(raw)
            if (
                str(uuid.UUID(value["id"])) != value["id"]
                or str(uuid.UUID(value["player"]["id"])) != value["player"]["id"]
            ):
                raise ValueError(
                    "Restored clip and player identities must be normalized UUIDs"
                )
            directory = stage / value["id"]
            directory.mkdir()
            for kind in kinds(value):
                ref = raw["files"][kind]
                destination = directory / (kind + suffix(value))
                with archive.open(ref["path"]) as stream, destination.open("wb") as out:
                    shutil.copyfileobj(stream, out, 1024 * 1024)
                if checksum(destination) != ref["sha256"]:
                    raise ValueError("Backup video checksum failed")
                with destination.open("rb") as stream:
                    header = stream.read(12)
                if (value["mime"] == "video/mp4" and header[4:8] != b"ftyp") or (
                    value["mime"] == "video/webm" and header[:4] != b"\x1a\x45\xdf\xa3"
                ):
                    raise ValueError("Backup video format does not match its filename")
                neutral = value.get("presentation") == "silhouette" or kind == "quiz"
                key = (ref["path"], neutral, value["duration"])
                if key not in verified:
                    capture = cv2.VideoCapture(str(destination))
                    try:
                        width, height = (
                            int(capture.get(cv2.CAP_PROP_FRAME_WIDTH)),
                            int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT)),
                        )
                    finally:
                        capture.release()
                    count = round(value["duration"] * 30)
                    if abs(count / 30 - value["duration"]) > 0.002:
                        raise ValueError("Backup clip timeline changed")
                    if not (2 <= width <= 1280 and 2 <= height <= 720):
                        raise ValueError("Invalid backup video dimensions")
                    validate_finished_video(
                        destination,
                        width,
                        height,
                        count,
                        neutral=neutral,
                    )
                    verified.add(key)
            (directory / "clip.json").write_text(json.dumps(value, allow_nan=False))
            records.append((value, raw["files"], directory))
        added, skipped = [], 0
        with lock:
            for value, refs, directory in records:
                final = saved / value["id"]
                if final.exists():
                    existing = metadata(json.loads((final / "clip.json").read_text()))
                    if existing != value or any(
                        not (final / (kind + suffix(value))).exists()
                        or checksum(final / (kind + suffix(value)))
                        != refs[kind]["sha256"]
                        for kind in kinds(value)
                    ):
                        raise FileExistsError(
                            "The library changed during restore. Retry this backup; existing clips were not replaced."
                        )
                    skipped += 1
                elif (saved / ("." + value["id"])).exists():
                    raise FileExistsError(
                        "A clip save is pending. Retry the backup after it completes."
                    )
            try:
                for value, refs, directory in records:
                    final = saved / value["id"]
                    if not final.exists():
                        directory.rename(final)
                        added.append(final)
            except BaseException:
                for path in added:
                    shutil.rmtree(path)
                raise
        return {"added": len(added), "skipped": skipped}

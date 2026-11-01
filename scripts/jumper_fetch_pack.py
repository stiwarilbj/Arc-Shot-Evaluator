"""Retrieve a pinned reviewed pack. No inference or raw footage acquisition."""

import hashlib
import json
from pathlib import Path
import re
import shutil
import tarfile
import tempfile
import urllib.request

try:
    from .jumper_pack import (
        PACK_LIMIT,
        budget,
        collection_kind,
        require_collection_size,
        text,
        url,
    )
except ImportError:
    from jumper_pack import (
        PACK_LIMIT,
        budget,
        collection_kind,
        require_collection_size,
        text,
        url,
    )


def unpack(
    archive: Path, destination: Path, expected: str, expected_release: str | None = None
):
    if (
        archive.stat().st_size > PACK_LIMIT
        or hashlib.file_digest(archive.open("rb"), "sha256").hexdigest() != expected
    ):
        raise ValueError("Pack checksum or size verification failed")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=destination.parent) as temporary:
        staging = Path(temporary)
        with tarfile.open(archive, "r:gz") as bundle:
            size, names = 0, set()
            for member in bundle:
                if (
                    not member.isfile()
                    or member.name in names
                    or not re.fullmatch(
                        r"manifest\.json|[a-f0-9]{32}\.(mp4|png)", member.name
                    )
                ):
                    raise ValueError("Unexpected or unsafe media pack member")
                names.add(member.name)
                size += member.size
                if size > PACK_LIMIT:
                    raise ValueError("Expanded media pack exceeds budget")
                source = bundle.extractfile(member)
                with (staging / member.name).open("wb") as output:
                    shutil.copyfileobj(source, output)
        manifest = json.loads((staging / "manifest.json").read_text())
        if (
            not isinstance(manifest, dict)
            or manifest.get("version") != 1
            or not isinstance(manifest.get("clips"), list)
            or not isinstance(manifest.get("players"), list)
        ):
            raise ValueError("Invalid NBA collection manifest")
        if expected_release is not None and manifest.get("release") != expected_release:
            raise ValueError("Pinned release does not match the pack manifest")
        if not re.fullmatch(
            r"[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}",
            text(manifest.get("release"), "release version"),
        ):
            raise ValueError("Invalid release version")
        kind = collection_kind(manifest)
        require_collection_size(kind, len(manifest["clips"]), len(manifest["players"]))
        if manifest.get("clip_count") != len(manifest["clips"]) or manifest.get(
            "player_count"
        ) != len(manifest["players"]):
            raise ValueError("NBA collection counts do not match its contents")
        ids, players, assets = (
            set(),
            {p["id"] for p in manifest["players"]},
            {"manifest.json"},
        )
        if len(players) != len(manifest["players"]):
            raise ValueError("Duplicate player identity")
        events, videos, represented = set(), set(), set()
        for person in manifest["players"]:
            if (
                not re.fullmatch(
                    r"[a-z0-9][a-z0-9-]{0,99}", text(person.get("id"), "player ID")
                )
                or not isinstance(person.get("aliases"), list)
                or len(person["aliases"]) > 20
            ):
                raise ValueError("Invalid canonical player")
            text(person.get("name"), "player name")
            for alias in person["aliases"]:
                text(alias, "player alias")
        for clip in manifest["clips"]:
            if not re.fullmatch(r"[a-f0-9]{32,64}", text(clip.get("id"), "clip ID")):
                raise ValueError("Invalid clip identity")
            provenance = clip.get("provenance")
            if not isinstance(provenance, dict):
                raise ValueError("Missing public provenance")
            for key in ("source_url", "permission_url", "identity_url"):
                url(provenance.get(key), key)
            for key in ("license", "attribution", "changes"):
                text(provenance.get(key), key)
            text(clip.get("event_id"), "source event ID")
            if clip["id"] in ids or clip["player_id"] not in players:
                raise ValueError("Duplicate clip or unknown player")
            ids.add(clip["id"])
            represented.add(clip["player_id"])
            event = (clip["provenance"]["source_url"], clip["event_id"])
            if event in events:
                raise ValueError("Duplicate source event")
            events.add(event)
            if (
                clip.get("fps") != 30
                or type(clip.get("frame_count")) is not int
                or not 90 <= clip["frame_count"] <= 180
                or clip.get("duration") != clip["frame_count"] / 30
            ):
                raise ValueError("Invalid public clip timeline")
            for kind in ("quiz", "reveal", "thumbnail"):
                value = clip[kind]
                filename = value["file"]
                extension = "png" if kind == "thumbnail" else "mp4"
                if not isinstance(filename, str) or not re.fullmatch(
                    rf"[a-f0-9]{{32}}\.{extension}", filename
                ):
                    raise ValueError("Invalid public media path")
                if kind != "thumbnail":
                    if value["sha256"] in videos:
                        raise ValueError("Duplicate public video")
                    videos.add(value["sha256"])
                if (
                    not isinstance(value.get("sha256"), str)
                    or not re.fullmatch(r"[a-f0-9]{64}", value["sha256"])
                    or type(value.get("bytes")) is not int
                    or value["bytes"] <= 0
                ):
                    raise ValueError("Invalid public asset metadata")
                path = staging / filename
                if (
                    filename not in names
                    or path.stat().st_size != value["bytes"]
                    or hashlib.file_digest(path.open("rb"), "sha256").hexdigest()
                    != value["sha256"]
                ):
                    raise ValueError("Media checksum mismatch")
                assets.add(filename)
        if represented != players:
            raise ValueError("Every listed player must have a reviewed clip")
        if assets != names:
            raise ValueError("Unreferenced media in pack")
        (staging / "availability.json").write_text(
            json.dumps(
                {"version": 1, "status": "ready", "release": manifest["release"]}
            )
        )
        budget(staging, PACK_LIMIT)
        old = destination.with_name(destination.name + ".previous")
        if old.exists():
            shutil.rmtree(old)
        if destination.exists():
            destination.rename(old)
        try:
            shutil.copytree(staging, destination)
        except BaseException:
            shutil.rmtree(destination, ignore_errors=True)
            if old.exists():
                old.rename(destination)
            raise
        shutil.rmtree(old, ignore_errors=True)


def main(config: Path, destination: Path):
    value = json.loads(config.read_text())
    if value.get("version") != 1:
        raise ValueError("Unknown release configuration")
    if value.get("release") is None:
        print("NBA pack not configured; personal clips remain available")
        return
    url, expected = value.get("url", ""), value.get("sha256", "")
    if not re.fullmatch(
        r"https://github\.com/stiwarilbj/Arc-Shot-Evaluator/releases/download/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+\.tar\.gz",
        url,
    ) or not re.fullmatch("[a-f0-9]{64}", expected):
        raise ValueError("Pack needs a pinned repository Release URL and SHA-256")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as temporary:
        archive = Path(temporary) / "pack.tar.gz"
        with (
            urllib.request.urlopen(url, timeout=60) as source,
            archive.open("wb") as output,
        ):
            size = 0
            while data := source.read(1024 * 1024):
                size += len(data)
                if size > PACK_LIMIT:
                    raise ValueError("Downloaded media pack exceeds budget")
                output.write(data)
        unpack(archive, destination, expected, value["release"])
    print("Verified prepared NBA pack restored")


if __name__ == "__main__":
    import sys

    main(Path(sys.argv[1]), Path(sys.argv[2]))

"""Build a reviewed Jumper media pack, or check static hosting budgets.

Standard library only. Does not download footage, run inference, or publish.
The production gate requires 300 distinct reviewed events and 60 players.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import tarfile
import tempfile
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

PACK_LIMIT = 600 * 1024 * 1024
SITE_LIMIT = 800 * 1024 * 1024
REVIEW_CHECKS = (
    "full_motion_watched", "identity_verified", "single_complete_jumpshot",
    "trim_verified", "all_players_masked", "no_missing_limbs", "no_mask_flicker",
    "occlusion_order_correct", "no_background_leakage", "pair_alignment_verified",
    "ball_removed_or_neutral", "rights_verified",
)


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def budget(directory: Path, limit: int = SITE_LIMIT) -> int:
    if not directory.is_dir():
        raise ValueError("Artifact directory does not exist")
    total = 0
    for path in directory.rglob("*"):
        if path.is_symlink():
            raise ValueError("Media and site artifacts must not contain symlinks")
        if path.is_file():
            total += path.stat().st_size
            if total > limit:
                raise ValueError(f"Artifact exceeds its {limit // (1024 * 1024)} MiB budget")
    return total


def text(value: object, label: str) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > 4000:
        raise ValueError(f"Missing or invalid {label}")
    return value.strip()


def url(value: object, label: str) -> str:
    value = text(value, label)
    parsed = urlparse(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError(f"{label} must be a public HTTPS evidence link")
    return value


def reviewed_clip(report_path: Path, review_path: Path) -> tuple[dict, dict, list[Path]]:
    report = json.loads(report_path.read_text())
    review = json.loads(review_path.read_text())
    if not isinstance(report, dict) or not isinstance(review, dict):
        raise ValueError("Reports and reviews must be objects")
    fingerprint = report.get("fingerprint")
    if report.get("version") != 1 or not isinstance(fingerprint, str) or not re.fullmatch(r"[a-f0-9]{64}", fingerprint):
        raise ValueError("Invalid preparation report")
    if review.get("version") != 1 or review.get("report_sha256") != digest(report_path) or review.get("fingerprint") != fingerprint:
        raise ValueError("Review is missing or belongs to different preparation outputs")
    text(review.get("reviewer"), "reviewer")
    try:
        reviewed_at = datetime.fromisoformat(review["reviewed_at"].replace("Z", "+00:00"))
        if reviewed_at.tzinfo is None:
            raise ValueError("Review timestamp needs a timezone")
    except (KeyError, TypeError, AttributeError) as error:
        raise ValueError("Invalid review timestamp") from error
    checks = review.get("checks")
    if not isinstance(checks, dict) or any(checks.get(key) is not True for key in REVIEW_CHECKS):
        raise ValueError("Every full-motion, identity, masking and rights review check is required")
    warnings = report.get("warnings")
    if not isinstance(warnings, list) or warnings:
        raise ValueError("Resolve tracking/cut warnings and regenerate outputs before publication")
    provenance = review.get("provenance")
    if not isinstance(provenance, dict) or provenance.get("editing_allowed") is not True or provenance.get("hosting_allowed") is not True:
        raise ValueError("Document editing and public hosting permission")
    provenance = {
        "source_url": url(provenance.get("source_url"), "source evidence"),
        "permission_url": url(provenance.get("permission_url"), "permission evidence"),
        "identity_url": url(provenance.get("identity_url"), "shooter identity evidence"),
        "license": text(provenance.get("license"), "license"),
        "attribution": text(provenance.get("attribution"), "attribution"),
        "changes": "Trimmed, muted, foreground segmented and background removed; quiz players rendered as silhouettes.",
    }
    frames, fps, duration = report.get("frame_count"), report.get("fps"), report.get("duration")
    if type(frames) is not int or type(fps) is not int or fps != 30 or not 90 <= frames <= 180 or type(duration) not in (int, float) or not math.isfinite(duration) or duration != frames / fps:
        raise ValueError("Public clips must have a synchronized 3–6 second, 30fps timeline")
    inputs = report.get("inputs")
    if not isinstance(inputs, dict) or not isinstance(inputs.get("job"), dict):
        raise ValueError("Missing preparation identity")
    job = inputs["job"]
    event = text(job.get("event_id"), "source event ID")
    player_id = text(job.get("player_id"), "player ID")
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,99}", player_id):
        raise ValueError("Player IDs must be stable lowercase identifiers")
    player = {"id": player_id, "name": text(job.get("player_name"), "player name"), "aliases": []}
    aliases = review.get("aliases", [])
    if not isinstance(aliases, list) or len(aliases) > 20:
        raise ValueError("Invalid player aliases")
    player["aliases"] = [text(alias, "alias") for alias in aliases]
    files, public_outputs = [], {}
    outputs = report.get("outputs")
    if not isinstance(outputs, dict) or set(outputs) != {"quiz", "reveal", "highlight", "thumbnail"}:
        raise ValueError("Missing paired outputs")
    # Validate highlight too, but never publish this private editor artifact.
    for kind, output in outputs.items():
        if not isinstance(output, dict):
            raise ValueError("Invalid output metadata")
        name = output.get("file")
        extension = "png" if kind == "thumbnail" else "mp4"
        if not isinstance(name, str) or not re.fullmatch(rf"[a-f0-9]{{32}}\.{extension}", name):
            raise ValueError("Media filenames must be opaque and contain no paths")
        path = report_path.parent / "outputs" / name
        if path.parent.is_symlink() or path.is_symlink() or not path.is_file() or path.stat().st_size != output.get("bytes") or digest(path) != output.get("sha256"):
            raise ValueError("Reviewed media is missing or changed after review")
        if kind != "highlight":
            files.append(path)
            public_outputs[kind] = dict(output)
    # Clip identity survives mask corrections, encoder changes and model upgrades.
    clip_id = hashlib.sha256(json.dumps([provenance["source_url"], event]).encode()).hexdigest()[:32]
    clip = {"id": clip_id, "player_id": player_id, "event_id": event,
            "duration": duration, "fps": fps, "frame_count": frames,
            "provenance": provenance, **public_outputs}
    return clip, player, files


def build_pack(collection_path: Path, output: Path) -> dict:
    collection = json.loads(collection_path.read_text())
    if not isinstance(collection, dict) or collection.get("version") != 1 or not isinstance(collection.get("clips"), list):
        raise ValueError("Expected a version-1 collection of report/review pairs")
    version = text(collection.get("release"), "release version")
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}", version):
        raise ValueError("Invalid release version")
    clips, players, files = [], {}, []
    seen_events, seen_ids, seen_videos = set(), set(), set()
    for record in collection["clips"]:
        if not isinstance(record, dict) or not isinstance(record.get("report"), str) or not isinstance(record.get("review"), str):
            raise ValueError("Every collection entry needs report and review paths")
        clip, player, media = reviewed_clip(collection_path.parent / record["report"], collection_path.parent / record["review"])
        # Source event identities must stay consistent even for different crops,
        # encodes or mask revisions of the same shot.
        event = (clip["provenance"]["source_url"], clip["event_id"])
        if event in seen_events or clip["id"] in seen_ids or clip["quiz"]["sha256"] in seen_videos or clip["reveal"]["sha256"] in seen_videos:
            raise ValueError("Duplicate shot, clip identity or video")
        seen_events.add(event)
        seen_ids.add(clip["id"])
        seen_videos.update((clip["quiz"]["sha256"], clip["reveal"]["sha256"]))
        if player["id"] in players and players[player["id"]] != player:
            raise ValueError("Conflicting canonical player identity or aliases")
        players[player["id"]] = player
        clips.append(clip)
        files.extend(media)
    if len(clips) < 300 or len(players) < 60:
        raise ValueError(f"Collection not ready: {len(clips)}/300 reviewed shots, {len(players)}/60 players. Existing deployment must be preserved.")
    filenames = [path.name for path in files]
    if len(filenames) != len(set(filenames)):
        raise ValueError("Duplicate asset filename")
    manifest = {"version": 1, "release": version, "clip_count": len(clips), "player_count": len(players),
                "background_rgb": [224, 224, 224], "other_player_rgb": [128, 128, 128], "target_rgb": [0, 0, 0],
                "players": sorted(players.values(), key=lambda p: p["id"]), "clips": sorted(clips, key=lambda c: c["id"])}
    manifest_bytes = (json.dumps(manifest, sort_keys=True, indent=2, allow_nan=False) + "\n").encode()
    total = sum(path.stat().st_size for path in files) + len(manifest_bytes)
    if total > PACK_LIMIT:
        raise ValueError("Media pack exceeds 600 MiB uncompressed budget")
    output.parent.mkdir(parents=True, exist_ok=True)
    # Write beside destination for atomic replacement; failed builds preserve a
    # previously verified pack. Only the public allowlist enters the archive.
    with tempfile.TemporaryDirectory(dir=output.parent) as temporary:
        temporary = Path(temporary)
        manifest_path = temporary / "manifest.json"
        manifest_path.write_bytes(manifest_bytes)
        archive = temporary / "media.tar.gz"
        with tarfile.open(archive, "w:gz") as bundle:
            bundle.add(manifest_path, arcname="manifest.json")
            for path in sorted(files):
                bundle.add(path, arcname=path.name, recursive=False)
        if archive.stat().st_size > PACK_LIMIT:
            raise ValueError("Compressed pack exceeds 600 MiB budget")
        checksum = digest(archive)
        archive.replace(output)
    output.with_suffix(output.suffix + ".sha256").write_text(f"{checksum}  {output.name}\n")
    return {"sha256": checksum, "bytes": output.stat().st_size, "uncompressed_bytes": total,
            "clips": len(clips), "players": len(players)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    pack = commands.add_parser("build")
    pack.add_argument("collection", type=Path)
    pack.add_argument("output", type=Path)
    check = commands.add_parser("budget")
    check.add_argument("directory", type=Path)
    args = parser.parse_args()
    if args.command == "build":
        print(json.dumps(build_pack(args.collection, args.output), indent=2))
    else:
        print(f"Pages artifact: {budget(args.directory)} bytes (limit {SITE_LIMIT})")


if __name__ == "__main__":
    main()

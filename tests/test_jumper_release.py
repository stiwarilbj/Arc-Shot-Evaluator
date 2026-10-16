import hashlib, io, json, tarfile
from pathlib import Path
import pytest
from scripts import jumper_fetch_pack as release


def archive(tmp_path, entries):
    path = tmp_path / "pack.tar.gz"
    with tarfile.open(path, "w:gz") as bundle:
        for name, data in entries:
            item = tarfile.TarInfo(name)
            item.size = len(data)
            bundle.addfile(item, io.BytesIO(data))
    return path, hashlib.sha256(path.read_bytes()).hexdigest()


def test_unconfigured_release_preserves_personal_first(tmp_path):
    config = tmp_path / "release.json"
    config.write_text('{"version":1,"release":null}')
    destination = tmp_path / "catalog"
    destination.mkdir()
    (destination / "availability.json").write_text("existing")
    release.main(config, destination)
    assert (destination / "availability.json").read_text() == "existing"


@pytest.mark.parametrize("name", ["../escape", "nested/file.mp4", "raw.mov"])
def test_unsafe_pack_preserves_previous(tmp_path, name):
    destination = tmp_path / "catalog"
    destination.mkdir()
    (destination / "existing").write_text("good")
    path, sha = archive(tmp_path, [(name, b"bad")])
    with pytest.raises(ValueError):
        release.unpack(path, destination, sha)
    assert (destination / "existing").read_text() == "good"


def test_checksum_and_incomplete_collection_preserve_previous(tmp_path):
    destination = tmp_path / "catalog"
    destination.mkdir()
    (destination / "existing").write_text("good")
    path, sha = archive(
        tmp_path, [("manifest.json", b'{"version":1,"players":[],"clips":[]}')]
    )
    for checksum in ["0" * 64, sha]:
        with pytest.raises(ValueError):
            release.unpack(path, destination, checksum)
        assert (destination / "existing").read_text() == "good"


def starter_entries():
    clips, entries = [], []
    for index in range(2):
        clip = {
            "id": f"{index:032x}",
            "player_id": f"player-{index}",
            "event_id": f"shot-{index}",
            "fps": 30,
            "frame_count": 90,
            "duration": 3,
            "provenance": {
                "source_url": "https://example.org/source",
                "permission_url": "https://example.org/license",
                "identity_url": "https://example.org/identity",
                "license": "TEST ONLY",
                "attribution": "Synthetic fixture",
                "changes": "Synthetic fixture",
            },
        }
        for number, kind in enumerate(("quiz", "reveal", "thumbnail")):
            data = f"fixture-{index}-{kind}".encode()
            name = (
                f"{index * 3 + number:032x}.{'png' if kind == 'thumbnail' else 'mp4'}"
            )
            clip[kind] = {
                "file": name,
                "bytes": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
            }
            entries.append((name, data))
        clips.append(clip)
    manifest = {
        "version": 1,
        "collection_kind": "starter",
        "release": "test-only",
        "clip_count": 2,
        "player_count": 2,
        "players": [
            {"id": f"player-{i}", "name": f"Player {i}", "aliases": []}
            for i in range(2)
        ],
        "clips": clips,
    }
    return manifest, entries


def test_starter_restore_and_corruption_preserves_previous(tmp_path):
    manifest, entries = starter_entries()
    path, sha = archive(
        tmp_path, [("manifest.json", json.dumps(manifest).encode()), *entries]
    )
    destination = tmp_path / "catalog"
    release.unpack(path, destination, sha)
    assert (
        json.loads((destination / "availability.json").read_text())["status"] == "ready"
    )
    original = (destination / "manifest.json").read_bytes()
    # Correct archive checksum cannot disguise corrupted asset bytes.
    path, sha = archive(
        tmp_path,
        [
            ("manifest.json", json.dumps(manifest).encode()),
            (entries[0][0], b"corrupted"),
            *entries[1:],
        ],
    )
    with pytest.raises(ValueError, match="checksum"):
        release.unpack(path, destination, sha)
    assert (destination / "manifest.json").read_bytes() == original


@pytest.mark.parametrize(
    "problem",
    [
        "legacy",
        "unknown-kind",
        "wrong-count",
        "duplicate-event",
        "duplicate-video",
        "one-player",
        "bad-attribution",
        "bad-timeline",
        "unsafe-media",
    ],
)
def test_invalid_starter_preserves_existing(tmp_path, problem):
    manifest, entries = starter_entries()
    first, second = manifest["clips"]
    if problem == "legacy":
        del manifest["collection_kind"]
    elif problem == "unknown-kind":
        manifest["collection_kind"] = "pilot"
    elif problem == "wrong-count":
        manifest["clip_count"] = 300
    elif problem == "duplicate-event":
        second["event_id"] = first["event_id"]
    elif problem == "duplicate-video":
        second["quiz"] = first["quiz"]
    elif problem == "one-player":
        second["player_id"] = first["player_id"]
    elif problem == "bad-attribution":
        first["provenance"]["attribution"] = ""
    elif problem == "bad-timeline":
        first["frame_count"] = 91
    elif problem == "unsafe-media":
        first["quiz"]["file"] = "../outside.mp4"
    path, sha = archive(
        tmp_path, [("manifest.json", json.dumps(manifest).encode()), *entries]
    )
    destination = tmp_path / "catalog"
    destination.mkdir()
    (destination / "previous").write_text("good")
    with pytest.raises(ValueError):
        release.unpack(path, destination, sha)
    assert (destination / "previous").read_text() == "good"


def test_pinned_release_mismatch_preserves_previous(tmp_path):
    manifest, entries = starter_entries()
    path, sha = archive(
        tmp_path, [("manifest.json", json.dumps(manifest).encode()), *entries]
    )
    destination = tmp_path / "catalog"
    destination.mkdir()
    (destination / "existing").write_text("good")
    with pytest.raises(ValueError, match="Pinned release"):
        release.unpack(path, destination, sha, "different-release")
    assert (destination / "existing").read_text() == "good"

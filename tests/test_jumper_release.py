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

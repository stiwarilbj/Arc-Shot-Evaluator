"""Offline preparation gates; tests never download a model or public footage."""

import json
from pathlib import Path
from types import SimpleNamespace

import cv2
import numpy as np
import pytest

from scripts import jumper_pack as pack
from scripts import jumper_prepare as prep


def job(source="private.mp4"):
    return {
        "version": 1,
        "source": source,
        "start": 0,
        "end": 3,
        "event_id": "verified-source-event",
        "player_id": "example-player",
        "player_name": "Example Player",
        "identity_evidence": "Source evidence required before approval",
        "target_id": 1,
        "objects": [{"id": 1, "prompts": [{"frame": 0, "box": [0.1, 0.1, 0.5, 0.9]}]}],
    }


@pytest.mark.parametrize(
    "change",
    [
        {"start": float("nan")},
        {"end": float("inf")},
        {"end": 16},
        {"start": -1},
        {"start": 3},
        {"target_id": 2},
        {"target_id": True},
        {"objects": []},
        {"objects": [{"id": 1, "prompts": [None]}]},
        {"objects": [{"id": True, "prompts": [{"frame": 0, "box": [0, 0, 1, 1]}]}]},
        {"objects": [{"id": 1, "prompts": [{"frame": 0, "box": [0, 0, 2, 1]}]}]},
        {"objects": [{"id": 1, "prompts": [{"frame": 90, "box": [0, 0, 1, 1]}]}]},
        {
            "objects": [
                {
                    "id": 1,
                    "prompts": [{"frame": 0, "points": [[0.5, 0.5]], "labels": [2]}],
                }
            ]
        },
        {
            "objects": [
                {"id": 1, "prompts": [{"frame": 0, "points": [[0.5]], "labels": [1]}]}
            ]
        },
    ],
)
def test_invalid_jobs_fail_before_model_loading(change):
    with pytest.raises(ValueError):
        prep.validate_job({**job(), **change})


def test_corrections_and_distinct_participants_validate():
    value = job()
    value["objects"][0]["prompts"].append(
        {"frame": 30, "points": [[0.3, 0.4], [0.6, 0.8]], "labels": [1, 0]}
    )
    value["objects"].append({"id": 2, "prompts": [{"frame": 0, "box": [0.6, 0, 1, 1]}]})
    assert prep.validate_job(value) == value
    value["objects"][1]["id"] = 1
    with pytest.raises(ValueError, match="unique"):
        prep.validate_job(value)


def test_compositing_never_copies_background_or_modifies_source():
    rng = np.random.default_rng(42)
    source = rng.integers(0, 256, (32, 48, 3), dtype=np.uint8)
    original = source.copy()
    labels = np.zeros((32, 48), dtype=np.uint8)
    labels[3:20, 5:15] = 1
    labels[7:28, 20:30] = 2
    outputs = prep.composite(source, labels, 1)
    source[labels == 0] = rng.integers(
        0, 256, source[labels == 0].shape, dtype=np.uint8
    )
    for actual, other in zip(outputs, prep.composite(source, labels, 1)):
        np.testing.assert_array_equal(actual, other)
        assert np.all(actual[labels == 0] == 224)
    quiz, reveal, highlight = outputs
    assert set(np.unique(quiz)) == {0, 128, 224}
    assert np.all(quiz[labels == 1] == 0)
    assert np.all(quiz[labels == 2] == 128)
    np.testing.assert_array_equal(reveal[labels != 0], original[labels != 0])
    np.testing.assert_array_equal(highlight[labels == 1], original[labels == 1])
    assert np.all(highlight[labels == 2] == 128)
    assert not np.shares_memory(quiz, reveal)
    np.testing.assert_array_equal(source[labels != 0], original[labels != 0])


def test_real_encoding_and_identical_pair_timing(tmp_path):
    frames, masks, outputs = (
        tmp_path / name for name in ("frames", "masks", "outputs")
    )
    frames.mkdir()
    masks.mkdir()
    for i in range(6):
        image = np.full((64, 96, 3), (20, 60, 210), dtype=np.uint8)
        cv2.imwrite(str(frames / f"{i:06d}.jpg"), image)
        labels = np.zeros(image.shape[:2], np.uint8)
        labels[10:50, 10 + i : 30 + i] = 1
        labels[15:45, 50:70] = 2
        np.save(masks / f"{i:06d}.npy", labels)
    updates = []
    result = prep.render(
        sorted(frames.iterdir()),
        masks,
        outputs,
        1,
        "test",
        progress=lambda done, total: updates.append((done, total)),
    )
    # Some encoders blur the moving edge enough to trigger the new quality retry.
    cycle = [(i, 6) for i in range(1, 7)]
    assert updates in (cycle, cycle * 2)
    assert set(result) == {"quiz", "reveal", "highlight", "thumbnail"}
    timelines = []
    for kind in ("quiz", "reveal", "highlight"):
        path = outputs / result[kind]["file"]
        assert result[kind]["sha256"] == prep.digest(path)
        capture = cv2.VideoCapture(str(path))
        count = 0
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            count += 1
            # H.264 is lossy: allow compression drift after encoding. Source
            # court pixels were replaced exactly before encoding (test above).
            assert np.max(np.abs(frame[:5].astype(int) - 224)) <= 4
        timelines.append(
            (
                count,
                capture.get(cv2.CAP_PROP_FPS),
                capture.get(cv2.CAP_PROP_FRAME_WIDTH),
                capture.get(cv2.CAP_PROP_FRAME_HEIGHT),
            )
        )
        capture.release()
    assert timelines == [(6, 30, 96, 64)] * 3
    thumb = cv2.imread(str(outputs / result["thumbnail"]["file"]))
    assert set(np.unique(thumb)) == {0, 128, 224}


def test_extract_bounds_and_no_upsizing(tmp_path):
    source = tmp_path / "input.avi"
    writer = cv2.VideoWriter(str(source), cv2.VideoWriter_fourcc(*"MJPG"), 12, (96, 64))
    for i in range(24):
        writer.write(np.full((64, 96, 3), i * 8, np.uint8))
    writer.release()
    frames = prep.extract(source, tmp_path / "frames", 0.5, 1.5)
    assert len(frames) == 30
    assert cv2.imread(str(frames[0])).shape[:2] == (64, 96)
    with pytest.raises(ValueError, match="beyond"):
        prep.extract(source, tmp_path / "truncated", 1, 3)


def test_extract_honors_container_rotation(tmp_path):
    original, rotated = tmp_path / "original.mp4", tmp_path / "rotated.mp4"
    prep.run_ffmpeg(
        [
            "-f",
            "lavfi",
            "-i",
            "color=c=red:s=96x64:r=30:d=1",
            "-c:v",
            "libx264",
            str(original),
        ]
    )
    prep.run_ffmpeg(
        ["-display_rotation:v:0", "90", "-i", str(original), "-c", "copy", str(rotated)]
    )
    frames = prep.extract(rotated, tmp_path / "frames", 0, 1)
    assert len(frames) == 30
    assert cv2.imread(str(frames[0])).shape[:2] == (96, 64)


def test_resume_reuses_only_verified_stages_and_restarts_failed_gpu(
    tmp_path, monkeypatch
):
    import sys

    source, checkpoint, implementation = (
        tmp_path / p for p in ("source.mp4", "weights.pt", "sam2")
    )
    source.write_bytes(b"source")
    checkpoint.write_bytes(b"trusted weights")
    implementation.mkdir()
    (implementation / "__init__.py").write_text("# fake tracker for this test\n")
    monkeypatch.setitem(
        sys.modules,
        "sam2",
        SimpleNamespace(__file__=str(implementation / "__init__.py")),
    )
    counts = {"extract": 0, "track": [], "render": 0}

    def extract(*args):
        counts["extract"] += 1
        directory = args[1]
        directory.mkdir()
        for i in range(2):
            (directory / f"{i:06d}.jpg").write_bytes(b"frame")
        return sorted(directory.iterdir())

    def track(frames, destination, job, weights, device):
        counts["track"].append(device)
        if device == "mps":
            raise RuntimeError("simulated GPU loss")
        destination.mkdir(exist_ok=True)
        for frame in frames:
            (destination / f"{frame.stem}.npy").write_bytes(b"mask")
        return []

    def render(frames, masks, output, target, token):
        counts["render"] += 1
        output.mkdir()
        path = output / "test.mp4"
        path.write_bytes(b"rendered")
        return {
            "quiz": {
                "file": path.name,
                "sha256": prep.digest(path),
                "bytes": path.stat().st_size,
            }
        }

    monkeypatch.setattr(prep, "extract", extract)
    monkeypatch.setattr(prep, "track", track)
    monkeypatch.setattr(prep, "render", render)
    job_path = tmp_path / "job.json"
    prep.write_json(job_path, job(str(source)))
    work = tmp_path / "runs"
    first = prep.prepare(job_path, work, checkpoint, "mps")
    second = prep.prepare(job_path, work, checkpoint, "mps")
    assert first == second
    assert counts == {"extract": 1, "track": ["mps", "cpu"], "render": 1}
    assert second["device"] == "cpu" and second["status"] == "needs_review"
    run = work / second["fingerprint"]
    (run / "masks" / "000000.npy").write_bytes(b"corrupted")
    prep.prepare(job_path, work, checkpoint, "mps")
    assert counts["track"] == ["mps", "cpu", "mps", "cpu"]
    assert counts["extract"] == 1
    assert counts["render"] == 2
    checkpoint.write_bytes(b"different weights")
    third = prep.prepare(job_path, work, checkpoint, "mps")
    assert third["fingerprint"] != first["fingerprint"]
    assert counts["extract"] == 2


def reviewed_fixture(tmp_path):
    output = tmp_path / "outputs"
    output.mkdir()
    outputs = {}
    for index, kind in enumerate(("quiz", "reveal", "highlight", "thumbnail")):
        name = f"{index:032x}.{'png' if kind == 'thumbnail' else 'mp4'}"
        path = output / name
        path.write_bytes(kind.encode())
        outputs[kind] = {
            "file": name,
            "sha256": pack.digest(path),
            "bytes": path.stat().st_size,
        }
    report = {
        "version": 1,
        "fingerprint": "a" * 64,
        "warnings": [],
        "frame_count": 90,
        "fps": 30,
        "duration": 3,
        "inputs": {"job": job()},
        "outputs": outputs,
    }
    report_path = tmp_path / "report.json"
    prep.write_json(report_path, report)
    review = {
        "version": 1,
        "report_sha256": pack.digest(report_path),
        "fingerprint": "a" * 64,
        "reviewer": "Test reviewer",
        "reviewed_at": "2026-10-16T00:00:00Z",
        "checks": dict.fromkeys(pack.REVIEW_CHECKS, True),
        "provenance": {
            "source_url": "https://example.org/source",
            "permission_url": "https://example.org/license",
            "identity_url": "https://example.org/identity",
            "editing_allowed": True,
            "hosting_allowed": True,
            "license": "TEST ONLY",
            "attribution": "Test fixture; not real footage",
        },
    }
    review_path = tmp_path / "review.json"
    prep.write_json(review_path, review)
    return report_path, review_path, report, review


def test_reviews_bind_exact_outputs_and_keep_raw_material_private(tmp_path):
    report_path, review_path, report, _ = reviewed_fixture(tmp_path)
    clip, player, files = pack.reviewed_clip(report_path, review_path)
    assert player["id"] == "example-player"
    assert set(clip) >= {"quiz", "reveal", "thumbnail", "provenance"}
    assert "highlight" not in clip and "inputs" not in clip
    assert len(files) == 3
    files[0].write_bytes(b"changed")
    with pytest.raises(ValueError, match="changed"):
        pack.reviewed_clip(report_path, review_path)


@pytest.mark.parametrize("check", pack.REVIEW_CHECKS)
def test_every_review_check_is_required(tmp_path, check):
    report_path, review_path, _, review = reviewed_fixture(tmp_path)
    review["checks"][check] = False
    prep.write_json(review_path, review)
    with pytest.raises(ValueError, match="review check"):
        pack.reviewed_clip(report_path, review_path)


@pytest.mark.parametrize(
    "change",
    [
        {"fingerprint": "b" * 64},
        {"duration": 5},
        {"frame_count": 89},
        {"warnings": [{"frame": 12, "kind": "target_lost"}]},
    ],
)
def test_stale_reviews_and_tracking_failures_block_publication(tmp_path, change):
    report_path, review_path, report, review = reviewed_fixture(tmp_path)
    report.update(change)
    prep.write_json(report_path, report)
    if "fingerprint" not in change:
        review["report_sha256"] = pack.digest(report_path)
        prep.write_json(review_path, review)
    with pytest.raises(ValueError):
        pack.reviewed_clip(report_path, review_path)


def test_missing_permission_and_path_injection_rejected(tmp_path):
    report_path, review_path, report, review = reviewed_fixture(tmp_path)
    review["provenance"]["editing_allowed"] = False
    prep.write_json(review_path, review)
    with pytest.raises(ValueError, match="permission"):
        pack.reviewed_clip(report_path, review_path)
    review["provenance"]["editing_allowed"] = True
    report["outputs"]["quiz"]["file"] = "../raw-source.mp4"
    prep.write_json(report_path, report)
    review["report_sha256"] = pack.digest(report_path)
    prep.write_json(review_path, review)
    with pytest.raises(ValueError, match="opaque"):
        pack.reviewed_clip(report_path, review_path)


def test_incomplete_collection_preserves_previous_pack(tmp_path):
    report_path, review_path, *_ = reviewed_fixture(tmp_path)
    collection = tmp_path / "collection.json"
    prep.write_json(
        collection,
        {
            "version": 1,
            "release": "pilot",
            "clips": [{"report": report_path.name, "review": review_path.name}],
        },
    )
    output = tmp_path / "existing.tar.gz"
    output.write_bytes(b"previous verified release")
    with pytest.raises(ValueError, match="1/300"):
        pack.build_pack(collection, output)
    assert output.read_bytes() == b"previous verified release"
    value = json.loads(collection.read_text())
    value["clips"] *= 300
    prep.write_json(collection, value)
    with pytest.raises(ValueError, match="Duplicate"):
        pack.build_pack(collection, output)


def test_budgets_and_symlinks(tmp_path):
    (tmp_path / "file").write_bytes(b"12345")
    assert pack.budget(tmp_path, 5) == 5
    with pytest.raises(ValueError, match="budget"):
        pack.budget(tmp_path, 4)
    (tmp_path / "link").symlink_to(tmp_path / "file")
    with pytest.raises(ValueError, match="symlink"):
        pack.budget(tmp_path, 100)
    assert pack.PACK_LIMIT == 600 * 1024 * 1024
    assert pack.SITE_LIMIT == 800 * 1024 * 1024
    assert prep.REVIEW_CHECKS == pack.REVIEW_CHECKS


@pytest.mark.parametrize(
    "designation,count,player_count",
    [(None, 300, 60), ("complete", 300, 60), ("starter", 2, 2)],
)
def test_complete_synthetic_pack_contains_only_reviewed_public_assets(
    tmp_path, designation, count, player_count
):
    """Synthetic bytes exercise packaging, not video or collection readiness."""
    import tarfile

    entries = []
    for index in range(count):
        directory = tmp_path / str(index)
        directory.mkdir()
        report_path, review_path, report, review = reviewed_fixture(directory)
        fingerprint = f"{index:064x}"
        report["fingerprint"] = review["fingerprint"] = fingerprint
        report["inputs"]["job"].update(
            event_id=f"shot-{index}",
            player_id=f"player-{index % player_count}",
            player_name=f"Player {index % player_count}",
        )
        for kind, data in report["outputs"].items():
            path = directory / "outputs" / data["file"]
            renamed = path.with_name(
                f"{index:029x}{list(report['outputs']).index(kind):03x}{path.suffix}"
            )
            path.rename(renamed)
            renamed.write_bytes(f"synthetic-fixture-{index}-{kind}".encode())
            data.update(
                file=renamed.name,
                sha256=pack.digest(renamed),
                bytes=renamed.stat().st_size,
            )
        prep.write_json(report_path, report)
        review["report_sha256"] = pack.digest(report_path)
        prep.write_json(review_path, review)
        entries.append(
            {
                "report": str(report_path.relative_to(tmp_path)),
                "review": str(review_path.relative_to(tmp_path)),
            }
        )
    collection = tmp_path / "collection.json"
    definition = {"version": 1, "release": "synthetic-test-only", "clips": entries}
    if designation is not None:
        definition["collection_kind"] = designation
    prep.write_json(collection, definition)
    output = tmp_path / "pack.tar.gz"
    result = pack.build_pack(collection, output)
    assert result["clips"] == count and result["players"] == player_count
    assert result["sha256"] == pack.digest(output)
    with tarfile.open(output) as archive:
        assert len(archive.getmembers()) == count * 3 + 1
        manifest = json.load(archive.extractfile("manifest.json"))
        assert manifest["clip_count"] == count
        assert manifest["collection_kind"] == (designation or "complete")
        for clip in manifest["clips"]:
            assert "highlight" not in clip and "inputs" not in clip
            for kind in ("quiz", "reveal", "thumbnail"):
                data = archive.extractfile(clip[kind]["file"]).read()
                assert pack.hashlib.sha256(data).hexdigest() == clip[kind]["sha256"]

    # Exercise the actual release verifier with builder-generated manifests.
    from scripts import jumper_fetch_pack

    destination = tmp_path / "restored"
    jumper_fetch_pack.unpack(output, destination, result["sha256"])
    assert json.loads((destination / "manifest.json").read_text()) == manifest


@pytest.mark.parametrize(
    "kind,clips,players,accepted",
    [
        ("starter", 1, 2, False),
        ("starter", 2, 1, False),
        ("starter", 2, 2, True),
        ("complete", 299, 60, False),
        ("complete", 300, 59, False),
        ("complete", 300, 60, True),
    ],
)
def test_collection_thresholds(kind, clips, players, accepted):
    if accepted:
        pack.require_collection_size(kind, clips, players)
    else:
        with pytest.raises(ValueError, match="Collection not ready"):
            pack.require_collection_size(kind, clips, players)


@pytest.mark.parametrize("kind", [None, "pilot", "", 1, [], {}])
def test_invalid_explicit_collection_designation(kind):
    with pytest.raises(ValueError):
        pack.collection_kind({"collection_kind": kind})
    assert pack.collection_kind({}) == "complete"


def test_personal_silhouette_exports_share_only_masked_video(tmp_path):
    from backend.jumper.pipeline import render

    frames, masks, output = [tmp_path / name for name in ("frames", "masks", "output")]
    frames.mkdir()
    masks.mkdir()
    for i in range(3):
        source = np.full((64, 96, 3), (12, 60, 230), dtype=np.uint8)
        cv2.imwrite(str(frames / f"{i:06}.jpg"), source)
        owners = np.zeros((64, 96), dtype=np.uint8)
        owners[10:50, 10:30] = 1
        owners[10:50, 60:80] = 2
        np.save(masks / f"{i:06}.npy", owners)
    result = render(
        sorted(frames.iterdir()), masks, output, 1, "personal", silhouette=True
    )
    assert result["highlight"] == result["quiz"] == result["reveal"]
    assert len(list(output.glob("*.mp4"))) == 1
    capture = cv2.VideoCapture(str(output / result["quiz"]["file"]))
    ok, image = capture.read()
    capture.release()
    assert ok
    assert np.max(image.max(axis=2).astype(int) - image.min(axis=2)) <= 2
    assert np.max(image[15:45, 15:25]) <= 4
    assert np.max(np.abs(image[15:45, 65:75].astype(int) - 128)) <= 4
    assert np.max(np.abs(image[:5].astype(int) - 224)) <= 4


@pytest.mark.parametrize(
    "change",
    [
        {"auto_detect_others": "yes"},
        {"shooter_selection_resolved": "yes"},
        {"presentation": "original"},
        {
            "objects": [
                {
                    "id": 1,
                    "ignored": True,
                    "prompts": [{"frame": 0, "box": [0, 0, 1, 1]}],
                }
            ]
        },
    ],
)
def test_personal_options_reject_invalid_values(change):
    with pytest.raises(ValueError):
        prep.validate_job({**job(), **change})

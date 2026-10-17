import torch
import pytest
import numpy as np
from PIL import Image
from backend.jumper.mps import rotate
from backend.jumper.frames import FrameCache, prune_tracking


def test_real_rotary_matches_complex_reference():
    generator = torch.Generator().manual_seed(42)
    values = torch.randn((2, 2, 8, 16), generator=generator)
    phases = torch.randn((8, 8), generator=generator)
    frequencies = torch.polar(torch.ones_like(phases), phases)
    expected = torch.view_as_real(
        torch.view_as_complex(values.reshape(2, 2, 8, 8, 2)) * frequencies
    ).flatten(-2)
    torch.testing.assert_close(
        # Float32 complex multiplication may fuse operations differently.
        rotate(values, frequencies.real, frequencies.imag),
        expected,
        rtol=1e-6,
        atol=3e-7,
    )


def test_frame_cache_matches_native_preprocessing_and_stays_bounded(tmp_path):
    from sam2.utils.misc import _load_img_as_tensor

    paths = []
    for i in range(4):
        path = tmp_path / f"{i:06}.jpg"
        Image.fromarray(np.full((8, 12, 3), i * 50, dtype=np.uint8)).save(
            path, format="PNG"
        )
        paths.append(path)
    cache = FrameCache(paths, 16)
    for i, path in enumerate(paths):
        image, _, _ = _load_img_as_tensor(str(path), 16)
        expected = image.float().sub(cache.mean).div(cache.std)
        torch.testing.assert_close(cache[i], expected, rtol=0, atol=0)
        assert len(cache.cache) <= 2
    torch.testing.assert_close(cache[0], cache[0], rtol=0, atol=0)


def test_tracking_pruning_preserves_corrections_and_required_memory():
    conditional = {0: object(), 28: object()}
    output = {
        "cond_frame_outputs": conditional,
        "non_cond_frame_outputs": dict.fromkeys(range(31)),
    }
    prune_tracking({"output_dict_per_obj": {0: output}}, 30)
    assert output["cond_frame_outputs"] is conditional
    assert list(output["non_cond_frame_outputs"]) == list(range(15, 31))


def test_discovery_matches_browser_fixtures():
    import json
    from pathlib import Path
    from backend.jumper.discovery import resolve_people

    fixtures = json.loads(
        (Path(__file__).parent / "fixtures/jumper/discovery.json").read_text()
    )
    for fixture in fixtures:
        owners = np.zeros((fixture["height"], fixture["width"]), dtype=np.uint8)
        for identity, x1, y1, x2, y2 in fixture["masks"]:
            owners[y1:y2, x1:x2] = identity
        original = owners.copy()
        assert resolve_people(fixture["boxes"], owners) == {
            "unmatched": fixture["unmatched"],
            "ambiguous": fixture["ambiguous"],
            "ambiguous_tracks": fixture["ambiguous_tracks"],
        }, fixture["name"]
        reverse = resolve_people(list(reversed(fixture["boxes"])), owners)
        assert reverse["unmatched"] == list(reversed(fixture["unmatched"]))
        assert reverse["ambiguous"] == fixture["ambiguous"]
        assert reverse["ambiguous_tracks"] == fixture["ambiguous_tracks"]
        np.testing.assert_array_equal(owners, original)


def test_returning_people_match_browser_fixtures():
    import json
    from pathlib import Path
    from backend.jumper.discovery import PeopleDiscovery

    fixtures = json.loads((Path(__file__).parent / "fixtures/jumper/returning-people.json").read_text())
    for fixture in fixtures:
        discovery = PeopleDiscovery()
        tracks = json.loads(json.dumps(fixture["tracks"]))
        for step in fixture["steps"]:
            owners = np.zeros((fixture["height"], fixture["width"]), dtype=np.uint8)
            for identity, x1, y1, x2, y2 in step["masks"]:
                owners[y1:y2, x1:x2] = identity
            original = owners.copy()
            assert discovery.resolve(step["frame"], step["boxes"], owners, tracks) == {
                "unmatched": step["unmatched"],
                "ambiguous": bool(step["ambiguous_tracks"]),
                "ambiguous_tracks": step["ambiguous_tracks"],
            }, (fixture["name"], step["frame"])
            assert {str(k): v for k, v in discovery.last_seen.items()} == step["last_seen"]
            np.testing.assert_array_equal(owners, original)
            assert tracks == fixture["tracks"]


def test_repeated_returns_do_not_exhaust_track_limit():
    from backend.jumper.discovery import PeopleDiscovery

    discovery = PeopleDiscovery()
    tracks = [dict(id=i + 1, ignored=i == 19, prompts=[dict(frame=0)]) for i in range(20)]
    boxes = [[i / 20, 0, (i + 1) / 20, 1] for i in range(20)]
    for frame in range(200):
        owners = np.array([[0 if frame % 2 and i == 20 else i for i in range(1, 21)]], dtype=np.uint8)
        result = discovery.resolve(frame, boxes, owners, tracks)
        assert result["unmatched"] == []
        assert result["ambiguous_tracks"] == ([20] if frame % 2 else [])
        assert len(discovery.last_seen) == len(tracks) == 20
    assert PeopleDiscovery().last_seen == {}


def test_clicked_body_box_requires_unique_containment():
    from backend.jumper.discovery import clicked_person_box

    bodies = [[0.1, 0.1, 0.4, 0.9], [0.6, 0.1, 0.9, 0.9]]
    assert clicked_person_box(bodies, [0.2, 0.5]) == bodies[0]
    assert clicked_person_box(bodies, [0.5, 0.5]) is None
    assert clicked_person_box([*bodies, bodies[0]], [0.2, 0.5]) is None


def test_mps_background_expansion_uses_cpu_retry_without_hiding_real_cuts():
    import pytest
    from backend.jumper.pipeline import check_device_mask_area

    with pytest.raises(RuntimeError, match="retry on CPU"):
        check_device_mask_area("mps", 2500, 157000, 160000)
    check_device_mask_area("mps", None, 157000, 160000)
    check_device_mask_area("mps", 2500, 2600, 160000)
    check_device_mask_area("cpu", 2500, 157000, 160000)
    check_device_mask_area("cuda", 2500, 157000, 160000)


def test_mps_loss_and_instability_request_cpu_verification():
    import pytest
    from backend.jumper.pipeline import check_device_tracking

    for kind in ("target_lost", "player_lost", "tracking_unstable"):
        with pytest.raises(RuntimeError, match="retry on CPU"):
            check_device_tracking("mps", kind)
        check_device_tracking("cpu", kind)
        check_device_tracking("cuda", kind)
    check_device_tracking("mps", "possible_camera_cut")


@pytest.mark.parametrize("failure", ["memory", "target_lost", "player_lost", "tracking_unstable"])
def test_gpu_retry_discards_partial_discovery_and_keeps_silhouette(
    tmp_path, monkeypatch, failure
):
    import hashlib
    import json
    from backend.jumper import runner
    from backend import config

    weights = tmp_path / "weights"
    weights.mkdir()
    checkpoint = weights / "sam2.1_hiera_tiny.pt"
    checkpoint.write_bytes(b"test checkpoint")
    monkeypatch.setattr(config, "MODEL_WEIGHTS_DIR", weights)
    monkeypatch.setattr(
        runner, "CHECKPOINT_SHA", hashlib.sha256(checkpoint.read_bytes()).hexdigest()
    )
    monkeypatch.setattr(torch.backends.mps, "is_available", lambda: True)
    budgets = []
    monkeypatch.setattr(torch.mps, "set_per_process_memory_fraction", budgets.append)
    monkeypatch.setattr(torch.mps, "empty_cache", lambda: None)
    frames = [tmp_path / str(i) for i in range(9)]
    monkeypatch.setattr(runner, "extract", lambda *args: frames)
    job = dict(
        start=0,
        end=0.3,
        target_id=1,
        presentation="silhouette",
        auto_detect_others=True,
        objects=[dict(id=1, prompts=[dict(frame=0, points=[[0.5, 0.5]], labels=[1])])],
    )
    (tmp_path / "request.json").write_text(json.dumps(job))
    attempts = []

    def tracking(frames, masks, value, checkpoint, device, progress, cache_source=None):
        attempts.append(device)
        assert [o["id"] for o in value["objects"]] == [1]
        value["objects"].append(
            dict(id=2, prompts=[dict(frame=0, box=[0, 0, 0.2, 0.2])])
        )
        if device == "mps":
            from backend.jumper.pipeline import check_device_tracking

            if failure == "memory":
                raise RuntimeError("GPU memory limit")
            check_device_tracking(device, failure)
        return [{"frame": 2, "kind": "target_lost"}]

    monkeypatch.setattr(runner, "track", tracking)

    def rendering(*args, silhouette=False, progress=None):
        assert silhouette
        return {}

    monkeypatch.setattr(runner, "render", rendering)
    runner.run(tmp_path)
    assert attempts == ["mps", "cpu"]
    assert budgets == [0.5]
    result = json.loads((tmp_path / "result.json").read_text())
    assert [o["id"] for o in result["objects"]] == [1, 2]
    assert result["warnings"] == [{"frame": 2, "kind": "target_lost"}]


def test_automatic_shooter_selection_requires_consistent_include_points():
    import pytest
    from backend.jumper.discovery import require_shooter_box

    boxes = [[0.1, 0.1, 0.6, 0.9], [0.3, 0.2, 0.8, 0.9]]
    with pytest.raises(ValueError, match="Add another Include point"):
        require_shooter_box(boxes, [[0.4, 0.4]], [1])
    with pytest.raises(ValueError, match="Clear the first-frame points"):
        require_shooter_box([], [[0.4, 0.4]], [1])
    with pytest.raises(ValueError, match="Clear the first-frame points"):
        require_shooter_box(boxes, [[0.2, 0.5], [0.7, 0.5]], [1, 1])
    with pytest.raises(ValueError, match="Clear the first-frame points"):
        require_shooter_box(boxes, [[0.2, 0.5]], [0])
    assert require_shooter_box(
        boxes, [[0.4, 0.4], [0.2, 0.5], [0.5, 0.5]], [1, 1, 0]
    ) == boxes[0]
    result = require_shooter_box(boxes, [[0.1, 0.1]], [1])
    result[0] = 0
    assert boxes[0][0] == 0.1


def test_per_player_mask_quality_matches_browser_fixtures():
    import json
    from pathlib import Path
    from backend.jumper.mask_quality import MaskQuality, mask_extents

    fixtures = json.loads((Path(__file__).parent / "fixtures/jumper/mask-quality.json").read_text())
    for fixture in fixtures:
        quality = MaskQuality()
        original_tracks = json.loads(json.dumps(fixture["tracks"]))
        for frame, step in enumerate(fixture["frames"]):
            owners = np.zeros((fixture["height"], fixture["width"]), dtype=np.uint8)
            for identity, x1, y1, x2, y2 in step["masks"]:
                owners[y1:y2, x1:x2] = identity
            original = owners.copy()
            assert quality.inspect(frame, owners, fixture["tracks"], fixture["target"]) == step["warnings"], (fixture["name"], frame)
            np.testing.assert_array_equal(owners, original)
            assert fixture["tracks"] == original_tracks
            for identity, extent in mask_extents(owners).items():
                assert extent["area"] == np.count_nonzero(owners == identity)
    assert MaskQuality().states == {}

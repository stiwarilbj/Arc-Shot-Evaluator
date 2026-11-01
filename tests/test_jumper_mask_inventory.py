"""Reject incomplete or ambiguous mask inventories before encoder startup."""

import numpy as np
import pytest

from backend.jumper import pipeline
from backend.jumper.mask_files import check_mask_inventory


def inventory(tmp_path, names):
    masks = tmp_path / "masks"
    masks.mkdir()
    for name in names:
        (masks / name).touch()
    return masks


@pytest.mark.parametrize("names,reason", [
    (["000000.npy", "000002.npy"], "missing masks: 000001.npy"),
    (["000000.npy", "000001.npy", "000003.npy"], "missing masks: 000002.npy"),
    (["000000.npy", "000001.npy", "000002.npy", "000003.npy"], "unexpected masks: 000003.npy"),
    (["000000.npy", "000001.npy", "000002.npy", "1.npy"], "duplicate frames: 000001"),
    (["000000.npy", "000001.npy", "000002.npy", "0000001.npy"], "duplicate frames: 000001"),
    (["000000.npy", "000001.npy", "000002.npy", "copy.npy"], "unexpected masks: copy.npy"),
    (["000000.npy", "000001.npy", "000002.npy.partial"], "missing masks: 000002.npy"),
    (["000000.npy", "1.npy", "000002.npy"], "missing masks: 000001.npy"),
])
@pytest.mark.parametrize("silhouette,palette", [(False, False), (True, False), (True, True)])
def test_bad_inventory_never_opens_encoder_or_loads_mask(tmp_path, monkeypatch, names, reason, silhouette, palette):
    masks = inventory(tmp_path, names)
    def unexpected(*args, **kwargs):
        pytest.fail("Inventory rejection must precede encoders and array decoding")
    monkeypatch.setattr(pipeline, "encoder", unexpected)
    monkeypatch.setattr(pipeline.np, "load", unexpected)
    output = tmp_path / "output"
    with pytest.raises(ValueError, match=reason):
        pipeline.render([tmp_path / f"{i}.png" for i in range(3)], masks,
                        output, 1, "job", silhouette=silhouette, palette=palette)
    assert not output.exists()


def test_inventory_is_lightweight_and_ignores_abandoned_partials(tmp_path, monkeypatch):
    # Deliberately undecodable contents: this check inventories, not validates,
    # arrays; the existing detailed checks still own decoding and dimensions.
    masks = inventory(tmp_path, ["000002.npy", "000000.npy", "000001.npy", ".000001-old.partial"])
    monkeypatch.setattr(np, "load", lambda *a, **k: pytest.fail("Inventory must not decode arrays"))
    check_mask_inventory(masks, 3)


def test_directory_named_as_mask_is_not_a_finished_frame(tmp_path):
    masks = inventory(tmp_path, ["000000.npy", "000001.npy"])
    (masks / "000002.npy").mkdir()
    with pytest.raises(ValueError) as error:
        check_mask_inventory(masks, 3)
    assert "missing masks: 000002.npy" in str(error.value)
    assert "unexpected masks: 000002.npy" in str(error.value)


def test_empty_timeline_and_missing_directory_are_rejected(tmp_path):
    with pytest.raises(ValueError, match="empty processing timeline"):
        check_mask_inventory(tmp_path, 0)
    with pytest.raises(FileNotFoundError):
        check_mask_inventory(tmp_path / "missing", 3)


def test_full_length_timeline_and_bounded_diagnostics(tmp_path):
    masks = inventory(tmp_path, [f"{index:06d}.npy" for index in range(450)])
    check_mask_inventory(masks, 450)
    with pytest.raises(ValueError) as error:
        check_mask_inventory(masks, 460)
    assert "(+5 more)" in str(error.value)
    assert len(str(error.value)) < 300

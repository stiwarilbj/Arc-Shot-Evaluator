import torch
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

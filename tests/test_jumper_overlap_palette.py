import cv2
import numpy as np
import pytest

from backend.jumper.overlap_palette import OverlapPalette, GRAY_SHADES
from backend.jumper.pipeline import render, silhouette_pixels
from backend.jumper.video_validation import validate_composite, validate_saved_silhouette


def test_frequent_crossings_fixed_shades_and_late_entrants():
    g = OverlapPalette(1)
    frames = []
    for i in range(12):
        labels = np.zeros((48, 64), np.uint8)
        labels[5:40, :25] = 2
        labels[5:40, 25:50] = 5
        labels[:4] = 1
        if i == 11:
            labels[5:40, 50:] = 9
        frames.append(labels)
        g.observe(labels)
    shades = g.finish()
    assert abs(int(shades[2])-int(shades[5])) == 136
    assert (shades[0], shades[1]) == (224, 0)
    assert all(shades[i] in GRAY_SHADES for i in (2, 5, 9))
    np.testing.assert_array_equal(shades, g.finish())
    reverse = OverlapPalette(1)
    for labels in reversed(frames):
        reverse.observe(labels)
        pixels = silhouette_pixels(labels, 1, True, shades)
        validate_composite(pixels, labels, 1, 'quiz', True, shades)
        for identity in np.unique(labels):
            assert np.all(pixels[labels == identity] == shades[identity])
    np.testing.assert_array_equal(shades, reverse.finish())


def test_actual_renderer_uses_complete_segment_and_exports_neutral(tmp_path):
    masks, output = tmp_path / 'masks', tmp_path / 'output'
    masks.mkdir()
    frames = []
    for i in range(6):
        labels = np.zeros((96, 128), np.uint8)
        labels[10:80, 5:55] = 2
        if i > 1:
            labels[10:80, 55:105] = 5
        labels[80:, 40:80] = 1
        np.save(masks / f'{i:06d}.npy', labels)
        frames.append(tmp_path / f'unneeded-original-{i}.png')
    result = render(frames, masks, output, 1, 'overlap', silhouette=True, palette=True)
    assert result['quiz'] == result['reveal'] == result['highlight']
    path = output / result['quiz']['file']
    validate_saved_silhouette(path, .2, profile='palette')
    cap = cv2.VideoCapture(str(path))
    try:
        count = 0
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            assert abs(int(frame[30, 30, 0])-64) <= 4
            if count > 1:
                assert abs(int(frame[30, 80, 0])-200) <= 4
            assert np.max(frame.max(axis=2).astype(int)-frame.min(axis=2)) <= 8
            count += 1
        assert count == 6
    finally:
        cap.release()


@pytest.mark.parametrize('shape', [(1, 1), (1, 10), (10, 1)])
def test_tiny_frames(shape):
    graph = OverlapPalette(1)
    graph.observe(np.full(shape, 2, np.uint8))
    assert graph.finish()[2] == 64


def test_invalid_inputs():
    with pytest.raises(ValueError):
        OverlapPalette(0)
    with pytest.raises(ValueError):
        OverlapPalette(1).observe(np.zeros((0, 2), np.uint8))


def test_dense_contacts_avoid_reusing_extreme_shades():
    graph = OverlapPalette(1)
    for a in (2, 3, 4, 5):
        for b in (2, 3, 4, 5):
            if a < b:
                graph.observe(np.array([[a, b]], np.uint8))
    shades = graph.finish()
    for a in (2, 3, 4, 5):
        for b in (2, 3, 4, 5):
            if a < b:
                assert abs(int(shades[a])-int(shades[b])) >= 32

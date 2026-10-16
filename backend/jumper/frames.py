"""Bounded native frame loading using SAM's exact preprocessing."""

from collections import OrderedDict
from pathlib import Path
import shutil
import tempfile


class FrameCache:
    def __init__(self, paths, image_size):
        import torch

        self.paths = paths
        self.image_size = image_size
        self.cache = OrderedDict()
        self.mean = torch.tensor((0.485, 0.456, 0.406))[:, None, None]
        self.std = torch.tensor((0.229, 0.224, 0.225))[:, None, None]

    def __len__(self):
        return len(self.paths)

    def __getitem__(self, index):
        from sam2.utils.misc import _load_img_as_tensor

        if index not in self.cache:
            image, _, _ = _load_img_as_tensor(str(self.paths[index]), self.image_size)
            # SAM's eager loader assigns to float32 before normalization.
            self.cache[index] = image.float().sub_(self.mean).div_(self.std)
            while len(self.cache) > 2:
                self.cache.popitem(last=False)
        self.cache.move_to_end(index)
        return self.cache[index]


def bounded_state(predictor, frames):
    # Bootstrap through the upstream initializer so every internal field and
    # cached first-frame feature remains native. Do not eagerly load 450 frames.
    with tempfile.TemporaryDirectory() as temporary:
        shutil.copyfile(frames[0], Path(temporary) / "000000.jpg")
        state = predictor.init_state(
            temporary, offload_video_to_cpu=True, offload_state_to_cpu=True
        )
    state["images"] = FrameCache(frames, predictor.image_size)
    state["num_frames"] = len(frames)
    return state


def prune_tracking(state, frame):
    # Forward tracking uses six spatial memories and at most sixteen pointers.
    # Keep all corrective conditioning frames, and the last sixteen ordinary
    # frames. Finished owner maps already live on disk, not in this state.
    for output in state["output_dict_per_obj"].values():
        recent = output["non_cond_frame_outputs"]
        for old in list(recent):
            if old < frame - 15:
                del recent[old]

import json
from pathlib import Path
import numpy as np
import pytest
from backend.jumper.tracking_check import (
    masks_disagree, sample_mask, confirmed_shooter_frame, tracking_check_segments,
    ShooterTrackingCheck, valid_tracking_check,
)
from backend.jumper.frames import prune_tracking


def test_shared_disagreement_boundaries():
    fixtures = json.loads((Path(__file__).parent / "fixtures/jumper/tracking-check.json").read_text())
    for f in fixtures:
        assert masks_disagree(np.array(f["a"], dtype=np.uint8), np.array(f["b"], dtype=np.uint8)) == f["expected"], f["name"]


def test_confirmations_and_independent_bounded_history():
    tracks = [dict(id=7, prompts=[dict(frame=0, points=[[.5,.5]],labels=[1]),
              dict(frame=2,points=[[.2,.2]],labels=[0]),
              dict(frame=4,points=[[.5,.5]],labels=[1]),dict(frame=8,box=[.1,.1,.5,.9])])]
    assert confirmed_shooter_frame(tracks, 7) == 8
    assert tracking_check_segments(tracks, 7) == [dict(anchor=4,first=0),dict(anchor=8,first=5)]
    assert confirmed_shooter_frame([dict(id=7,prompts=tracks[0]["prompts"][:2])], 7) is None
    a = np.full((20,32),-1,dtype=np.float32)
    b = a.copy()
    a[2:18,2:10], b[2:18,20:28] = 1, 1
    original = a.copy()
    check = ShooterTrackingCheck(8,7)
    for frame in range(9):
        check.record(frame,a)
    a[:] = -1
    for frame in reversed(range(9)):
        check.compare(frame,b if frame == 3 else original)
    assert check.finish() == dict(
        tracking_check=dict(anchor_frame=8,checked_frames=9,disagreement_frames=1,target_id=7),
        warnings=[dict(frame=3,kind="tracking_disagreement",track_ids=[7])])
    assert sample_mask(original).shape == (128,128)
    with pytest.raises(ValueError,match="did not finish"):
        ShooterTrackingCheck(2,7).finish()


def test_reverse_memory_pruning():
    conditions = {0:object(),28:object()}
    output = dict(cond_frame_outputs=conditions, non_cond_frame_outputs=dict.fromkeys(range(31)))
    prune_tracking(dict(output_dict_per_obj={0:output}),0,reverse=True)
    assert output["cond_frame_outputs"] is conditions
    assert list(output["non_cond_frame_outputs"]) == list(range(16))


@pytest.mark.parametrize("bad", [dict(checked_frames=8), dict(anchor_frame=9),
                                dict(disagreement_frames=0), dict(target_id=1)])
def test_check_metadata_cannot_claim_incomplete_or_unrelated_results(bad):
    check = dict(anchor_frame=8, checked_frames=9, disagreement_frames=1, target_id=7)
    result = dict(duration=.3, objects=[dict(id=7)],
                  warnings=[dict(frame=3, kind="tracking_disagreement", track_ids=[7])],
                  tracking_check=check)
    assert valid_tracking_check(result)
    result["tracking_check"] = {**check, **bad}
    assert not valid_tracking_check(result)


@pytest.mark.parametrize("flag", [0, 1, "true", None])
def test_native_verification_request_requires_a_boolean(flag):
    from backend.jumper.pipeline import validate_job
    job = dict(version=1, source="private.mp4", event_id="test", player_id="test",
               player_name="Test", identity_evidence="User selected track", start=0,
               end=.3, target_id=1, verify_shooter=flag,
               objects=[dict(id=1,prompts=[dict(frame=0,points=[[.5,.5]],labels=[1])])])
    with pytest.raises(ValueError, match="verification flag"):
        validate_job(job)


def test_native_passes_use_independent_memory_and_causal_confirmations(tmp_path, monkeypatch):
    import cv2
    import torch
    from backend.jumper import pipeline, frames as frame_module
    import sam2.build_sam

    states = []
    class Predictor:
        def add_new_points_or_box(self, state, frame_idx, obj_id, **kwargs):
            state["prompts"][frame_idx] = obj_id

        def propagate_in_video(self, state, start_frame_idx, max_frame_num_to_track=None, reverse=False):
            end = (start_frame_idx - max_frame_num_to_track if reverse else
                   start_frame_idx + max_frame_num_to_track) if max_frame_num_to_track is not None else 4
            for frame in range(start_frame_idx, end + (-1 if reverse else 1), -1 if reverse else 1):
                if reverse:
                    assert list(state["prompts"]) == [start_frame_idx], "reverse inherited forward/correction memory"
                else:
                    assert max(state["prompts"]) <= frame, "forward saw a future confirmation"
                logits = np.full((1,1,20,32), -1, dtype=np.float32)
                logits[0,0,2:18,20:28 if reverse and frame == 1 else 10] = 1
                if not (reverse and frame == 1):
                    logits[0,0,2:18,2:10] = 1
                yield frame, [7], torch.from_numpy(logits)

        def reset_state(self, state):
            state["released"] = True

    def state(*args):
        value = dict(prompts={}, output_dict_per_obj={})
        states.append(value)
        return value

    monkeypatch.setattr(pipeline, "check_device_mask_area", lambda *args: None)
    from backend.jumper import resources
    monkeypatch.setattr(resources, "check_resources", lambda *args, **kwargs: None)
    monkeypatch.setattr(sam2.build_sam, "build_sam2_video_predictor", lambda *args, **kwargs: Predictor())
    monkeypatch.setattr(frame_module, "bounded_state", state)
    from backend.jumper import cache
    monkeypatch.setattr(cache, "FrameCache", lambda *args: None)
    monkeypatch.setattr(cache, "cache_backbone", lambda *args, **kwargs: None)
    paths = []
    for i in range(5):
        path = tmp_path / f"{i}.png"
        cv2.imwrite(str(path), np.zeros((20,32,3), dtype=np.uint8))
        paths.append(path)
    job = dict(start=0,end=5/30,target_id=7,verify_shooter=True,
               objects=[dict(id=7,prompts=[dict(frame=f,points=[[.2,.5]],labels=[1]) for f in (0,2,4)])])
    progress = []
    warnings = pipeline.track(paths,tmp_path/"masks",job,tmp_path/"weights","cpu",
                              lambda *args: progress.append(args))
    assert [w for w in warnings if w["kind"] == "tracking_disagreement"] == [dict(frame=1,kind="tracking_disagreement",track_ids=[7])]
    assert job["_tracking_check"] == dict(anchor_frame=4,target_id=7,checked_frames=5,disagreement_frames=1)
    assert len(states) == 3 and all(s["released"] for s in states)
    assert sum(len(args) == 3 and args[2] == "Checking shooter backward" for args in progress) == 5

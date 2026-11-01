"""Opening-frame prompt perturbations; kept equivalent to selectionStability.ts."""
import copy
import numpy as np
from .correction_points import correction_prompt

CONFIRM_SELECTION = (
    'Your starting shooter selection changes with nearby points. Add another Include point '
    'on a different visible part of the same shooter in the first frame, then retry · '
    'If the player is too small or obscured, use a closer or clearer segment'
)


def stable_selection(a, b):
    if (a.shape != (256,256) or b.shape != a.shape
            or not np.isfinite(a).all() or not np.isfinite(b).all()):
        return False
    first, second = a > 0, b > 0
    area, other = int(first.sum()), int(second.sum())
    intersection = int((first & second).sum())
    return (area >= 4 and other >= 4 and .75 <= other / area <= 4 / 3
            and intersection / (area + other - intersection) >= .75)


def selection_probes(prompt, mask):
    labels, points = prompt.get('labels', []), prompt.get('points', [])
    if 'box' not in prompt or 1 not in labels or not points:
        return []
    if not stable_selection(mask, mask):
        raise ValueError(CONFIRM_SELECTION)
    included = labels.index(1)
    left, top, right, bottom = prompt['box']
    width, height = right-left, bottom-top
    seed = points[included]
    ys, xs = np.nonzero(mask >= 1)
    candidates = np.column_stack(((xs+.5)/256, (ys+.5)/256))
    keep = ((candidates[:,0] > left) & (candidates[:,0] < right)
            & (candidates[:,1] > top) & (candidates[:,1] < bottom)
            & (np.abs(candidates[:,0]-seed[0]) <= .22*width)
            & (np.abs(candidates[:,1]-seed[1]) <= .18*height)
            & (np.linalg.norm(candidates-seed,axis=1) >= 2/256))
    for point in points:
        keep &= np.linalg.norm(candidates-point,axis=1) >= 2/256
    candidates = candidates[keep]
    found = []
    for dx,dy in ((.12,0),(-.12,0),(0,.1),(0,-.1)):
        available = candidates
        for point in found:
            available = available[np.linalg.norm(available-point,axis=1) >= 2/256]
        if len(available):
            aim = np.array(seed) + [dx*width,dy*height]
            distances = (((available-aim)/[width,height])**2).sum(axis=1)
            found.append(available[int(distances.argmin())].tolist())
        if len(found) == 3:
            break
    if len(found) < 2:
        raise ValueError(CONFIRM_SELECTION)
    result = []
    for point in found:
        probe = copy.deepcopy(prompt)
        probe['points'][included] = point
        result.append(probe)
    return result


def check_opening_selection(predictor, frames, prompt, target_id, width, height):
    """Independent one-frame state; original tracking state and prompts stay intact."""
    prompt = correction_prompt(prompt, target_id, (width, height))
    if 'box' not in prompt or 1 not in prompt.get('labels', []):
        return
    import torch
    from .frames import bounded_state
    from .model_outputs import validate_array
    state = bounded_state(predictor, frames[:1])
    def predict(probe):
        probe = correction_prompt(probe, target_id, (width, height))
        predictor.reset_state(state)  # No previous mask, pointers or memory.
        predictor.add_new_points_or_box(
            state, frame_idx=0, obj_id=target_id,
            box=np.array(probe['box'],dtype=np.float32)*[width,height,width,height],
            points=np.array(probe['points'],dtype=np.float32)*[width,height],
            labels=np.array(probe['labels'],dtype=np.int32),
        )
        index = state['obj_id_to_idx'][target_id]
        output = state['temp_output_dict_per_obj'][index]['cond_frame_outputs'][0]
        low = output['pred_masks'].detach().float().cpu().numpy()
        validate_array(low,(1,1,256,256),'initial selection mask')
        return low[0,0].copy()
    try:
        with torch.inference_mode():
            baseline = predict(prompt)
            probes = selection_probes(prompt,baseline)
            compared = [baseline]
            for probe in probes:
                mask = predict(probe)
                if not all(stable_selection(previous,mask) for previous in compared):
                    raise ValueError(CONFIRM_SELECTION)
                compared.append(mask)
    finally:
        predictor.reset_state(state)

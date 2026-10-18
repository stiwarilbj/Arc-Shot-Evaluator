"""Explicit shooter confirmations reset only that identity's causal memory."""


def reset_shooter_memory(state, target):
    """Retain object IDs, shared image features and every other player's history.

    The pinned SAM 2 per-object state is intentionally checked before clearing;
    an incompatible state must fail safely rather than silently keep stale memory.
    """
    index = state['obj_id_to_idx'][target]
    outputs = state['output_dict_per_obj'][index]
    temporary = state['temp_output_dict_per_obj'][index]
    histories = [outputs['cond_frame_outputs'], outputs['non_cond_frame_outputs'],
                 temporary['cond_frame_outputs'], temporary['non_cond_frame_outputs'],
                 state['point_inputs_per_obj'][index], state['mask_inputs_per_obj'][index],
                 state['frames_tracked_per_obj'][index]]
    for history in histories:
        history.clear()

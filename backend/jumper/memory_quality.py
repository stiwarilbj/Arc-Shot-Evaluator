"""Conservative admission of SAM memories; rejected predictions stay reviewable."""
import functools
import inspect
import numpy as np


def causal_memory(at, output, frame, reverse):
    return (type(at) is int and at >= 0
            and output.get('_jumper_frame', at) == at
            and (frame - at) * (-1 if reverse else 1) > 0
            and output.get('_jumper_reliable', True))


def reliable_mask(values, previous=None, score=1):
    if (values.shape != (256, 256) or not np.isfinite(values).all()
            or not np.isfinite(score) or score <= 0):
        return False
    visible = values > 0
    area = int(visible.sum())
    if area < 4 or np.count_nonzero(values >= 1) / area < .25:
        return False
    if previous is not None:
        old = previous > 0
        old_area = int(old.sum())
        if old_area:
            intersection = np.count_nonzero(visible & old)
            iou = intersection / (area + old_area - intersection)
            y, x = np.nonzero(visible); old_y, old_x = np.nonzero(old)
            distance = np.hypot(x.mean()-old_x.mean(), y.mean()-old_y.mean()) / 256
            ratio = area / old_area
            if iou < .1 and (ratio < .25 or ratio > 4 or distance > .25):
                return False
    return True


class MemoryQualityGate:
    """Instance-local adapter for the pinned SAM predictor, including reverse runs.

    Compact outputs retain their actual masks and times. Quarantined outputs are
    filtered from attention (both spatial features and object pointers). One last
    reliable automatic output per object/direction survives ordinary pruning.
    """
    def __init__(self, predictor, warn, ignored_ids=(), target_id=None):
        self.target_id = target_id
        self.predictor = predictor
        self.warn = warn
        self.ignored_ids = set(ignored_ids)
        self.last = {}
        self.originals = {}
        self.instance_methods = set()
        if not hasattr(predictor, '_run_single_frame_inference'):
            return  # Lightweight fixture predictors have no internal SAM memory.
        self._wrap('_run_single_frame_inference', self.infer)
        self._wrap('_prepare_memory_conditioned_features', self.prepare)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def _wrap(self, name, operation):
        original = getattr(self.predictor, name)
        self.originals[name] = original
        if name in self.predictor.__dict__:
            self.instance_methods.add(name)
        signature = inspect.signature(original)
        @functools.wraps(original)
        def wrapped(*args, **kwargs):
            bound = signature.bind(*args, **kwargs)
            bound.apply_defaults()
            return operation(original, bound.arguments)
        setattr(self.predictor, name, wrapped)

    @staticmethod
    def pixels(output):
        return output['pred_masks'][0, 0].detach().float().cpu().numpy()

    def references(self, outputs, frame, reverse):
        direction = -1 if reverse else 1
        entries = {**outputs['cond_frame_outputs'], **outputs['non_cond_frame_outputs']}
        saved = self.last.get((id(outputs), reverse))
        if saved:
            entries.setdefault(saved[0], saved[1])
        return sorted(((at, out) for at, out in entries.items()
                       if causal_memory(at, out, frame, reverse)),
                      key=lambda entry: (frame-entry[0])*direction)

    def infer(self, original, args):
        frame, reverse = args['frame_idx'], args['reverse']
        outputs = args['output_dict']
        # SAM normally backfills an identity from its future first prompt. Match
        # the browser's not-yet-selected behavior without consulting that mask.
        seeds = outputs['cond_frame_outputs']
        if (not reverse and not args['is_init_cond_frame'] and seeds
                and frame < min(seeds) and args['point_inputs'] is None
                and args['mask_inputs'] is None):
            import torch
            state = args['inference_state']
            masks = torch.full((args['batch_size'], 1, 256, 256), -1024.0,
                               device=state['device'])
            return dict(pred_masks=masks.to(state['storage_device']),
                        object_score_logits=masks.new_full((args['batch_size'], 1), -1024),
                        obj_ptr=masks.new_zeros((args['batch_size'], 256)),
                        maskmem_features=None, maskmem_pos_enc=None,
                        _jumper_reliable=False, _jumper_frame=frame), masks
        output, masks = original(**args)
        output['_jumper_frame'] = frame
        # Human prompts can legitimately move an anchor; test their own confidence
        # but do not reject them merely for differing from an older location.
        prompted = args['point_inputs'] is not None or args['mask_inputs'] is not None
        references = self.references(outputs, frame, reverse)
        previous = self.pixels(references[0][1]) if references and not prompted else None
        state = args['inference_state']
        identity = next((state['obj_idx_to_id'][i] for i, value in
                         state['output_dict_per_obj'].items() if value is outputs), None)
        score = float(output['object_score_logits'].reshape(-1)[0].item())
        # Excluded tracks never contribute to an included player's independent
        # memory. Retain their existing discovery behavior without review flags.
        accepted = identity in self.ignored_ids or reliable_mask(self.pixels(output), previous, score)
        output['_jumper_reliable'] = accepted
        if not accepted and identity != self.target_id:
            self.warn(frame, identity)
        return output, masks

    def prepare(self, original, args):
        if args['is_init_cond_frame']:
            return original(**args)
        outputs, frame, reverse = args['output_dict'], args['frame_idx'], args['track_in_reverse']
        filtered = {name: {at: out for at, out in outputs[name].items()
                           if causal_memory(at, out, frame, reverse)}
                    for name in ('cond_frame_outputs', 'non_cond_frame_outputs')}
        references = self.references(outputs, frame, reverse)
        if references:
            self.last[(id(outputs), reverse)] = references[0]
        if references and abs(frame-references[0][0]) > 6:
            at, output = references[0]
            filtered['cond_frame_outputs'].setdefault(at, output)
            filtered['non_cond_frame_outputs'].pop(at, None)
        if not filtered['cond_frame_outputs']:
            raise ValueError(f'No reliable player reference at frame {frame + 1}. Add an Include point on a clear frame and retry.')
        return original(**{**args, 'output_dict': filtered})

    def reset_object(self, state, identity):
        if not self.originals:
            return
        outputs = state['output_dict_per_obj'][state['obj_id_to_idx'][identity]]
        for key in list(self.last):
            if key[0] == id(outputs):
                del self.last[key]

    def clear(self):
        self.last.clear()

    def close(self):
        for name, original in self.originals.items():
            if name in self.instance_methods:
                setattr(self.predictor, name, original)
            else:
                delattr(self.predictor, name)
        self.originals.clear()
        self.clear()

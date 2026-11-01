"""Export all native SAM mask tokens and small learned tracking constants.

The community ONNX decoder exposes only multimask tokens, which cannot represent
native box/multi-point correction behavior. This replacement retains all four.
Run outside deployment; published weights retain SAM's Apache-2.0 license.
"""

import argparse
import json
from pathlib import Path
import torch
from sam2.build_sam import build_sam2_video_predictor


class Decoder(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, feats0, feats1, feats2, points, labels):
        m = self.model
        sparse, dense = m.sam_prompt_encoder(
            points=(points, labels), boxes=None, masks=None
        )
        masks, quality, tokens, scores = m.sam_mask_decoder.predict_masks(
            image_embeddings=feats2,
            image_pe=m.sam_prompt_encoder.get_dense_pe(),
            sparse_prompt_embeddings=sparse,
            dense_prompt_embeddings=dense,
            repeat_image=False,
            high_res_features=[feats0, feats1],
        )
        visible = (scores > 0).float()
        masks = torch.where(scores[:, :, None, None] > 0, masks, -1024.0)
        pointers = (
            visible[:, :, None] * m.obj_ptr_proj(tokens)
            + (1 - visible[:, :, None]) * m.no_obj_ptr[:, None, :]
        )
        return masks, quality, pointers, scores


class MemoryEncoder(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, vision_features, pred_masks_high_res, object_score_logits):
        m = self.model
        memory = m.memory_encoder(
            vision_features,
            torch.sigmoid(pred_masks_high_res) * 20 - 10,
            skip_mask_sigmoid=True,
        )
        tokens = (
            memory["vision_features"]
            + (1 - (object_score_logits > 0).float())[:, :, None, None]
            * m.no_obj_embed_spatial[:, :, None, None]
        )
        return tokens.flatten(2).permute(2, 0, 1), memory["vision_pos_enc"][-1].flatten(
            2
        ).permute(2, 0, 1)


def export(checkpoint, destination):
    destination.mkdir(parents=True, exist_ok=True)
    torch.set_num_threads(4)
    m = build_sam2_video_predictor(
        "configs/sam2.1/sam2.1_hiera_t.yaml",
        str(checkpoint),
        device="cpu",
        apply_postprocessing=False,
    ).eval()
    decoder = Decoder(m).eval()
    args = (
        torch.zeros(1, 32, 256, 256),
        torch.zeros(1, 64, 128, 128),
        torch.zeros(1, 256, 64, 64),
        torch.zeros(1, 2, 2),
        torch.tensor([[2, 3]], dtype=torch.int64),
    )
    with torch.inference_mode():
        torch.onnx.export(
            decoder,
            args,
            str(destination / "native_mask_decoder.onnx"),
            input_names=["feats0", "feats1", "feats2", "points", "labels"],
            output_names=["masks", "quality", "pointers", "scores"],
            dynamic_axes={"points": {1: "num_points"}, "labels": {1: "num_points"}},
            opset_version=17,
            dynamo=False,
        )
        torch.onnx.export(
            MemoryEncoder(m),
            (args[2], torch.zeros(1, 1, 1024, 1024), torch.ones(1, 1)),
            str(destination / "native_memory_encoder.onnx"),
            input_names=[
                "vision_features",
                "pred_masks_high_res",
                "object_score_logits",
            ],
            output_names=["memory_tokens", "memory_pos_enc"],
            opset_version=17,
            dynamo=False,
        )
    data = {
        "version": 1,
        "no_mem_embed": m.no_mem_embed.detach().flatten().tolist(),
        "maskmem_tpos_enc": m.maskmem_tpos_enc.detach().reshape(7, 64).tolist(),
        "pointer_weight": m.obj_ptr_tpos_proj.weight.detach().tolist(),
        "pointer_bias": m.obj_ptr_tpos_proj.bias.detach().tolist(),
        "license": "Apache-2.0",
        "source": "https://github.com/facebookresearch/sam2",
    }
    (destination / "native_tracker.json").write_text(
        json.dumps(data, separators=(",", ":"))
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("checkpoint", type=Path)
    parser.add_argument("destination", type=Path)
    a = parser.parse_args()
    export(a.checkpoint, a.destination)

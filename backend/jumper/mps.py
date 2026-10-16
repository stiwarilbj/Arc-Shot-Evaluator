"""Real-valued rotary attention for MPS; avoids complex-tensor tracking drift."""

import math
from types import MethodType
import torch
from torch.nn import functional as F


def rotate(values, cosine, sine):
    pairs = values.float().reshape(*values.shape[:-1], -1, 2)
    return (
        torch.stack(
            (
                pairs[..., 0] * cosine - pairs[..., 1] * sine,
                pairs[..., 0] * sine + pairs[..., 1] * cosine,
            ),
            dim=-1,
        )
        .flatten(-2)
        .to(values.dtype)
    )


def forward(self, q, k, v, num_k_exclude_rope=0):
    q = self._separate_heads(self.q_proj(q), self.num_heads)
    k = self._separate_heads(self.k_proj(k), self.num_heads)
    v = self._separate_heads(self.v_proj(v), self.num_heads)
    size = int(math.sqrt(q.shape[-2]))
    # Frequencies are formed on CPU, then transferred as ordinary real tensors.
    frequencies = self.compute_cis(end_x=size, end_y=size).cpu()
    cosine = frequencies.real.to(q.device)
    sine = frequencies.imag.to(q.device)
    count = k.shape[-2] - num_k_exclude_rope
    q = rotate(q, cosine, sine)
    if count:
        repeats = count // frequencies.shape[0]
        k = torch.cat(
            (
                rotate(
                    k[:, :, :count], cosine.repeat(repeats, 1), sine.repeat(repeats, 1)
                ),
                k[:, :, count:],
            ),
            dim=-2,
        )
    value = F.scaled_dot_product_attention(q, k, v, dropout_p=0.0)
    return self.out_proj(self._recombine_heads(value))


def enable_real_rotary(model):
    from sam2.modeling.sam.transformer import RoPEAttention

    for module in model.modules():
        if isinstance(module, RoPEAttention):
            module.forward = MethodType(forward, module)

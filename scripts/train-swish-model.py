#!/usr/bin/env python3
"""Offline-only training for Swish Tuner's residual trajectory network

Run with .venv/bin/python scripts/train-swish-model.py
The app never imports Python, trains a model, or calls an inference service
Labels follow swish-flight-v1's linear drag / spin lift / gravity equations
The independent JS validation tests compare exported weights against its RK4 solver
"""
import hashlib
import json
from pathlib import Path

import numpy as np
import torch

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "frontend/src/features/games/swish-model.json"
torch.set_num_threads(2)
torch.manual_seed(87231)
rng = np.random.default_rng(87231)


def samples(count):
    angle = rng.uniform(34.8, 75.2, count) * np.pi / 180
    speed = rng.uniform(5, 13, count)
    spin = rng.uniform(0, 5, count)
    time = rng.uniform(0, 4, count)
    # Explicit edge coverage, not only interior random examples
    for data, lo, hi in [(angle, 35 * np.pi / 180, 75 * np.pi / 180), (speed, 5, 13), (spin, 0, 5), (time, 0.02, 4)]:
        selected = rng.random(count) < 0.2
        data[selected] = rng.choice([lo, hi], selected.sum())
    vx, vy = speed * np.cos(angle), speed * np.sin(angle)
    # Integrate the same ODE in vector batches, with fractional final steps
    x, y = np.zeros(count), np.full(count, 2.0)
    ux, uy = vx.copy(), vy.copy()
    for step in range(960):
        dt = np.clip(time - step / 240, 0, 1 / 240)
        def a(u, v):
            return -0.035 * u - 0.012 * spin * v, -9.81 - 0.035 * v + 0.012 * spin * u
        ax, ay = a(ux, uy)
        bx, by = a(ux + ax * dt / 2, uy + ay * dt / 2)
        cx, cy = a(ux + bx * dt / 2, uy + by * dt / 2)
        dx, dy = a(ux + cx * dt, uy + cy * dt)
        x += dt * (ux + dt * (ax + bx + cx) / 6)
        y += dt * (uy + dt * (ay + by + cy) / 6)
        ux += dt * (ax + 2 * bx + 2 * cx + dx) / 6
        uy += dt * (ay + 2 * by + 2 * cy + dy) / 6
    # Dividing the ballistic residual by t² makes the learned correction smooth
    # at t=0; multiplying by t² in inference makes the launch point exact
    tx = (x - vx * time) / np.maximum(time * time, 1e-10)
    ty = (y - (2 + vy * time - 4.905 * time * time)) / np.maximum(time * time, 1e-10)
    features = np.stack([vx / 13, vy / 13, spin / 5, time / 4], axis=1)
    targets = np.stack([tx, ty], axis=1)
    return torch.tensor(features, dtype=torch.float32), torch.tensor(targets, dtype=torch.float32), time


train_x, train_y, _ = samples(40000)
test_x, test_y, test_t = samples(12000)
model = torch.nn.Sequential(torch.nn.Linear(4, 48), torch.nn.Tanh(), torch.nn.Linear(48, 48), torch.nn.Tanh(), torch.nn.Linear(48, 2))
optimizer = torch.optim.Adam(model.parameters(), lr=0.003)
for step in range(7500):
    index = torch.randint(len(train_x), (2048,))
    loss = ((model(train_x[index]) - train_y[index]) ** 2).mean()
    optimizer.zero_grad()
    loss.backward()
    optimizer.step()
    if step in (3500, 5500):
        for group in optimizer.param_groups:
            group["lr"] *= 0.25
    if step % 1500 == 0:
        print(f"step {step}: residual loss {loss.item():.8f}", flush=True)

# Full-batch refinement removes the remaining long-flight bias from minibatch SGD
refine = torch.optim.LBFGS(model.parameters(), lr=0.8, max_iter=1200, history_size=30, tolerance_grad=1e-10, tolerance_change=1e-13, line_search_fn="strong_wolfe")
def closure():
    refine.zero_grad()
    time_weight = 0.1 + (train_x[:, 3:4] * 4) ** 2
    objective = (((model(train_x) - train_y) * time_weight) ** 2).mean()
    objective.backward()
    return objective
refine.step(closure)
with torch.no_grad():
    errors = np.linalg.norm((model(test_x) - test_y).numpy(), axis=1) * test_t**2
metrics = {"samples": len(errors), "p99Meters": float(np.quantile(errors, 0.99)), "maxMeters": float(errors.max())}
print(json.dumps(metrics), flush=True)
if metrics["p99Meters"] > 0.02 or metrics["maxMeters"] > 0.05:
    raise SystemExit("Model failed publication accuracy gate; existing artifact was preserved")
layers = [layer for layer in model if isinstance(layer, torch.nn.Linear)]
artifact = {
    "version": 1, "engine": "swish-flight-v1", "seed": 87231,
    "architecture": [4, 48, 48, 2], "activation": "tanh",
    "normalization": [13, 13, 5, 4], "residual": "ballistic-plus-t-squared",
    "validation": metrics,
    "layers": [{"weights": layer.weight.detach().numpy().round(9).tolist(), "bias": layer.bias.detach().numpy().round(9).tolist()} for layer in layers],
}
DEST.write_text(json.dumps(artifact, separators=(",", ":")) + "\n")
print(f"Wrote {DEST.stat().st_size} bytes; SHA-256 {hashlib.sha256(DEST.read_bytes()).hexdigest()}")

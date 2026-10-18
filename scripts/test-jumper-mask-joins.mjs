import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MaskJoins } from "../frontend/src/features/jumper/maskJoins.ts";
import { maskExtents } from "../frontend/src/features/jumper/maskQuality.ts";
import { unstableMask } from "../frontend/src/features/jumper/domain.ts";
import { maskResult } from "../frontend/src/features/jumper/domain.ts";
import { warningLabels } from "../frontend/src/features/jumper/warningTimeline.ts";
const fixtures = JSON.parse(
  readFileSync(
    new URL("../tests/fixtures/jumper/mask-joins.json", import.meta.url),
  ),
);
for (const f of fixtures) {
  const joins = new MaskJoins(f.width, f.height);
  const tracks = [1, 2].map((id) => ({
    id,
    ignored: id === f.ignored,
    prompts: [
      { frame: 0, box: [0, 0, 1, 1] },
      ...(f.correction
        ? [{ frame: f.correction, points: [[0.5, 0.5]], labels: [1] }]
        : []),
    ],
  }));
  let previousExtent;
  for (const [n, frame] of f.frames.entries()) {
    joins.begin();
    for (const id of [1, 2]) {
      const values = new Float32Array(f.width * f.height).fill(-1);
      for (const [identity, l, t, r, b] of frame.raw)
        if (identity === id)
          for (let y = t; y < b; y++)
            values.fill(1, y * f.width + l, y * f.width + r);
      joins.add(id, values, f.width, f.height);
      values.fill(-100); // snapshots own their pixels
    }
    const owners = new Uint8Array(f.width * f.height);
    for (const [id, l, t, r, b] of frame.owners)
      for (let y = t; y < b; y++)
        owners.fill(id, y * f.width + l, y * f.width + r);
    const extent = maskExtents(owners, f.width, f.height).get(1);
    if (n === 1 && ["sudden body takeover below existing area limit", "no total area increase required"].includes(f.name))
      assert.equal(unstableMask(previousExtent, extent), false, "legacy area/motion limits miss this join");
    previousExtent = extent;
    const before = owners.slice();
    const warnings = joins.inspect(
      frame.at ?? n,
      owners,
      f.width,
      f.height,
      tracks,
      f.boxes,
      frame.reset,
    );
    assert.deepEqual(
      warnings.map((w) => w.frame),
      f.expected[n],
      `${f.name}: frame ${n}`,
    );
    assert(
      warnings.every(
        (w) => w.kind === "mask_joined" && w.track_ids.length === 2,
      ),
    );
    assert.deepEqual(owners, before);
    owners.fill(0);
    const blob = new Blob(["video"], { type: "video/mp4" });
    assert(
      maskResult({
        objects: tracks,
        duration: 1,
        highlight: blob,
        quiz: blob,
        reveal: blob,
        warnings,
      }),
    );
  }
}
assert.equal(warningLabels.mask_joined, "Possible joined players");
console.log(
  `PASS ${fixtures.length} shared pair-join fixtures: ownership, raw pixels, detection cores, persistence, correction/reset, ignored players and immutable bounded history`,
);

import assert from "node:assert/strict";
import { parsePublicManifest } from "../frontend/src/features/jumper/publicManifest.ts";
function manifest(count = 2, players = 2, kind = "starter") {
  let serial = 1;
  const asset = (extension) => {
    const n = serial++;
    return {
      file: `${n.toString(16).padStart(32, "0")}.${extension}`,
      sha256: n.toString(16).padStart(64, "0"),
      bytes: 100,
    };
  };
  return {
    version: 1,
    release: "test-only",
    collection_kind: kind,
    clip_count: count,
    player_count: players,
    players: Array.from({ length: players }, (_, i) => ({
      id: `player-${i}`,
      name: `Player ${i}`,
      aliases: [],
    })),
    clips: Array.from({ length: count }, (_, i) => ({
      id: i.toString(16).padStart(32, "0"),
      player_id: `player-${i % players}`,
      event_id: `shot-${i}`,
      duration: 3,
      fps: 30,
      frame_count: 90,
      quiz: asset("mp4"),
      reveal: asset("mp4"),
      thumbnail: asset("png"),
      provenance: {
        source_url: "https://example.org/source",
        identity_url: "https://example.org/identity",
        permission_url: "https://example.org/license",
        license: "TEST ONLY",
        attribution: "Synthetic test fixture",
        changes: "Synthetic",
      },
    })),
  };
}
const base = "/Arc-Shot-Evaluator/jumper/catalog/";
const starter = parsePublicManifest(manifest(), base);
assert.equal(starter.kind, "starter");
assert.equal(starter.clips.length, 2);
assert.ok(starter.clips[0].quiz.startsWith(base));
assert.equal(starter.clips[0].provenance.attribution, "Synthetic test fixture");
const legacy = manifest(300, 60);
delete legacy.collection_kind;
assert.equal(parsePublicManifest(legacy, base).kind, "complete");
assert.equal(
  parsePublicManifest(manifest(300, 60, "complete"), base).clips.length,
  300,
);
for (const invalid of [
  manifest(1, 2),
  manifest(2, 1),
  manifest(299, 60, "complete"),
  manifest(300, 59, "complete"),
  manifest(2, 2, "pilot"),
  null,
  {},
  [],
])
  assert.throws(() => parsePublicManifest(invalid, base));
for (const corrupt of [
  (m) => delete m.collection_kind,
  (m) => delete m.release,
  (m) => (m.clip_count = 300),
  (m) => (m.players[1] = m.players[0]),
  (m) => (m.clips[1].player_id = m.clips[0].player_id),
  (m) => (m.clips[1].id = m.clips[0].id),
  (m) => (m.clips[1].event_id = m.clips[0].event_id),
  (m) => (m.clips[1].quiz = m.clips[0].quiz),
  (m) => (m.clips[0].quiz.file = "../escape.mp4"),
  (m) => (m.clips[0].quiz.sha256 = "bad"),
  (m) => (m.clips[0].frame_count = 91),
  (m) => (m.clips[0].provenance.attribution = ""),
  (m) => (m.clips[0].provenance.permission_url = "javascript:alert(1)"),
  (m) => (m.clips[0] = null),
]) {
  const value = manifest();
  corrupt(value);
  assert.throws(() => parsePublicManifest(value, base));
}
console.log(
  "Starter/complete catalog gates, legacy thresholds, identity/timeline/provenance, safe paths: passed",
);

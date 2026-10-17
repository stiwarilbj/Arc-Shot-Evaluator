import assert from "node:assert/strict";
import {
  DEFAULT_LOCATION,
  readWorkspaceHash,
  workspaceHash,
} from "../frontend/src/app/workspaceLocation.ts";

const routes = [
  ["#home", { workspace: "home" }],
  ["#shot-analyzer", { workspace: "analyzer", analysisView: "shot" }],
  [
    "#shot-analyzer/overview",
    { workspace: "analyzer", analysisView: "overview" },
  ],
  [
    "#shot-analyzer/tracking",
    { workspace: "analyzer", analysisView: "tracking" },
  ],
  ["#playbook", { workspace: "playbook" }],
  ["#counter-lab", { workspace: "counterlab" }],
  ["#jumper", { workspace: "jumper", jumperView: "guess" }],
  ["#jumper/create", { workspace: "jumper", jumperView: "create" }],
  ["#jumper/my-clips", { workspace: "jumper", jumperView: "clips" }],
];
for (const [hash, patch] of routes) {
  const expected = { ...DEFAULT_LOCATION, ...patch };
  assert.deepEqual(readWorkspaceHash(hash), expected);
  assert.equal(workspaceHash(expected), hash);
}
for (const hash of [
  "",
  "#",
  "#unknown",
  "#jumper/unknown",
  "#%E0%A4%A",
  "#playbook?bad=1",
])
  assert.deepEqual(readWorkspaceHash(hash), DEFAULT_LOCATION);
assert.equal(workspaceHash(readWorkspaceHash("#jumper/guess")), "#jumper");

// Entering another workspace retains its siblings' selected views in memory.
const remembered = readWorkspaceHash(
  "#jumper/create",
  readWorkspaceHash("#shot-analyzer/tracking"),
);
const playbook = readWorkspaceHash("#playbook", remembered);
assert.equal(playbook.jumperView, "create");
assert.equal(playbook.analysisView, "tracking");
assert.equal(
  workspaceHash({ ...playbook, workspace: "jumper" }),
  "#jumper/create",
);
// A historical URL takes precedence over that remembered view.
assert.equal(readWorkspaceHash("#jumper", playbook).jumperView, "guess");
assert.equal(
  readWorkspaceHash("#shot-analyzer", playbook).analysisView,
  "shot",
);
const home = readWorkspaceHash("#home", remembered);
assert.equal(home.analysisView, "tracking");
assert.equal(home.jumperView, "create");
assert.equal(DEFAULT_LOCATION.workspace, "home");
console.log(
  "Workspace fragments: unique routes, nested views, canonical defaults, malformed fragments and remembered views passed",
);

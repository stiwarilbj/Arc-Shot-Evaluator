# Who’s That Jumper? — preparation status

**Public collection: zero approved clips.** The personal-first application is
implemented separately; see [the editor guide](jumper-editor.md). The 300-shot /
approximately 60-player NBA pack has not been acquired or approved. Earlier
rejected practice pilots remain rejected and are never quiz content.

Offline preparation and the downloaded editor now share
`backend/jumper/pipeline.py`. Importing it does not load a model. Publication
still requires identity/provenance checks, complete motion review and pack gates.

## Footage research

Checked October 16, 2026:

| Source | Finding | Decision |
| --- | --- | --- |
| [NBA terms](https://www.nba.com/termsofuse) | No documented general grant for the planned modified, publicly rehosted video collection was established. | Do not bulk-download and publish NBA-hosted clips as cleared footage. |
| [2012 Team USA practice, Tim Shelby](https://commons.wikimedia.org/wiki/File:2012_Team_USA_basketball_practice.ogv) | The file page declares CC BY 2.0. Short practice footage has cropped bodies, heavy overlaps, and camera reframing. | Used outside the repository for a tracking stress test. Not an accepted quiz shot or a replacement for the NBA collection. |
| [NBA Games metadata dataset](https://github.com/choucisan/nba_games) | Provides video references, not redistributed footage or a general video-rehosting license. | Useful identity research; does not satisfy acquisition. |
| [PL-NBA availability statement](https://arxiv.org/html/2608.19646v1#S3.SS4) | Describes academic/research restrictions. | No documented permission established for this public guessing game. |
| [Individual-play downloader](https://github.com/alijkhalil/nba_pbp_video_dataset) | Can locate/download NBA clips; no video-reuse grant found. | Download capability is not clearance for publication. |

No paid license, API, compute service, or subscription was purchased or enabled.
No footage-owner messages were sent. Acquisition remains a dependency: obtain
appropriate source footage with documented editing and public-hosting permission,
then verify each event and shooter. The research does not establish that such a
collection is impossible to obtain; it has not been obtained here.

## Implemented offline tools

`scripts/jumper_prepare.py` is an offline CLI, separate from app startup. It:

- Validates a segment and explicit foreground object prompts before inference.
- Proposes person boxes using an explicitly supplied local YOLO checkpoint.
  A person detector does not identify the shooter and may include spectators;
  select the court participants manually.
- Uses the native **SAM 2.1 Tiny video predictor**, including tracking memory,
  multiple objects, and corrective positive/negative prompts on selected frames.
  It does not substitute independent image segmentation for video tracking.
- Supports MPS/CUDA/CPU selection and a visible CPU restart after accelerator
  failure. Frames and tracking state are offloaded to CPU to limit GPU residency.
- Decodes a bounded segment with rotation applied, preserves aspect ratio, limits
  dimensions to 1280×720, and samples one shared 30 Hz timeline. Timing precedes
  resizing to avoid the observed last-frame loss in the FFmpeg filter chain.
- Renders three synchronized, muted H.264 MP4s: black-target/gray-others quiz,
  original-foreground reveal, and original-target/gray-others highlight. All three
  begin from a new flat RGB(224,224,224) canvas. Only labeled foreground pixels
  can be copied. There is no original court/background layer or original audio.
- Produces an opaque PNG quiz thumbnail. Video filenames contain no player names.
- Detects empty target masks and possible hard cuts and records warnings. These
  are conservative diagnostics, **not a complete identity-loss detector**.
- Resumes completed extraction/tracking/rendering stages only after checking their
  hashes. Changed footage, prompts, weights, tracker code/configuration, pipeline,
  Torch version, FFmpeg version, or requested device create a different run.
  An interrupted tracking stage restarts with fresh tracking memory; it does not
  resume from unsafe serialized tensors halfway through a track.
- Requires the work directory to be outside the repository. Model weights,
  frames, raw videos, masks, prompts, and review reports are not site assets.

`scripts/jumper_pack.py` builds a candidate release archive from externally
reviewed report/review pairs. It requires every review check, evidence links,
output checksums, no unresolved tracking warnings, 3–6 second paired timelines,
at least two distinct shots and two canonical players for an explicitly designated
starter collection. Complete collections (including legacy manifests without a
designation) still require 300 distinct shots and 60 players. It rejects duplicates,
stale reviews, changed/missing videos, nonopaque filenames, and symlinked media.
Clip IDs derive from source/event identity and survive mask revisions. Only quiz,
reveal, thumbnail, provenance, and canonical player records enter the public pack;
highlight exports and raw processing materials stay private.

The pack builder enforces **600 MiB**, compressed and uncompressed. Its `budget`
command enforces **800 MiB** for the full Pages artifact. The existing Pages
deployment workflow runs that size check after restoring examples; no new CI
workflow or deployment-time inference was added. A failed pack build leaves an
existing pack intact. No pack is currently configured for publication. The October 16 acquisition
audit is recorded in [the starter status](jumper-starter-status.md).

## Reproducing preparation

Run normal project setup first; `scripts/setup.sh` installs the pinned native SAM
dependencies for personal creation. Models are never loaded by importing the
preparation module or opening Guess. The offline pilot used the official repository at
`2b90b9f5ceec907a1c18123530e92e794ad901a4` and the official Tiny checkpoint.
See [SAM installation and video usage](https://github.com/facebookresearch/sam2)
and its Apache 2.0 license. Review the license for any detector checkpoint used
too; installing a model does not clear source footage rights.

For a separate offline preparation checkout, put SAM and its checkpoint in an
external directory. The following optional development install replaces the
pinned setup dependency with that checkout:

```bash
SAM2_BUILD_CUDA=0 uv pip install --python .venv/bin/python \
  --no-build-isolation -e /absolute/path/to/sam2
```

Use the official `sam2.1_hiera_tiny.pt` download linked in the SAM README. The
pilot's checkpoint SHA-256 was:

```text
7402e0d864fa82708a20fbd15bc84245c2f26dff0eb43a4b5b93452deb34be69
```

Create an external job JSON. This example is a schema example, **not source
footage, verified identity evidence, or an approved clip**:

```json
{
  "version": 1,
  "source": "/absolute/private/source.mp4",
  "event_id": "canonical-source-event-id",
  "player_id": "canonical-player-id",
  "player_name": "Verified Player Name",
  "identity_evidence": "How the source establishes this shooter",
  "start": 1.5,
  "end": 5.5,
  "target_id": 1,
  "objects": [
    {
      "id": 1,
      "prompts": [
        { "frame": 0, "box": [0.1, 0.1, 0.4, 0.9] },
        { "frame": 30, "points": [[0.3, 0.4], [0.5, 0.5]], "labels": [1, 0] }
      ]
    },
    { "id": 2, "prompts": [{ "frame": 0, "box": [0.6, 0.1, 0.9, 0.9] }] }
  ]
}
```

Coordinates are normalized to the **rotation-corrected** frame. Frame indexes
refer to the trimmed 30fps timeline. Every selected person needs a frame-zero
prompt; later entries refine the same tracked object. Positive labels are `1`,
negative labels `0`. Select all visible court players, not spectators, shadows,
or reflections. Correct masks to exclude any held ball: this implementation
omits the ball rather than preserving its colors. SAM may include a ball or
background in a mask, so generated masks always require review.

```bash
.venv/bin/python scripts/jumper_prepare.py propose /private/preview.jpg \
  --detector models/yolo11n-pose.pt
.venv/bin/python scripts/jumper_prepare.py prepare /private/job.json \
  --work /private/jumper-runs \
  --checkpoint /private/sam2.1_hiera_tiny.pt --device auto
```

Run one preparation process per work directory. Ctrl+C interrupts work; retry the
same command to reuse valid completed stages. Failures print an error; a missing
model never redirects work to a service. A completed run is marked `needs_review`,
never `approved`. A 15-second upload-editor limit is enforced for segments here,
but this is not the user upload editor or a 100 MB upload endpoint.

## Review and packaging

Review **every frame in motion**, including overlap transitions. A new run
fingerprint or modified output requires a new review. The report includes the
complete `review_checks_required` list. For a genuinely accepted clip create a
separate review JSON containing:

```json
{
  "version": 1,
  "fingerprint": "exact 64-character fingerprint from report.json",
  "report_sha256": "SHA-256 of the complete report.json file",
  "reviewer": "Actual reviewer",
  "reviewed_at": "2026-10-16T00:00:00Z",
  "checks": { "each key from review_checks_required": true },
  "aliases": [],
  "provenance": {
    "source_url": "https://source.example/event",
    "identity_url": "https://source.example/identity-evidence",
    "permission_url": "https://source.example/permission",
    "editing_allowed": true,
    "hosting_allowed": true,
    "license": "Actual permission or license",
    "attribution": "Required attribution"
  }
}
```

The checks object above is shorthand, not a valid approval. Copy every required
key from the actual report only after its check passes. Any unresolved warning,
identity uncertainty, body clipping, incomplete shot, incorrect silhouette,
flicker, background/ball leakage, or unmatched pair means correct and rerun, or
reject. Do not set booleans to bypass a failure. Human review is an attestation;
the pack tool checks evidence presence and hashes, not the truth of a license or
mask by itself. H.264 compression introduces small edge/color variations; exact
palette tests apply before encoding, and encoded clips require visual review.

An external collection file has `version: 1`, `release: "jumper-v1"`, and a
`clips` array of `{ "report": "relative/path/report.json", "review":
"relative/path/review.json" }` entries. Every entry must be a real reviewed event. Set `"collection_kind": "starter"`
for a reviewed two-shot/two-player minimum, or `"collection_kind": "complete"`
for the 300-shot/60-player minimum. An omitted designation keeps the complete
requirements; unknown designations fail. The builder, release verifier and
browser enforce the same minimums and actual counts.

```bash
.venv/bin/python scripts/jumper_pack.py build /private/collection.json /private/media.tar.gz
python3 scripts/jumper_pack.py budget frontend/dist
.venv/bin/python -m pytest tests/test_jumper_preparation.py -q
```

Successful packaging creates a candidate `.tar.gz` and SHA-256 sidecar; it does
not upload a Release or change the site. Versioned Release retrieval, archive
verification in deployment, and feature mounting remain future integration work
after the collection is ready.

## First pilot and remaining acceptance work

The M4 pilot used a 3-second, 90-frame, five-person tracking stress segment at
26.5–29.5 seconds of the licensed practice video. Source SHA-256:
`7d121ec1f178dffb08adf3ed175ca105b9a39213c5e6dbb1550bef9ad9a1195f`.
This segment was intentionally not assigned a quiz-player identity and is not
an isolated full jumpshot. Box prompts produced holes in the target mask and
interference between overlapping tracks. Sampled frames already failed review;
no full-motion approval was granted. It contributes **zero** public quiz clips.
Raw materials and rejected preview exports remain outside the repository.

The first run also exposed an encoder error-log cleanup bug, which was fixed and
covered by real MP4 encode/decode tests. Tracking masks were retained; preview
encoding was retried separately without rerunning inference. That is a technical
pilot, not a completed end-to-end accepted preparation run.

Before continuing publication: acquire cleared footage, produce a successful
representative jumpshot pilot with corrected prompts/masks, verify identities,
and review the full real collection. Browser SAM video memory/parity, GPU loss,
correction propagation, media codec/rotation/VFR handling, private persistence,
quiz scoring, autocomplete, accessibility, network isolation, and the complete
upload → save → reload → personal quiz workflows still require implementation
and acceptance testing on both targets. The feature is not ready to publish.

## Starter validation commands

Run `pnpm --dir frontend test:jumper` and
`.venv/bin/python -m pytest tests/test_jumper_preparation.py tests/test_jumper_release.py`.
These use synthetic packaging fixtures, never reviewed footage.

`scripts/test-jumper-starter-ui.mjs` verifies a production preview with a routed,
synthetic two-player catalog. Set `JUMPER_URL` to either build's preview and
`JUMPER_TEST_VIDEO` to an external muted three-second, 30fps synthetic MP4. It
checks counts, shuffle exhaustion, persisted scoring, reveal attribution, playback
failure, catalog retry, and absence of inference requests. Its fixture is not a
public pack and must never be published as NBA content.

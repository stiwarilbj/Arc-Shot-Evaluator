import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  collectBackup,
  encodeBackup,
  loadBackup,
  planRestore,
  validateManifest,
  personalClips,
} from "../frontend/src/features/jumper/backupArchive.ts";
import {
  readZip,
  checkedEntry,
  writeZip,
  MAX_BACKUP_BYTES,
  crc32,
} from "../frontend/src/features/jumper/backupZip.ts";
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "arc-backup-regression-"));
try {
  execFileSync(
    join(root, ".venv/bin/python"),
    [
      "-c",
      `
import json,sys,uuid
from pathlib import Path
import numpy as np
from backend.jumper.pipeline import encoder
from backend.jumper.backup import export_archive
p=Path(sys.argv[1]);identity='11111111-1111-4111-a111-111111111111'
saved=p/'native'/'saved'/identity;saved.mkdir(parents=True)
with encoder(saved/'highlight.mp4',64,48) as stream:
 for _ in range(3):stream.write(np.full((48,64,3),224,np.uint8).tobytes())
for kind in ('quiz','reveal'):(saved/f'{kind}.mp4').write_bytes((saved/'highlight.mp4').read_bytes())
value=dict(version=1,id=identity,player=dict(id=identity,name='Élan Shooter',aliases=['ES']),duration=.1,createdAt='2026-10-17T01:00:00Z',mime='video/mp4',quiz=True,presentation='silhouette')
(saved/'clip.json').write_text(json.dumps(value));export_archive(p/'native',p/'native.zip')
`,
      directory,
    ],
    { cwd: root },
  );
  const source = await loadBackup(
    new Blob([await readFile(join(directory, "native.zip"))]),
  );
  assert.equal(source.media.size, 1);
  assert.equal(source.manifest.clips[0].player.name, "Élan Shooter");
  const original = personalClips(source)[0];
  const answer = {
    id: "round-1",
    clipId: original.id,
    selected: original.player,
    correct: original.player,
    timestamp: "2026-10-17T03:00:00Z",
    outcome: true,
  };
  const backup = await collectBackup([original], [answer]);
  const zip = await encodeBackup(backup),
    opened = await loadBackup(zip);
  assert.equal(opened.manifest.history.length, 1);
  assert.equal((await readZip(zip)).size, 2);
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  const empty = await collectBackup([]);
  const first = await planRestore(opened, empty, true);
  assert.equal(first.backup.manifest.clips[0].id, original.id);
  const repeat = await planRestore(opened, first.backup, true);
  assert.equal(repeat.skipped, 1);
  assert.equal(repeat.backup.manifest.clips.length, 0);
  const different = await collectBackup([
    { ...original, player: { ...original.player, name: "Someone else" } },
  ]);
  const conflicting = await planRestore(opened, different, true);
  const copy = conflicting.backup.manifest.clips[0];
  assert.notEqual(copy.id, original.id);
  assert.notEqual(copy.player.id, original.player.id);
  assert.equal(conflicting.conflicts, 1);
  assert.equal(conflicting.history[0].clipId, copy.id);
  assert.equal(conflicting.history[0].correct.id, copy.player.id);
  const combined = {
    manifest: {
      ...different.manifest,
      clips: [...different.manifest.clips, copy],
    },
    media: new Map([...different.media, ...conflicting.backup.media]),
  };
  const retry = await planRestore(opened, combined, true);
  assert.equal(retry.skipped, 1);
  assert.equal(retry.backup.manifest.clips.length, 0);
  assert.equal(different.manifest.clips[0].player.name, "Someone else");
  const varied = await collectBackup([
    original,
    {
      ...original,
      id: "22222222-2222-4222-a222-222222222222",
      player: { ...original.player, name: "élan shooter" },
    },
  ]);
  assert.equal(
    (await planRestore(varied, varied, false)).skipped,
    2,
    "Historical labels with one player ID do not duplicate identical clips",
  );
  const old = await collectBackup([
    {
      ...original,
      id: "older-id",
      player: { ...original.player, id: "older-player" },
    },
  ]);
  const migrated = await planRestore(old, empty, false);
  assert.match(migrated.backup.manifest.clips[0].id, /^[a-f0-9-]{36}$/);
  assert.deepEqual(migrated.backup.manifest.clips[0].player.aliases, ["ES"]);
  assert.equal((await planRestore(opened, empty, false)).history.length, 0);
  await assert.rejects(() => loadBackup(new Blob(["bad zip"])));
  await assert.rejects(() => readZip({ size: MAX_BACKUP_BYTES + 1 }));
  await assert.rejects(() => checkedEntry("../escape", new Blob(["unsafe"])));
  const damaged = new Uint8Array(await zip.arrayBuffer());
  damaged[40] ^= 1;
  await assert.rejects(() => loadBackup(new Blob([damaged])));
  const entries = await readZip(zip),
    substituted = [];
  for (const [name, entry] of entries)
    substituted.push(
      await checkedEntry(
        name,
        name === "manifest.json" ? entry.blob : new Blob(["changed content"]),
      ),
    );
  await assert.rejects(
    () => loadBackup(writeZip(substituted)),
    /checksum|missing/i,
  );
  assert.throws(
    () =>
      validateManifest({
        ...opened.manifest,
        clips: [opened.manifest.clips[0], opened.manifest.clips[0]],
      }),
    /metadata/,
  );
  await writeFile(
    join(directory, "browser.zip"),
    new Uint8Array(await zip.arrayBuffer()),
  );
  execFileSync(
    join(root, ".venv/bin/python"),
    [
      "-c",
      `
from pathlib import Path
import json,sys,threading
from backend.jumper.backup import import_archive
p=Path(sys.argv[1]);result=import_archive(p/'browser-restored',p/'browser.zip',threading.RLock());assert result==dict(added=1,skipped=0)
value=json.loads(next((p/'browser-restored'/'saved').glob('*/clip.json')).read_text());assert value['player']['aliases']==['ES'];assert value['quiz']
`,
      directory,
    ],
    { cwd: root },
  );
  console.log(
    "Private backups: standard ZIP/CRC/SHA integrity, native/browser round trips, labels/variants/history, conflicts, repeat imports, old identities, and damaged files passed",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}

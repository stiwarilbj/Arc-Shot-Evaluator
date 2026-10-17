import {
  clip,
  attempt,
  type Clip,
  type PersonalClip,
  type Attempt,
  type Player,
  type Variant,
} from "./domain.ts";
import {
  checkedEntry,
  crc32,
  readZip,
  writeZip,
  MAX_METADATA_BYTES,
  type ZipEntry,
} from "./backupZip.ts";
export type MediaRef = { path: string; sha256: string; bytes: number };
export type BackupClip = Clip & {
  files: {
    highlight: MediaRef;
    quiz?: MediaRef;
    reveal?: MediaRef;
    base?: MediaRef;
  };
};
export type BackupManifest = {
  format: "arc-jumper-library";
  version: 1;
  createdAt: string;
  clips: BackupClip[];
  history?: Attempt[];
};
export type LoadedBackup = {
  manifest: BackupManifest;
  media: Map<string, Blob>;
};
export type Progress = (message: string) => void;
export function cleanPlayer(value: Player): Player {
  return { id: value.id, name: value.name, aliases: [...value.aliases] };
}
export function cleanClip(value: Clip): Clip {
  return {
    version: 1,
    id: value.id,
    player: cleanPlayer(value.player),
    duration: value.duration,
    createdAt: value.createdAt,
    mime: value.mime,
    quiz: value.quiz,
    ...(value.presentation ? { presentation: value.presentation } : {}),
    ...(value.project ? { project: structuredClone(value.project) } : {}),
  };
}
export function cleanAttempt(value: Attempt): Attempt {
  return {
    id: value.id,
    clipId: value.clipId,
    selected: cleanPlayer(value.selected),
    correct: cleanPlayer(value.correct),
    timestamp: value.timestamp,
    outcome: value.outcome,
  };
}
function validHistory(value: unknown): value is Attempt[] {
  return (
    Array.isArray(value) &&
    value.length <= 10000 &&
    new Set(value.map((v) => v?.id)).size === value.length &&
    value.every(
      (v) =>
        attempt(v) &&
        v.id.length > 0 &&
        v.id.length <= 100 &&
        v.clipId.length > 0 &&
        v.clipId.length <= 100 &&
        typeof v.timestamp === "string",
    )
  );
}
export function validateManifest(
  value: unknown,
): asserts value is BackupManifest {
  const v = value as BackupManifest;
  if (
    !v ||
    v.format !== "arc-jumper-library" ||
    v.version !== 1 ||
    typeof v.createdAt !== "string" ||
    !Number.isFinite(Date.parse(v.createdAt)) ||
    !Array.isArray(v.clips) ||
    v.clips.length > 1000 ||
    new Set(v.clips.map((c) => c?.id)).size !== v.clips.length ||
    (v.history !== undefined && !validHistory(v.history))
  )
    throw Error("Invalid ARCade Hoops backup metadata");
  for (const item of v.clips) {
    if (
      !clip(item) ||
      !item.files ||
      Object.keys(item.files).some(
        (k) => !["highlight", "quiz", "reveal", "base"].includes(k),
      )
    )
      throw Error("Invalid saved clip in backup");
    const required: Variant[] = [
      ...(item.quiz
        ? (["highlight", "quiz", "reveal"] as const)
        : (["highlight"] as const)),
      ...(item.project ? (["base"] as const) : []),
    ];
    if (Object.keys(item.files).length !== required.length)
      throw Error("Incomplete clip variants in backup");
    if (
      item.quiz &&
      (((item.presentation === "silhouette" ||
        item.presentation === "silhouette-palette-v1") &&
        new Set(Object.values(item.files).map((r) => r?.sha256)).size !== 1) ||
        (item.project && item.files.quiz?.sha256 !== item.files.reveal?.sha256))
    )
      throw Error("Quiz variants do not share the expected clean video");
    for (const kind of required) {
      const ref = item.files[kind],
        extension =
          (kind === "base" ? item.project!.baseMime : item.mime) === "video/mp4"
            ? "mp4"
            : "webm";
      if (
        !ref ||
        !/^[a-f0-9]{64}$/.test(ref.sha256) ||
        ref.path !== `media/${ref.sha256}.${extension}` ||
        !Number.isInteger(ref.bytes) ||
        ref.bytes <= 0 ||
        ref.bytes > 100 * 1024 * 1024
      )
        throw Error("Invalid backup media reference");
    }
  }
}
export async function sha256(blob: Blob) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()),
    ),
  ]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}
export async function collectBackup(
  clips: PersonalClip[],
  history?: Attempt[],
  progress: Progress = () => {},
): Promise<LoadedBackup> {
  const media = new Map<string, Blob>(),
    records: BackupClip[] = [];
  for (const [index, value] of clips.entries()) {
    if (!clip(value)) throw Error("Cannot back up invalid saved metadata");
    progress(`Reading clip ${index + 1} of ${clips.length}`);
    const files: BackupClip["files"] = {} as BackupClip["files"];
    const variants: Variant[] = [
      ...(value.quiz
        ? (["highlight", "quiz", "reveal"] as const)
        : (["highlight"] as const)),
      ...(value.project ? (["base"] as const) : []),
    ];
    for (const kind of variants) {
      const blob = kind === "quiz" ? value.quizVideo : value[kind];
      if (
        !(blob instanceof Blob) ||
        !blob.size ||
        blob.size > 100 * 1024 * 1024
      )
        throw Error("A saved video is missing or too large");
      const hash = await sha256(blob),
        path = `media/${hash}.${(kind === "base" ? value.project!.baseMime : value.mime) === "video/mp4" ? "mp4" : "webm"}`;
      files[kind] = { path, sha256: hash, bytes: blob.size };
      media.set(path, blob);
    }
    records.push({ ...cleanClip(value), files });
  }
  const manifest: BackupManifest = {
    format: "arc-jumper-library",
    version: 1,
    createdAt: new Date().toISOString(),
    clips: records,
    ...(history ? { history: history.map(cleanAttempt) } : {}),
  };
  validateManifest(manifest);
  return { manifest, media };
}
export async function encodeBackup(
  backup: LoadedBackup,
  progress: Progress = () => {},
) {
  validateManifest(backup.manifest);
  const entries: ZipEntry[] = [
    await checkedEntry(
      "manifest.json",
      new Blob([JSON.stringify(backup.manifest)]),
    ),
  ];
  for (const [index, [path, blob]] of [...backup.media.entries()].entries()) {
    progress(`Packing video ${index + 1} of ${backup.media.size}`);
    entries.push(await checkedEntry(path, blob));
  }
  return writeZip(entries);
}
export async function loadBackup(
  file: Blob,
  progress: Progress = () => {},
): Promise<LoadedBackup> {
  const entries = await readZip(file),
    json = entries.get("manifest.json")!;
  const data = new Uint8Array(await json.blob.arrayBuffer());
  if (data.length > MAX_METADATA_BYTES || crc32(data) !== json.crc)
    throw Error("Backup metadata checksum failed");
  const manifest: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(data),
  );
  validateManifest(manifest);
  const expected = new Map<string, MediaRef>();
  for (const clip of manifest.clips)
    for (const ref of Object.values(clip.files)) {
      const prior = expected.get(ref.path);
      if (prior && (prior.bytes !== ref.bytes || prior.sha256 !== ref.sha256))
        throw Error("Conflicting media references");
      expected.set(ref.path, ref);
    }
  if (entries.size !== expected.size + 1)
    throw Error("Backup contains missing or unexpected files");
  const media = new Map<string, Blob>();
  for (const [index, [path, ref]] of [...expected.entries()].entries()) {
    progress(`Verifying file ${index + 1} of ${expected.size}`);
    const entry = entries.get(path);
    if (
      !entry ||
      entry.blob.size !== ref.bytes ||
      (await sha256(entry.blob)) !== ref.sha256 ||
      crc32(new Uint8Array(await entry.blob.arrayBuffer())) !== entry.crc
    )
      throw Error("A backup video is missing or its checksum failed");
    media.set(path, entry.blob);
  }
  return {
    manifest: {
      ...manifest,
      clips: manifest.clips.map((v) => ({ ...cleanClip(v), files: v.files })),
      ...(manifest.history
        ? { history: manifest.history.map(cleanAttempt) }
        : {}),
    },
    media,
  };
}
export function personalClips(backup: LoadedBackup): PersonalClip[] {
  return backup.manifest.clips.map((value) => ({
    ...cleanClip(value),
    highlight: backup.media.get(value.files.highlight.path)!,
    ...(value.project
      ? { base: backup.media.get(value.files.base!.path)! }
      : {}),
    ...(value.quiz
      ? {
          quizVideo: backup.media.get(value.files.quiz!.path)!,
          reveal: backup.media.get(value.files.reveal!.path)!,
        }
      : {}),
  }));
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
async function derivedId(kind: string, value: string) {
  const h = await sha256(new Blob([kind + ":" + value]));
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
function signature(clip: BackupClip) {
  const ref = (r: MediaRef) => ({
    path: r.path,
    sha256: r.sha256,
    bytes: r.bytes,
  });
  return JSON.stringify({
    ...cleanClip(clip),
    id: undefined,
    files: {
      highlight: ref(clip.files.highlight),
      ...(clip.project ? { base: ref(clip.files.base!) } : {}),
      ...(clip.quiz
        ? { quiz: ref(clip.files.quiz!), reveal: ref(clip.files.reveal!) }
        : {}),
    },
  });
}
export async function planRestore(
  incoming: LoadedBackup,
  existing: LoadedBackup,
  includeHistory: boolean,
) {
  const current = new Map(existing.manifest.clips.map((c) => [c.id, c]));
  const players = new Map(
    existing.manifest.clips.map((c) => [c.player.id, JSON.stringify(c.player)]),
  );
  const playerIds = new Map<string, string>(),
    clipIds = new Map<string, string>();
  for (const item of incoming.manifest.clips) {
    const prior = current.get(item.id);
    if (UUID.test(item.id) && prior && signature(prior) === signature(item))
      playerIds.set(item.player.id, item.player.id);
  }
  for (const item of incoming.manifest.clips) {
    if (playerIds.has(item.player.id)) continue;
    let id = item.player.id,
      salt = 0;
    while (
      !UUID.test(id) ||
      (players.has(id) &&
        players.get(id) !== JSON.stringify({ ...item.player, id }))
    )
      id = await derivedId(
        "player",
        JSON.stringify(item.player) + ":" + salt++,
      );
    playerIds.set(item.player.id, id);
    players.set(id, JSON.stringify({ ...item.player, id }));
  }
  const added: BackupClip[] = [];
  let skipped = 0,
    conflicts = 0;
  for (const item of incoming.manifest.clips) {
    const mapped = {
      ...item,
      player: { ...item.player, id: playerIds.get(item.player.id)! },
    };
    let id = item.id,
      salt = 0;
    while (
      !UUID.test(id) ||
      (current.has(id) && signature(current.get(id)!) !== signature(mapped))
    )
      id = await derivedId(
        "clip",
        item.id + ":" + signature(mapped) + ":" + salt++,
      );
    clipIds.set(item.id, id);
    if (current.has(id)) skipped++;
    else {
      const copy = { ...mapped, id };
      added.push(copy);
      current.set(id, copy);
      if (id !== item.id) conflicts++;
    }
  }
  const history = includeHistory
    ? (incoming.manifest.history ?? []).map((value) => {
        const mapPlayer = (p: Player) => ({
          ...p,
          id: playerIds.get(p.id) ?? p.id,
        });
        return {
          ...value,
          clipId: clipIds.get(value.clipId) ?? value.clipId,
          selected: mapPlayer(value.selected),
          correct: mapPlayer(value.correct),
        };
      })
    : [];
  if (!history.every(attempt))
    throw Error("Restored history contains conflicting player identities");
  // Retain only media needed by new records; identical variants remain deduplicated.
  const media = new Map<string, Blob>();
  for (const c of added)
    for (const ref of Object.values(c.files))
      media.set(ref.path, incoming.media.get(ref.path)!);
  return {
    backup: {
      manifest: { ...incoming.manifest, clips: added, history: undefined },
      media,
    } as LoadedBackup,
    history,
    skipped,
    conflicts,
  };
}

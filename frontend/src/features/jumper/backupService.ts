import { IS_GITHUB_PAGES } from "../../runtime";
import {
  browserLibrarySnapshot,
  commitBrowserRestore,
  exportLocalLibrary,
  localLibraryIndex,
  restoreLocalLibrary,
  readAttempts,
  restoreAttemptHistory,
} from "./storage";
import {
  collectBackup,
  validateManifest,
  encodeBackup,
  loadBackup,
  personalClips,
  planRestore,
  type LoadedBackup,
  type Progress,
} from "./backupArchive";
import { openVideo, validateFinishedVideo } from "./media";
import { BLOCK, validateGeometry } from "./videoValidation";
export async function exportLibrary(
  includeHistory: boolean,
  progress: Progress,
) {
  if (IS_GITHUB_PAGES) {
    const snapshot = await browserLibrarySnapshot(includeHistory);
    return encodeBackup(
      await collectBackup(
        snapshot.clips,
        includeHistory ? snapshot.attempts : undefined,
        progress,
      ),
      progress,
    );
  }
  const backup = await loadBackup(await exportLocalLibrary(), progress);
  if (includeHistory) backup.manifest.history = await readAttempts();
  return encodeBackup(backup, progress);
}
export async function inspectLibraryBackup(file: Blob, progress: Progress) {
  const backup = await loadBackup(file, progress);
  const checked = new Set<string>();
  for (const [index, value] of backup.manifest.clips.entries()) {
    progress(
      `Checking video playback · clip ${index + 1} of ${backup.manifest.clips.length}`,
    );
    for (const [kind, ref] of Object.entries(value.files)) {
      // If a file is both a legacy colored variant and a quiz, use the stricter check.
      const neutral = value.presentation === "silhouette" || kind === "quiz";
      const key = ref.path + ":" + neutral + ":" + value.duration;
      if (checked.has(key)) continue;
      const blob = backup.media.get(ref.path)!;
      const header = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
      if (
        value.mime === "video/mp4"
          ? String.fromCharCode(...header.slice(4, 8)) !== "ftyp"
          : header[0] !== 0x1a ||
            header[1] !== 0x45 ||
            header[2] !== 0xdf ||
            header[3] !== 0xa3
      )
        throw Error("Backup video format does not match its filename");
      const { input, track } = await openVideo(blob);
      let width: number, height: number;
      try {
        width = await track.getDisplayWidth();
        height = await track.getDisplayHeight();
      } finally {
        input.dispose();
      }
      const count = Math.round(value.duration * 30);
      if (Math.abs(count / 30 - value.duration) > 0.002)
        throw Error("A backup clip has an invalid timeline");
      validateGeometry({ width, height, count });
      const proof = neutral
        ? new Uint8Array(
            Math.ceil(width / BLOCK) * Math.ceil(height / BLOCK),
          ).fill(255)
        : undefined;
      await validateFinishedVideo(
        blob,
        { width, height, count },
        proof ? Array.from({ length: count }, () => proof) : undefined,
      );
      checked.add(key);
    }
  }
  return backup;
}
export async function restoreLibrary(
  incoming: LoadedBackup,
  includeHistory: boolean,
  progress: Progress,
) {
  progress("Checking existing library and duplicate identities");
  const snapshot = IS_GITHUB_PAGES ? await browserLibrarySnapshot(false) : null;
  const current = snapshot
    ? await collectBackup(snapshot.clips, undefined, progress)
    : await (async () => {
        const manifest = await localLibraryIndex();
        validateManifest(manifest);
        return { manifest, media: new Map<string, Blob>() };
      })();
  const plan = await planRestore(incoming, current, includeHistory);
  progress("Saving verified library");
  if (snapshot) {
    const result = await commitBrowserRestore(
      personalClips(plan.backup),
      plan.history,
      snapshot.revision,
    );
    return { ...result, skipped: plan.skipped, conflicts: plan.conflicts };
  }
  const result = await restoreLocalLibrary(
    await encodeBackup(plan.backup, progress),
  );
  let historyAdded = 0,
    historySkipped = 0;
  try {
    ({ historyAdded, historySkipped } = await restoreAttemptHistory(
      plan.history,
    ));
  } catch (error) {
    throw Error(
      `Clips were restored, but guessing history could not be restored. Retry this backup; existing clips and answers will be skipped. ${error instanceof Error ? error.message : error}`,
    );
  }
  return {
    added: result.added,
    skipped: plan.skipped + result.skipped,
    conflicts: plan.conflicts,
    historyAdded,
    historySkipped,
  };
}

import { loadEditFont } from "./editFont";
import { CanvasSink } from "mediabunny";
import { openVideo, writers, validateFinishedVideo } from "./media";
import {
  isProject,
  editFrame,
  projectFrames,
  type EditProject,
} from "./editProject";
import { drawEdit } from "./editDrawing";
import { silhouetteProof } from "./videoValidation";
import { MAX_BYTES } from "./domain";
export type EditedVideos = { highlight: Blob; clean: Blob; duration: number };
export async function renderEdits(
  base: Blob,
  project: EditProject,
  progress: (value: number) => void,
  signal?: AbortSignal,
): Promise<EditedVideos> {
  if (
    !isProject(project) ||
    !(base instanceof Blob) ||
    !base.size ||
    base.size > MAX_BYTES
  )
    throw Error("Invalid edit project or masked base");
  await loadEditFont();
  signal?.throwIfAborted();
  const { input, track, duration } = await openVideo(base);
  const abort = () => input.dispose();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (
      Math.abs(duration - project.baseFrames / 30) > 0.002 ||
      (await input.getAudioTracks()).length
    )
      throw Error("The masked base does not match this edit project");
    const width = await track.getDisplayWidth(),
      height = await track.getDisplayHeight(),
      count = projectFrames(project);
    if (width > 1280 || height > 720 || width % 2 || height % 2)
      throw Error("Invalid masked-base dimensions");
    const sink = new CanvasSink(track, { poolSize: 2 }),
      writer = await writers(width, height);
    const variants: Blob[] = [];
    for (const clean of [false, true]) {
      const output = await writer.create(),
        proofs: Uint8Array[] = [];
      let last = -1,
        sample: Awaited<ReturnType<typeof sink.getCanvas>> = null;
      try {
        for (let i = 0; i < count; i++) {
          signal?.throwIfAborted();
          const source = editFrame(project, i, clean).source;
          if (source !== last) {
            sample = await sink.getCanvas(source / 30 + 0.00001);
            last = source;
          }
          if (!sample) throw Error("The masked base has a missing frame");
          drawEdit(
            output.context,
            sample.canvas,
            width,
            height,
            project,
            i,
            clean,
          );
          const pixels = output.context.getImageData(0, 0, width, height).data;
          for (let n = 0; n < pixels.length; n += 4) {
            const gray = Math.round(
              (pixels[n] + pixels[n + 1] + pixels[n + 2]) / 3,
            );
            pixels[n] = pixels[n + 1] = pixels[n + 2] = gray;
          }
          output.context.putImageData(
            new ImageData(pixels, width, height),
            0,
            0,
          );
          for (let n = 0; n < pixels.length; n += 4)
            if (
              pixels[n] !== pixels[n + 1] ||
              pixels[n] !== pixels[n + 2] ||
              pixels[n + 3] !== 255
            )
              throw Error("Editor produced non-neutral pixels");
          proofs.push(silhouetteProof(pixels, width, height));
          await output.source.add(i / 30, 1 / 30);
          progress((Number(clean) * count + i + 1) / (count * 2 + 2));
        }
        const blob = await output.finish();
        if (blob.size > MAX_BYTES)
          throw Error("Finished video exceeds the 100 MB limit");
        await validateFinishedVideo(
          blob,
          { width, height, count },
          proofs,
          true,
          "edited",
        );
        variants.push(blob);
      } catch (error) {
        await output.output.cancel().catch(() => {});
        throw error;
      }
    }
    signal?.throwIfAborted();
    progress(1);
    return { highlight: variants[0], clean: variants[1], duration: count / 30 };
  } finally {
    signal?.removeEventListener("abort", abort);
    input.dispose();
  }
}

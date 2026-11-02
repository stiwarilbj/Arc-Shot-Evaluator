import type { Attribution } from "./types.ts";
export type VideoSample = {
  id: string;
  name: string;
  summary: string;
  note: string;
  file: string;
  poster: string;
  bytes: number;
  sha256: string;
  attribution: Attribution;
  licenseUrl: string;
};
export const VIDEO_SAMPLES: VideoSample[] = [
  {
    id: "kobe-warmup",
    name: "Kobe Bryant · Warmup",
    summary: "Free-throw-line view · 3.8 seconds",
    note: "NBA warmup · Review visible lane markings and grounded feet",
    file: "kobe-warmup.mp4",
    poster: "kobe-warmup.jpg",
    bytes: 1265782,
    sha256: "81cfaf5b4975bc61deca072a9d4032a389160e6543b96cac65889596e9e0b159",
    attribution: {
      title: "Kobe Bryant warmup · 0–3.8s excerpt, muted and re-encoded",
      creator: "randychiu",
      license: "CC BY 2.0",
      url: "https://commons.wikimedia.org/wiki/File:Kobe_Bryant.ogv",
    },
    licenseUrl: "https://creativecommons.org/licenses/by/2.0/",
  },
  {
    id: "mad-ants-possession",
    name: "Mad Ants vs Drive · Possession",
    summary: "Courtside action · 4.5 seconds",
    note: "G League game · Camera movement requires fresh alignment for each still",
    file: "mad-ants-possession.mp4",
    poster: "mad-ants-possession.jpg",
    bytes: 984220,
    sha256: "7dc70e53a40d9eebdabe28ddc654b1a74b419f437652d7882f120bdbea558f29",
    attribution: {
      title: "Mad Ants VS Drive · 16.5–21s excerpt, muted and re-encoded",
      creator: "Tamara Chaos-Events",
      license: "CC BY 3.0",
      url: "https://commons.wikimedia.org/wiki/File:Mad_Ants_VS_Drive.webm",
    },
    licenseUrl: "https://creativecommons.org/licenses/by/3.0/",
  },
  {
    id: "mad-ants-free-throw",
    name: "Mad Ants vs Drive · Free throw",
    summary: "Set positions · 3.5 seconds",
    note: "G League game · Confirm the lane corners and visible foot contacts",
    file: "mad-ants-free-throw.mp4",
    poster: "mad-ants-free-throw.jpg",
    bytes: 1125956,
    sha256: "7346d8b1ff249119a8df144e8ddc4e3a07be3203e0fff0783346f110e5c53d82",
    attribution: {
      title: "Mad Ants VS Drive · 30.5–34s excerpt, muted and re-encoded",
      creator: "Tamara Chaos-Events",
      license: "CC BY 3.0",
      url: "https://commons.wikimedia.org/wiki/File:Mad_Ants_VS_Drive.webm",
    },
    licenseUrl: "https://creativecommons.org/licenses/by/3.0/",
  },
  {
    id: "mad-ants-wide",
    name: "Mad Ants vs Drive · Wide view",
    summary: "Elevated court view · 5 seconds",
    note: "G League game · Distant feet can remain uncertain",
    file: "mad-ants-wide.mp4",
    poster: "mad-ants-wide.jpg",
    bytes: 1695075,
    sha256: "d56654f875e1e5a9137afdbbae61c1c361b568008436380a1526d6e83f2b4a55",
    attribution: {
      title: "Mad Ants VS Drive · 105–110s excerpt, muted and re-encoded",
      creator: "Tamara Chaos-Events",
      license: "CC BY 3.0",
      url: "https://commons.wikimedia.org/wiki/File:Mad_Ants_VS_Drive.webm",
    },
    licenseUrl: "https://creativecommons.org/licenses/by/3.0/",
  },
];

export async function readSampleVideo(
  sample: VideoSample,
  baseUrl: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const response = await fetch(`${baseUrl}freeze-floor/videos/${sample.file}`, {
    signal,
  });
  if (!response.ok)
    throw Error(
      "Example video could not load · Retry or upload your own video",
    );
  const reader = response.body?.getReader();
  if (!reader) throw Error("Example video was empty · Try again");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > sample.bytes)
        throw Error("Example video exceeded its expected size · Try again");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  signal.throwIfAborted();
  if (size !== sample.bytes)
    throw Error("Example video was interrupted · Try again");
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  signal.throwIfAborted();
  if (digest !== sample.sha256)
    throw Error("Example video integrity check failed · Try again");
  return new File([bytes], sample.file, { type: "video/mp4" });
}

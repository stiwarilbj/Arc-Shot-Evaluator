import { MAX_IMAGE_BYTES, MAX_PIXELS } from "./types.ts";
export type ImageHeader = {
  width: number;
  height: number;
  type: "image/jpeg" | "image/png" | "image/webp";
};
export function readImageHeader(bytes: Uint8Array): ImageHeader {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    ascii = (i: number, n: number) =>
      String.fromCharCode(...bytes.subarray(i, i + n));
  let width = 0,
    height = 0,
    type: ImageHeader["type"] = "image/jpeg";
  if (
    bytes.length >= 24 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b) &&
    ascii(12, 4) === "IHDR"
  ) {
    width = v.getUint32(16);
    height = v.getUint32(20);
    type = "image/png";
  } else if (
    bytes.length >= 30 &&
    ascii(0, 4) === "RIFF" &&
    ascii(8, 4) === "WEBP"
  ) {
    type = "image/webp";
    for (let p = 12; p + 8 <= bytes.length; ) {
      const tag = ascii(p, 4),
        length = v.getUint32(p + 4, true),
        s = p + 8;
      if (tag === "VP8X" && s + 10 <= bytes.length) {
        width = 1 + bytes[s + 4] + (bytes[s + 5] << 8) + (bytes[s + 6] << 16);
        height = 1 + bytes[s + 7] + (bytes[s + 8] << 8) + (bytes[s + 9] << 16);
        break;
      }
      if (
        tag === "VP8 " &&
        s + 10 <= bytes.length &&
        bytes[s + 3] === 157 &&
        bytes[s + 4] === 1 &&
        bytes[s + 5] === 42
      ) {
        width = v.getUint16(s + 6, true) & 16383;
        height = v.getUint16(s + 8, true) & 16383;
        break;
      }
      if (tag === "VP8L" && s + 5 <= bytes.length && bytes[s] === 47) {
        const n = v.getUint32(s + 1, true);
        width = 1 + (n & 16383);
        height = 1 + ((n >>> 14) & 16383);
        break;
      }
      if (length > bytes.length - s) break;
      p = s + length + (length % 2);
    }
  } else if (bytes[0] === 255 && bytes[1] === 216) {
    for (let p = 2; p + 4 <= bytes.length; ) {
      if (bytes[p] !== 255) break;
      while (bytes[p] === 255) p++;
      const marker = bytes[p++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (p + 2 > bytes.length) break;
      const length = v.getUint16(p);
      if (length < 2 || p + length > bytes.length) break;
      if (
        [
          192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
        ].includes(marker) &&
        length >= 8
      ) {
        height = v.getUint16(p + 3);
        width = v.getUint16(p + 5);
        break;
      }
      p += length;
    }
  }
  if (!width || !height)
    throw Error(
      "Image header is missing or unsupported · Choose a JPEG, PNG, or WebP",
    );
  if (width * height > MAX_PIXELS || Math.max(width, height) > 32768)
    throw Error("Image exceeds 24 megapixels · Resize it before uploading");
  return { width, height, type };
}
export async function normalizeImage(blob: Blob) {
  if (blob.size > MAX_IMAGE_BYTES)
    throw Error("Choose an image no larger than 20 MiB");
  if (!blob.size) throw Error("The image file is empty");
  const header = readImageHeader(
    new Uint8Array(await blob.slice(0, 512 * 1024).arrayBuffer()),
  );
  const bitmap = await createImageBitmap(
    new Blob([blob], { type: header.type }),
    { imageOrientation: "from-image" },
  );
  try {
    if (bitmap.width * bitmap.height > MAX_PIXELS)
      throw Error("Decoded image exceeds 24 megapixels");
    const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw Error("Image canvas unavailable");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const normalized = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(Error("Image conversion failed"))),
        "image/jpeg",
        0.92,
      ),
    );
    return { blob: normalized, width: canvas.width, height: canvas.height };
  } finally {
    bitmap.close();
  }
}

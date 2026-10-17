/** ARCade Hoops backups use ordinary, uncompressed ZIP entries: videos are already compressed.
 * The deliberately narrow reader accepts our format without inflating untrusted data. */
export const MAX_BACKUP_BYTES = 512 * 1024 * 1024;
export const MAX_METADATA_BYTES = 8 * 1024 * 1024;
const MAX_ENTRY_BYTES = 100 * 1024 * 1024;
const MAX_ENTRIES = 3001;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const table = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++)
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
export function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
export function safeBackupPath(path: string) {
  return (
    path === "manifest.json" || /^media\/[a-f0-9]{64}\.(mp4|webm)$/.test(path)
  );
}
export type ZipEntry = { name: string; blob: Blob; crc: number };
export async function checkedEntry(
  name: string,
  blob: Blob,
): Promise<ZipEntry> {
  if (
    !safeBackupPath(name) ||
    !blob.size ||
    blob.size >
      (name === "manifest.json" ? MAX_METADATA_BYTES : MAX_ENTRY_BYTES)
  )
    throw Error("Invalid or oversized backup file");
  return { name, blob, crc: crc32(new Uint8Array(await blob.arrayBuffer())) };
}
export function writeZip(entries: ZipEntry[]) {
  if (
    !entries.length ||
    entries.length > MAX_ENTRIES ||
    new Set(entries.map((e) => e.name)).size !== entries.length
  )
    throw Error("Invalid backup file list");
  const parts: BlobPart[] = [],
    central: BlobPart[] = [];
  let offset = 0,
    centralSize = 0;
  for (const entry of entries) {
    if (!safeBackupPath(entry.name)) throw Error("Unsafe backup path");
    const name = encoder.encode(entry.name);
    const header = new Uint8Array(30 + name.length),
      local = new DataView(header.buffer);
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x800, true);
    local.setUint16(12, 33, true);
    local.setUint32(14, entry.crc, true);
    local.setUint32(18, entry.blob.size, true);
    local.setUint32(22, entry.blob.size, true);
    local.setUint16(26, name.length, true);
    header.set(name, 30);
    const directory = new Uint8Array(46 + name.length),
      view = new DataView(directory.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(8, 0x800, true);
    view.setUint16(14, 33, true);
    view.setUint32(16, entry.crc, true);
    view.setUint32(20, entry.blob.size, true);
    view.setUint32(24, entry.blob.size, true);
    view.setUint16(28, name.length, true);
    view.setUint32(42, offset, true);
    directory.set(name, 46);
    parts.push(header, entry.blob);
    central.push(directory);
    offset += header.length + entry.blob.size;
    centralSize += directory.length;
    if (offset + centralSize + 22 > MAX_BACKUP_BYTES)
      throw Error("Backups are limited to 512 MiB");
  }
  const end = new Uint8Array(22),
    view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, entries.length, true);
  view.setUint16(10, entries.length, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: "application/zip" });
}
export async function readZip(file: Blob) {
  if (file.size < 22 || file.size > MAX_BACKUP_BYTES)
    throw Error("Choose an ARCade Hoops backup ZIP no larger than 512 MiB");
  const end = new DataView(await file.slice(-22).arrayBuffer());
  const count = end.getUint16(10, true),
    size = end.getUint32(12, true),
    offset = end.getUint32(16, true);
  if (
    end.getUint32(0, true) !== 0x06054b50 ||
    end.getUint16(4, true) ||
    end.getUint16(6, true) ||
    end.getUint16(8, true) !== count ||
    !count ||
    count > MAX_ENTRIES ||
    size > 1024 * 1024 ||
    offset + size + 22 !== file.size ||
    end.getUint16(20, true)
  )
    throw Error("Unsupported or damaged ARCade Hoops backup ZIP");
  const bytes = new Uint8Array(
      await file.slice(offset, offset + size).arrayBuffer(),
    ),
    view = new DataView(bytes.buffer);
  const entries = new Map<string, { blob: Blob; crc: number }>();
  let at = 0,
    nextOffset = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > size || view.getUint32(at, true) !== 0x02014b50)
      throw Error("Damaged ZIP directory");
    const flags = view.getUint16(at + 8, true),
      length = view.getUint32(at + 24, true),
      nameLength = view.getUint16(at + 28, true),
      localOffset = view.getUint32(at + 42, true),
      crc = view.getUint32(at + 16, true);
    if (
      flags & ~0x800 ||
      view.getUint16(at + 10, true) ||
      view.getUint32(at + 20, true) !== length ||
      view.getUint16(at + 30, true) ||
      view.getUint16(at + 32, true) ||
      view.getUint16(at + 34, true) ||
      at + 46 + nameLength > size ||
      localOffset !== nextOffset
    )
      throw Error("Unsupported ZIP entry");
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    if (
      !safeBackupPath(name) ||
      entries.has(name) ||
      !length ||
      length >
        (name === "manifest.json" ? MAX_METADATA_BYTES : MAX_ENTRY_BYTES) ||
      localOffset + 30 + nameLength + length > offset
    )
      throw Error("Unsafe, duplicate or oversized backup file");
    const header = new DataView(
      await file
        .slice(localOffset, localOffset + 30 + nameLength)
        .arrayBuffer(),
    );
    if (
      header.getUint32(0, true) !== 0x04034b50 ||
      header.getUint16(6, true) !== flags ||
      header.getUint16(8, true) ||
      header.getUint32(14, true) !== crc ||
      header.getUint32(18, true) !== length ||
      header.getUint32(22, true) !== length ||
      header.getUint16(26, true) !== nameLength ||
      header.getUint16(28, true) ||
      decoder.decode(new Uint8Array(header.buffer, 30)) !== name
    )
      throw Error("ZIP file header does not match its directory");
    nextOffset = localOffset + 30 + nameLength + length;
    entries.set(name, {
      blob: file.slice(localOffset + 30 + nameLength, nextOffset),
      crc,
    });
    at += 46 + nameLength;
  }
  if (at !== size || nextOffset !== offset || !entries.has("manifest.json"))
    throw Error("Incomplete ARCade Hoops backup");
  return entries;
}

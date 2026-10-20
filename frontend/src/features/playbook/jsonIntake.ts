// A fully populated v1 court is tens of KiB, even with pretty printing. Keep
// document and aggregate-library budgets distinct so normal libraries can grow.
export const MAX_PLAYBOOK_JSON_BYTES = 256 * 1024;
export const MAX_PLAYBOOK_LIBRARY_BYTES = 16 * 1024 * 1024;
export const MAX_PLAYBOOK_JSON_DEPTH = 32;
const preserved = " Your current draft and stored data have been preserved.";

export function checkPlaybookJsonText(text: string, maxBytes = MAX_PLAYBOOK_JSON_BYTES): void {
  // UTF-8 has at least as many bytes as UTF-16 code units. Reject huge strings
  // before allocating an encoded copy (localStorage already returns a string).
  if (text.length > maxBytes || new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new Error(`Playbook JSON exceeds the ${maxBytes / 1024} KiB byte limit.${preserved}`);
  }
  let depth = 0, quoted = false, escaped = false;
  for (const character of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "[" || character === "{") {
      if (++depth > MAX_PLAYBOOK_JSON_DEPTH) throw new Error(`Playbook JSON exceeds the nesting limit of 32.${preserved}`);
    } else if (character === "]" || character === "}") depth--;
  }
}

export function parsePlaybookJson(text: string, maxBytes = MAX_PLAYBOOK_JSON_BYTES): unknown {
  checkPlaybookJsonText(text, maxBytes);
  return JSON.parse(text);
}

/** Read actual bytes, without trusting Content-Length or allocating an entire
 * response/file first. Cancelling the reader stops supersized streams early. */
export async function readPlaybookJsonText(source: Response | Blob, maxBytes = MAX_PLAYBOOK_JSON_BYTES): Promise<string> {
  if (source instanceof Blob && source.size > maxBytes) throw new Error(`Playbook JSON exceeds the byte limit.${preserved}`);
  const stream = source instanceof Blob ? source.stream() : source.body;
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const parts: string[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) throw new Error(`Playbook JSON exceeds the ${maxBytes / 1024} KiB byte limit.${preserved}`);
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } catch (error) {
    // Do not let a broken source's cancellation promise hide the intake error.
    void reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

export async function readPlaybookJson(source: Response | Blob): Promise<unknown> {
  return parsePlaybookJson(await readPlaybookJsonText(source));
}

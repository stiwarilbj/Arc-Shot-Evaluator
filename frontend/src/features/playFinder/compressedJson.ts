// Some static servers decode Content-Encoding:gzip; Pages may serve the file bytes.
// Accept both responses without trying to decompress an already-decoded body.
export async function readCompressedJson(response: Response): Promise<unknown> {
 const bytes=new Uint8Array(await response.arrayBuffer());
 if(bytes[0]===0x1f&&bytes[1]===0x8b){
  const stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
 }
 return JSON.parse(new TextDecoder().decode(bytes));
}

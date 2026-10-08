import { pipeline } from '../../frontend/node_modules/@huggingface/transformers/dist/transformers.node.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { gunzipSync, gzipSync } from 'node:zlib';
import { resolve } from 'node:path';
const root=resolve(process.argv[2]??'nba-staging');
const manifest=JSON.parse(await readFile(resolve(root,'manifest.json'),'utf8'));
const texts=new Set();
for(const shard of manifest.shards){for(const clip of JSON.parse(gunzipSync(await readFile(resolve(root,shard.path)))))texts.add(clip.semanticText);}
// Pin the same model revision for ingestion and browser queries.
const revision='751bff37182d3f1213fa05d7196b954e230abad9';
const extractor=await pipeline('feature-extraction','Xenova/all-MiniLM-L6-v2',{revision,dtype:'q8',device:'cpu'});
const dictionary={};
try{for(const text of texts){const tensor=await extractor(text,{pooling:'mean',normalize:true});dictionary[text]=Array.from(tensor.data);}}
finally{await extractor.dispose();}
await writeFile(resolve(root,'embeddings.json.gz'),gzipSync(JSON.stringify(dictionary)));
manifest.model={...manifest.model,revision,embeddings:'embeddings.json.gz'};
await writeFile(resolve(root,'manifest.json'),JSON.stringify(manifest));
console.log(`${texts.size} deduplicated play descriptions embedded`);

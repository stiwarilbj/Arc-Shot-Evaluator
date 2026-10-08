import {readdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
const [target,root]=process.argv.slice(2);
async function files(path){return (await Promise.all((await readdir(path,{withFileTypes:true})).map(e=>e.isDirectory()?files(join(path,e.name)):[join(path,e.name)]))).flat();}
const paths=await files(root);
const scripts=await Promise.all(paths.filter(p=>/\.(?:js|css)$/.test(p)).map(p=>readFile(p,'utf8')));
const hasFinder=paths.some(p=>/PlayFinder|search\.worker|ort-wasm/.test(p))||scripts.some(s=>s.includes('NBA Stats event')||s.includes('all-MiniLM-L6-v2'));
if(target==='local'&&(hasFinder||paths.some(p=>/nba-index|\.onnx|\.wasm/.test(p))))throw new Error('Local build contains Play Finder/model/index assets');
if(target==='hosted'&&!hasFinder)throw new Error('Hosted build is missing Play Finder');
console.log(`${target} build target verified`);

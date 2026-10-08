"""Free-tier guards and structural verification before promotion or Pages upload."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import urllib.parse

SITE_LIMIT = 900 * 1024 * 1024  # Below Pages' 1GB maximum; leave headroom.
DATA_LIMIT = 350 * 1024 * 1024  # Leave artifact-storage headroom as well.

def validate(root):
    manifest=json.loads((root/'manifest.json').read_text())
    if manifest.get('version') != 2 or not manifest.get('clips'):raise ValueError('Empty or unsupported index')
    if not manifest['model'].get('revision') or not manifest['model'].get('embeddings'):raise ValueError('Semantic model metadata missing')
    embeddings=json.loads(gzip.decompress((root/manifest['model']['embeddings']).read_bytes()))
    ids=set()
    detail_cache={}
    for shard in manifest['shards']:
        path=root/shard['path']
        if not path.resolve().is_relative_to(root.resolve()):raise ValueError('Unsafe shard path')
        payload=path.read_bytes()
        if hashlib.sha256(payload).hexdigest()!=shard['sha256']:raise ValueError('Shard checksum mismatch')
        clips=json.loads(gzip.decompress(payload))
        if len(clips)!=shard['count']:raise ValueError('Shard count mismatch')
        for clip in clips:
            identity=f"{clip['gameId']}:{clip['eventId']}"
            if clip['id']!=identity or identity in ids:raise ValueError('Duplicate or wrong event ID')
            ids.add(identity)
            if clip['gameId'] not in detail_cache:
                detail_cache[clip['gameId']]=json.loads(gzip.decompress((root/clip['detailPath']).read_bytes()))
                if len(detail_cache)>128:detail_cache.pop(next(iter(detail_cache)))
            detail=detail_cache[clip['gameId']][identity]
            url=urllib.parse.urlparse(detail['mp4'])
            if url.scheme!='https' or url.hostname!='videos.nba.com' or f"/{clip['gameId']}/{clip['eventId']}/" not in url.path:raise ValueError('Unverified NBA individual asset')
            vector=embeddings.get(clip['semanticText'])
            if not vector or len(vector)!=384:raise ValueError('Missing description embedding')
    if len(ids)!=manifest['clips']:raise ValueError('Manifest clip count mismatch')
    size=sum(p.stat().st_size for p in root.rglob('*') if p.is_file())
    if size>DATA_LIMIT:raise ValueError('Index exceeds free-storage budget; publication stopped')
    print(len(ids),'individual clips verified;',size,'bytes')

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('path',type=Path);parser.add_argument('--site',action='store_true');args=parser.parse_args()
    if args.site:
        size=sum(p.stat().st_size for p in args.path.rglob('*') if p.is_file())
        if size>SITE_LIMIT:raise SystemExit('Pages size budget exceeded; publication stopped')
        print('Pages size:',size,'bytes')
    else:validate(args.path)

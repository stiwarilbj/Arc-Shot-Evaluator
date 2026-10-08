import json
import os
from pathlib import Path
import sys
import urllib.request
request=urllib.request.Request(f"https://api.github.com/repos/{os.environ['GITHUB_REPOSITORY']}/actions/artifacts?per_page=100",headers={'Authorization':'Bearer '+os.environ['GH_TOKEN'],'Accept':'application/vnd.github+json'})
data=json.load(urllib.request.urlopen(request))
if data['total_count']>100:raise SystemExit('Cannot verify artifact storage; publication stopped')
existing=sum(a['size_in_bytes'] for a in data['artifacts'] if not a['expired'])
incoming=sum(p.stat().st_size for p in Path(sys.argv[1]).rglob('*') if p.is_file())
if existing+incoming>450*1024*1024:raise SystemExit('Artifact storage budget exceeded; publication stopped')
print('Artifact storage check passed')

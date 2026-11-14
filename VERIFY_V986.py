#!/usr/bin/env python3
from pathlib import Path
import hashlib,json,sys
r=Path(__file__).resolve().parent
m=json.loads((r/'INTEGRATION_RELEASE_SHA256_V986.json').read_text('utf-8'))
bad=[]
for name,expected in m['files'].items():
    f=r/name
    if not f.is_file() or hashlib.sha256(f.read_bytes()).hexdigest()!=expected:bad.append(name)
for i in range(1,1001):
    for category in ('concept-art','concept-thumb'):
        f=r/'public'/category/f'book-{i:03d}.webp'
        if not f.is_file():bad.append(str(f));continue
        dat=f.read_bytes()
        if not (len(dat)>100 and dat[:4]==b'RIFF' and dat[8:12]==b'WEBP'):bad.append(str(f))
for name,size in [('public/concept-art/book-023.webp',(1000,1400)),('public/concept-thumb/book-023.webp',(240,336))]:
    f=r/name
    if not f.exists():bad.append(name)
print(f'VARAQ v9.8.6 | tracked: {len(m["files"])} | art+thumb: 2000 | failures: {len(bad)}')
if bad:print('\n'.join(bad[:40]));sys.exit(1)

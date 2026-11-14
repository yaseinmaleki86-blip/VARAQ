#!/usr/bin/env python3
from pathlib import Path
import hashlib,json,sys
r=Path(__file__).resolve().parent
m=json.loads((r/'INTEGRATION_RELEASE_SHA256_V987.json').read_text('utf-8'))
errors=[]
for name,expected in m['files'].items():
    p=r/name
    if not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest()!=expected:errors.append(name)
for i in range(1,1001):
    for folder in ('concept-art','concept-thumb'):
        p=r/'public'/folder/f'book-{i:03d}.webp'
        if not p.is_file():errors.append(str(p));continue
        data=p.read_bytes()
        if len(data)<100 or data[:4]!=b'RIFF' or data[8:12]!=b'WEBP':errors.append(str(p))
print('VARAQ v9.8.7',len(m['files']),'hashed files','2000 cover/thumb checks','errors:',len(errors))
if errors:
    print('\n'.join(errors[:25]));sys.exit(1)

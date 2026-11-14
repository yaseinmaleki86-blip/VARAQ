#!/usr/bin/env python3
"""Verify the full v9.8.5 release using only the Python standard library."""
import sys,hashlib,json
from pathlib import Path
r=Path(__file__).resolve().parent
m=json.loads((r/'INTEGRATION_RELEASE_SHA256_V985.json').read_text('utf-8'))
bad=[]
for p,h in m['files'].items():
 f=r/p
 if not f.is_file() or hashlib.sha256(f.read_bytes()).hexdigest()!=h:bad.append(p)
for i in range(1,1001):
 for cat in ('concept-art','concept-thumb'):
  f=r/'public'/cat/f'book-{i:03d}.webp'
  if not f.is_file():bad.append(str(f));continue
  data=f.read_bytes()
  if not (data[:4]==b'RIFF' and data[8:12]==b'WEBP' and len(data)>100):bad.append(str(f))
print('Tracked files:',len(m['files']),'Images:',2000,'Errors:',len(bad))
if bad:print('\n'.join(bad[:50]));sys.exit(1)

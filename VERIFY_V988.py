#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""VARAQ v9.8.8 immutable source + images self-check. Python stdlib only."""
from pathlib import Path
import hashlib,json,sys,struct
root=Path(__file__).resolve().parent
manifest=json.loads((root/'INTEGRATION_RELEASE_SHA256_V988.json').read_text('utf-8'))
errors=[]
for relative,digest in manifest['files'].items():
    p=root/relative
    if not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest()!=digest:
        errors.append('mismatched '+relative)
for i in range(1,1001):
    for sub in ('concept-art','concept-thumb'):
        p=root/'public'/sub/f'book-{i:03d}.webp'
        if not p.is_file(): errors.append('missing '+str(p));continue
        data=p.read_bytes()
        if len(data)<100 or data[:4]!=b'RIFF' or data[8:12]!=b'WEBP':errors.append('bad WebP '+str(p))
check=json.loads((root/'data/COVER_ART_HUMAN_REVIEW_V988.json').read_text('utf-8'))
assert len(check['records'])==1000
assert [r['id'] for r in check['records']]==list(range(1,1001))
assert check['newly_replaced_book_ids']==[25]
assert check['all_new_illustrated_cover_ids_since_984']==[21,22,23,24,25]
print('Files checked:',len(manifest['files']))
print('Expected art assets: 2000')
print('New story-specific art awaiting human QA: 5')
print('Errors:',len(errors))
if errors:print('\n'.join(errors[:30]));sys.exit(1)

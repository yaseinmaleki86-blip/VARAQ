#!/usr/bin/env python3
from pathlib import Path
from PIL import Image
import hashlib,json,sys
ROOT=Path(__file__).resolve().parents[1]
data=json.loads((ROOT/'data'/'COVER_UPGRADE_V982.json').read_text(encoding='utf-8'))
assert data['new_visual_replacements_this_release']==10
assert len(data['replaced'])==10
assert len(list((ROOT/'public'/'concept-art').glob('book-*.webp')))==1000
assert len(list((ROOT/'public'/'concept-thumb').glob('book-*.webp')))==1000
for b in data['replaced']:
 for folder,size in [('concept-art',(480,672)),('concept-thumb',(240,336))]:
  p=ROOT/'public'/folder/f"book-{b['id']:03d}.webp"
  with Image.open(p) as img:assert img.size==size
 p=ROOT/'public'/'concept-art'/f"book-{b['id']:03d}.webp"
 assert hashlib.sha256(p.read_bytes()).hexdigest()==b['sha256']
print('PASS: 1000 book cover pairs present; 10 newly redesigned artwork pairs verified; 980 await redesign.')

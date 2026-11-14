#!/usr/bin/env python3
"""Verify all current 1000 covers/thumbs, then check tracked changes and preserved files."""
import os,sys,hashlib,json
from pathlib import Path
try:
 from PIL import Image
except ImportError:
 print('Pillow is required: pip install Pillow');sys.exit(2)
root=Path(__file__).resolve().parent
m=json.loads((root/'INTEGRATION_RELEASE_SHA256_V984.json').read_text(encoding='utf8'))
bad=[]
for rel,expected in m['file_hashes'].items():
 p=root/rel
 if not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest()!=expected:bad.append(rel)
for id in range(1,1001):
 for sub in ('concept-art','concept-thumb'):
  p=root/'public'/sub/f'book-{id:03d}.webp'
  try:
   with Image.open(p) as im: im.verify()
  except Exception:bad.append(str(p.relative_to(root)))
print(f"checked {len(m['file_hashes'])} tracked files, 2000 images, errors: {len(bad)}")
if bad: print('\n'.join(bad[:60]));sys.exit(1)

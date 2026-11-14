#!/usr/bin/env python3
import json,hashlib,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parent
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
def main():
  files=json.loads((ROOT/'INTEGRATION_RELEASE_SHA256_V983.json').read_text(encoding='utf8'))['sha256']
  bad=[name for name,expect in files.items() if not (ROOT/name).is_file() or sha(ROOT/name)!=expect]
  covers=json.loads((ROOT/'data/COVER_ART_MANIFEST_1000_V983.json').read_text(encoding='utf8'))
  books=json.loads((ROOT/'data/books.json').read_text(encoding='utf8'))
  art=covers['books_meta']
  if len(books)!=1000 or len(art)!=1000:bad.append('catalogue/cardinality')
  if any(book['id']!=i for i,book in enumerate(books,1)):bad.append('book_ids')
  for i,e in enumerate(art,1):
    if e['id']!=i or e['title']!=books[i-1]['title']:bad.append('cover_map_'+str(i));continue
    if not (ROOT/e['cover']).is_file() or sha(ROOT/e['cover'])!=e['cover_sha256']:bad.append('cover_'+str(i))
    if not (ROOT/e['thumbnail']).is_file() or sha(ROOT/e['thumbnail'])!=e['thumbnail_sha256']:bad.append('thumb_'+str(i))
  for f in ['START_WITH_TAILSCALE_WINDOWS.bat','TAILSCALE_CONNECT_WINDOWS.bat','TAILSCALE_DISCONNECT_WINDOWS.bat','START_UNIFIED_WINDOWS.bat']:
    if not (ROOT/f).is_file():bad.append('missing_'+f)
  print('VARAQ 9.8.3 | books:',len(books),'| concepts:',len(art),'| checked_files:',len(files),'| errors:',len(bad))
  if bad:print('First errors:',bad[:30]);return 1
  print('PASS: 1000 distinct local cover+thumbnail mappings and complete release hashes.')
  return 0
if __name__=='__main__':sys.exit(main())

#!/usr/bin/env python3
"""Verify immutable source files and original concept-art included with v9.8.
Run on an extracted, unmodified release before starting the services.
"""
import hashlib,json,sqlite3,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parent

def main():
    manifest=ROOT/'INTEGRATION_RELEASE_SHA256_V98.json'
    info=json.loads(manifest.read_text(encoding='utf-8'))
    bad=[]
    for name,expect in info['sha256'].items():
        path=ROOT/name
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest()!=expect:
            bad.append(name)
    art=len(list((ROOT/'public'/'concept-art').glob('book-*.webp')))
    thumbs=len(list((ROOT/'public'/'concept-thumb').glob('book-*.webp')))
    books=json.loads((ROOT/'data'/'books.json').read_text(encoding='utf-8'))
    print('immutable_checked:',len(info['sha256']))
    print('art:',art,'thumbs:',thumbs,'catalogue_books:',len(books),'mismatched:',len(bad))
    if bad:
        print('First mismatches:',bad[:15]);return 1
    if (art,thumbs,len(books))!=(1000,1000,1000):return 2
    print('PASS - release source is complete. Market DB may be intentionally absent on upgrades.')
    return 0
if __name__=='__main__':sys.exit(main())

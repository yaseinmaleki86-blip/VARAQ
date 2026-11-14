#!/usr/bin/env python3
"""Read-only integrity checks of the full 8.6 source + imported 9.5 catalog."""
from pathlib import Path
import json,sqlite3,hashlib,sys
root=Path(__file__).resolve().parent.parent
old=json.loads((root/'data'/'books.json').read_text(encoding='utf8'))
art=json.loads((root/'data'/'generated_catalog_v86.json').read_text(encoding='utf8'))
conn=sqlite3.connect('file:'+str(root/'market'/'data'/'varaq.sqlite3')+'?mode=ro',uri=True)
conn.row_factory=sqlite3.Row
rows=conn.execute('SELECT id,title,author,description,cover,price,stock FROM books ORDER BY id').fetchall()
assert len(old)==1000 and len(art)==1000 and len(rows)==1000
assert all(r['price']==0 and r['stock']==0 for r in rows)
assert all((root/'public'/'concept-art'/f"book-{i:03d}.webp").exists() for i in range(1,1001))
assert all((root/'public'/'concept-thumb'/f"book-{i:03d}.webp").exists() for i in range(1,1001))
assert all(r['cover']==f"v86_book-{i:03d}.webp" for i,r in enumerate(rows,1))
assert all(len(r['description'].strip())>15 for r in rows)
assert len(set(r['description'] for r in rows))==1000
assert conn.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
print('SUCCESS: 1000 books, 1000 full-size art covers, 1000 thumbnails, 1000 descriptions, SQLite OK')

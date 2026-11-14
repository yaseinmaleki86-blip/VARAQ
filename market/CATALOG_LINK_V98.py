#!/usr/bin/env python3
"""Safe book identity links between legacy editorial and retail catalogues.

No financial data, customer records, order state, stock or price is copied.
The two SQLite databases remain physically separate.

CLI default: read-only preview. --apply: insert only unambiguous links into
retail database, with a verified SQLite backup beforehand.
"""
import argparse
import collections
from contextlib import closing
import datetime as dt
import hashlib
import json
import os
import re
import sqlite3
import sys
from pathlib import Path

ROOT=Path(__file__).resolve().parent.parent
SCHEMA='''CREATE TABLE IF NOT EXISTS catalog_identity_links (
 node_book_id INTEGER NOT NULL PRIMARY KEY,
 retail_book_id INTEGER NOT NULL UNIQUE REFERENCES books(id) ON DELETE RESTRICT,
 node_title_at_link TEXT NOT NULL,
 retail_title_at_link TEXT NOT NULL,
 node_author_at_link TEXT NOT NULL DEFAULT '',
 retail_author_at_link TEXT NOT NULL DEFAULT '',
 linked_at TEXT NOT NULL,
 link_method TEXT NOT NULL DEFAULT 'unique_title_author_v98'
);
CREATE INDEX IF NOT EXISTS idx_catalog_identity_retail ON catalog_identity_links(retail_book_id);'''

def norm(x):
    s=str(x or '').translate(str.maketrans({'ي':'ی','ك':'ک','ى':'ی','ة':'ه','أ':'ا','إ':'ا'}))
    s=re.sub(r'[\u200c\u200d\u200e\u200f\ufeff]', ' ',s)
    return ' '.join(s.casefold().split())

def isbn(x): return re.sub(r'[^0-9Xx]','',str(x or '')).upper()

def iso(): return dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')

def connect_ro(path):
    p=Path(path).resolve(strict=True)
    c=sqlite3.connect(p.as_uri()+'?mode=ro',uri=True,timeout=10)
    c.row_factory=sqlite3.Row
    c.execute('PRAGMA query_only=ON')
    return c

def validate_schema(c,table):
    cols={x['name'] for x in c.execute(f'PRAGMA table_info({table})')}
    if not {'id','title','author','isbn'}.issubset(cols):
        raise ValueError(f'Table {table} is missing required bibliographic columns')

def snapshot(c):
    validate_schema(c,'books')
    return {int(x['id']):dict(x) for x in c.execute('SELECT id,title,author,isbn FROM books ORDER BY id')}

def read_links(c):
    t=c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='catalog_identity_links'").fetchone()
    if not t:return {}
    return {int(x['node_book_id']):dict(x) for x in c.execute('SELECT * FROM catalog_identity_links ORDER BY node_book_id')}

def plan(node,retail):
    nbooks=snapshot(node);rbooks=snapshot(retail);previous=read_links(retail)
    used_retail={int(x['retail_book_id']) for x in previous.values()}
    node_keys=collections.defaultdict(list)
    retail_keys=collections.defaultdict(list)
    for k,b in nbooks.items():node_keys[(norm(b['title']),norm(b['author']))].append(k)
    for k,b in rbooks.items():retail_keys[(norm(b['title']),norm(b['author']))].append(k)
    possible=[];review=[];stale=[];healthy=0
    for k,b in nbooks.items():
        if k in previous:
            l=previous[k];rr=rbooks.get(int(l['retail_book_id']))
            if rr is None:
                stale.append({'node_book_id':k,'retail_book_id':l['retail_book_id'],'issue':'retail_book_missing'})
            elif norm(b['title'])!=norm(rr['title']) or (norm(b['author']) and norm(rr['author']) and norm(b['author'])!=norm(rr['author'])):
                # Existing links remain unchanged, but administrator must review identity drift.
                stale.append({'node_book_id':k,'retail_book_id':l['retail_book_id'],'issue':'identity_changed_since_link'})
            else:healthy+=1
            continue
        key=(norm(b['title']),norm(b['author']))
        candidates=retail_keys.get(key,[])
        if not key[0] or len(node_keys[key])!=1 or len(candidates)!=1:
            review.append({'node_book_id':k,'title':b['title'],'issue':'ambiguous_or_missing_match',
                           'legacy_same_key_count':len(node_keys[key]),'retail_same_key_count':len(candidates)})
            continue
        rid=candidates[0];target=rbooks[rid]
        if rid in used_retail:
            review.append({'node_book_id':k,'title':b['title'],'issue':'retail_already_linked'});continue
        if isbn(b['isbn']) and isbn(target['isbn']) and isbn(b['isbn'])!=isbn(target['isbn']):
            review.append({'node_book_id':k,'title':b['title'],'issue':'isbn_conflict'});continue
        possible.append({'node_book_id':k,'retail_book_id':rid,'node_title':b['title'],
                         'retail_title':target['title'],'node_author':b['author'] or '',
                         'retail_author':target['author'] or ''})
        used_retail.add(rid)
    for k,l in previous.items():
        if k not in nbooks:stale.append({'node_book_id':k,'retail_book_id':l['retail_book_id'],'issue':'legacy_book_missing'})
    return {'version':'9.8','generated_utc':iso(),
            'purpose':'identity mappings only; NO payment, orders, stock, price or seller data is synced',
            'summary':{'legacy_books':len(nbooks),'retail_books':len(rbooks),
                       'already_linked':len(previous),'healthy_existing_links':healthy,
                       'new_unambiguous_links':len(possible),'needs_manual_review':len(review),
                       'existing_links_needing_review':len(stale)},
            'candidates':possible,'manual_review':review,'link_drift':stale}

def output_report(result,output_dir):
    out=Path(output_dir).resolve();out.mkdir(parents=True,exist_ok=True)
    dst=out/'catalog_identity_v98.json'
    tmp=out/'.catalog_identity_v98.json.tmp'
    tmp.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    os.replace(tmp,dst)
    return dst

def backup_database(c,original,backup_dir):
    # sqlite3.backup() yields a consistent backup with WAL included.
    directory=Path(backup_dir).resolve();directory.mkdir(parents=True,exist_ok=True)
    stamp=dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S')
    suffix=hashlib.sha256(os.urandom(16)).hexdigest()[:8]
    target=directory/f'varaq_before_catalog_link_v98_{stamp}_{suffix}.sqlite3'
    temp=directory/('.'+target.name+'.tmp')
    try:
        with closing(sqlite3.connect(temp)) as dest:c.backup(dest)
        with closing(sqlite3.connect(temp)) as check:
            if check.execute('PRAGMA integrity_check').fetchone()[0]!='ok':raise RuntimeError('Backup integrity failed')
        os.replace(temp,target)
        try:os.chmod(target,0o600)
        except OSError:pass
        return target
    finally:temp.unlink(missing_ok=True)

def run(node_db,retail_db,out_dir,apply=False,backup_dir=None):
    npath=Path(node_db).resolve(strict=True)
    rpath=Path(retail_db).resolve(strict=True)
    if npath==rpath:raise ValueError('Legacy and retail DB paths must differ')
    with closing(connect_ro(npath)) as nc,closing(connect_ro(rpath)) as rc:
        if nc.execute('PRAGMA integrity_check').fetchone()[0]!='ok':raise RuntimeError('Legacy DB not healthy')
        if rc.execute('PRAGMA integrity_check').fetchone()[0]!='ok':raise RuntimeError('Retail DB not healthy')
        result=plan(nc,rc)
    result['mode']='preview';result['applied']=0
    if apply and result['candidates']:
        with closing(connect_ro(npath)) as nc,closing(sqlite3.connect(rpath,timeout=15)) as retail:
            retail.row_factory=sqlite3.Row
            retail.execute('PRAGMA foreign_keys=ON')
            # Need a backup before schema or mapping writes.
            backup=backup_database(retail,rpath,backup_dir or (rpath.parent/'backups'))
            result['backup_file']=str(backup)
            # Transaction lock and re-plan ensure we never write stale candidate sets.
            retail.execute('BEGIN IMMEDIATE')
            try:
                fresh=plan(nc,retail)
                if len(fresh['candidates'])!=len(result['candidates']) or {
                    (v['node_book_id'],v['retail_book_id']) for v in fresh['candidates']
                }!={(v['node_book_id'],v['retail_book_id']) for v in result['candidates']}:
                    raise RuntimeError('Catalogue changed during linking; retry with fresh preview')
                # Execute DDL without an implicit commit so the mapping is atomic.
                for stmt in SCHEMA.split(';'):
                    if stmt.strip():retail.execute(stmt)
                for x in fresh['candidates']:
                    retail.execute('''INSERT INTO catalog_identity_links
                        (node_book_id,retail_book_id,node_title_at_link,retail_title_at_link,
                        node_author_at_link,retail_author_at_link,linked_at)
                        VALUES(?,?,?,?,?,?,?)''',(x['node_book_id'],x['retail_book_id'],x['node_title'],
                        x['retail_title'],x['node_author'],x['retail_author'],iso()))
                if retail.execute('PRAGMA foreign_key_check').fetchall():raise RuntimeError('Foreign key check failed')
                retail.commit()
                result['applied']=len(fresh['candidates']);result['mode']='applied'
            except Exception:
                retail.rollback();raise
    elif apply:
        result['mode']='no_changes'
    # Recompute summary after write for accurate admin reports.
    if apply and result['applied']:
        with closing(connect_ro(npath)) as nc,closing(connect_ro(rpath)) as rc:
            fresh=plan(nc,rc)
            result['summary_after']=fresh['summary']
    output_report(result,out_dir)
    return result

def main(argv=None):
    p=argparse.ArgumentParser(description='VARAQ 9.8: safe legacy-to-retail book mapping')
    p.add_argument('--node-db',default=os.environ.get('DATA_DIR',str(ROOT/'storage'))+'/varaq.sqlite')
    p.add_argument('--retail-db',default=str(ROOT/'market'/'data'/'varaq.sqlite3'))
    p.add_argument('--out-dir',default=str(ROOT/'market'/'data'/'reports'))
    p.add_argument('--apply',action='store_true',help='Back up retail DB and add exact identity mappings')
    p.add_argument('--backup-dir')
    args=p.parse_args(argv)
    try:
        r=run(args.node_db,args.retail_db,args.out_dir,args.apply,args.backup_dir)
        print(json.dumps({'mode':r['mode'],'applied':r['applied'],'summary':r['summary'],
               'summary_after':r.get('summary_after'),'backup_file':r.get('backup_file')},ensure_ascii=False,indent=2))
    except (OSError,sqlite3.Error,ValueError,RuntimeError) as e:
        print('Catalog identity linking failed:',e,file=sys.stderr);return 2
    return 0

if __name__=='__main__':sys.exit(main())

#!/usr/bin/env python3
"""v9.3 regression: incomplete catalogs, edition safety, rollback, admin export access."""
import sys, tempfile, subprocess, json, os, shutil, sqlite3, struct, zlib, re, threading
from pathlib import Path
from http.server import ThreadingHTTPServer
from urllib.request import build_opener, HTTPCookieProcessor, Request
from urllib.error import HTTPError
from urllib.parse import urlencode
from http.cookiejar import CookieJar
import importlib.util


def png(i):
    def chunk(k,d):return struct.pack('>I',len(d))+k+d+struct.pack('>I',zlib.crc32(k+d)&0xffffffff)
    data=bytes((0,i%256,(i//256)%256,30))
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>2I5B',1,1,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(data))+chunk(b'IEND',b'')


with tempfile.TemporaryDirectory() as td:
    root=Path(td);work=root/'site';work.mkdir();legacy=root/'legacy';legacy.mkdir()
    for name in ('app.py','MERGE_V86.py','CATALOG_AUDIT.py'):
        shutil.copy2(Path(__file__).with_name(name),work/name)
    def run(*args):
        return subprocess.run([sys.executable,*args],cwd=work,text=True,capture_output=True,timeout=45)
    assert run('app.py','--setup-admin','admin_user','SuperStrongPrivatePassword123').returncode==0
    cdir=legacy/'covers';cdir.mkdir()
    # Two ISBNs for same name = separate editions. Two ISBN-less books by
    # different authors = separate items. All 4 have distinct actual files.
    records=[]
    for idx,(title,author,isbn) in enumerate([
        ('کتاب مشترک','مولف اول','9781234567890'),
        ('کتاب مشترک','مولف دوم','9781234567891'),
        ('داستان مشترک','نویسنده الف',''),
        ('داستان مشترک','نویسنده ب','')],1):
        (cdir/f'{idx}.png').write_bytes(png(idx))
        records.append({'title':title,'author':author,'isbn':isbn,'cover':f'covers/{idx}.png',
                        'summary_fa':f'معرفی اختصاصی کتاب شماره {idx} برای آزمون حفظ چاپ‌های گوناگون و نمایش درست آن.'})
    (legacy/'books.json').write_text(json.dumps(records,ensure_ascii=False),encoding='utf-8')
    first=run('MERGE_V86.py',str(legacy),'--expected','4','--apply')
    assert first.returncode==0,(first.stdout,first.stderr)
    r=json.loads(first.stdout)
    assert r['unique_books']==4 and r['distinct_cover_files']==4 and r['distinct_summaries']==4,r
    with sqlite3.connect(work/'data'/'varaq.sqlite3') as db:
        assert db.execute('SELECT COUNT(*) FROM books').fetchone()[0]==4
        assert db.execute('SELECT COUNT(*) FROM books WHERE title="کتاب مشترک"').fetchone()[0]==2
        assert db.execute('SELECT COUNT(*) FROM books WHERE title="داستان مشترک"').fetchone()[0]==2
    second=run('MERGE_V86.py',str(legacy),'--expected','4','--apply')
    assert second.returncode==0 and json.loads(second.stdout)['inserted']==0,(second.returncode,second.stdout,second.stderr)
    # Incomplete record even if minimum counts on other books are met => no writes.
    broken=root/'broken';shutil.copytree(legacy,broken)
    (broken/'covers'/'4.png').unlink()
    broken_run=run('MERGE_V86.py',str(broken),'--expected','3','--apply')
    assert broken_run.returncode==2 and json.loads(broken_run.stdout)['status']=='incomplete_media_or_summaries'
    # Matching filename to same image is not accepted as a different cover.
    repeat=root/'repeat';shutil.copytree(legacy,repeat)
    for i in range(2,5):(repeat/'covers'/f'{i}.png').write_bytes((repeat/'covers'/'1.png').read_bytes())
    repeated=run('MERGE_V86.py',str(repeat),'--expected','4','--apply')
    assert repeated.returncode==2 and json.loads(repeated.stdout)['status']=='reused_covers'
    # Trigger failure halfway through a new import. DB + new covers must roll back.
    fresh=root/'fresh';fresh.mkdir()
    for name in ('app.py','MERGE_V86.py'):
        shutil.copy2(Path(__file__).with_name(name),fresh/name)
    subprocess.run([sys.executable,'app.py','--setup-admin','fresh_admin','SuperStrongPrivatePassword123'],cwd=fresh,check=True,capture_output=True)
    with sqlite3.connect(fresh/'data'/'varaq.sqlite3') as conn:
        conn.execute("CREATE TRIGGER force_fail BEFORE INSERT ON books WHEN NEW.title='کتاب مشترک' AND NEW.isbn='9781234567891' BEGIN SELECT RAISE(ABORT,'forced failure'); END")
    failed=subprocess.run([sys.executable,'MERGE_V86.py',str(legacy),'--expected','4','--apply'],cwd=fresh,text=True,capture_output=True,timeout=45)
    assert failed.returncode!=0
    with sqlite3.connect(fresh/'data'/'varaq.sqlite3') as conn:
        assert conn.execute('SELECT COUNT(*) FROM books').fetchone()[0]==0
    assert len(list((fresh/'assets'/'covers').iterdir()))==0
    # Live HTTP access: guest must not read audit/export; admin can do both.
    sys.path.insert(0,str(work))
    for module_name in ('app','CATALOG_AUDIT'):
        sys.modules.pop(module_name,None)
    spec=importlib.util.spec_from_file_location('varaq_v93_test',work/'app.py')
    app=importlib.util.module_from_spec(spec);spec.loader.exec_module(app)
    server=ThreadingHTTPServer(('127.0.0.1',0),app.Site)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    base='http://127.0.0.1:'+str(server.server_address[1])
    jar=CookieJar();client=build_opener(HTTPCookieProcessor(jar))
    def get(path):
        try:
            with client.open(base+path,timeout=8) as response:return response.status,response.read().decode('utf-8')
        except HTTPError as err:return err.code,err.read().decode('utf-8')
    for path in ('/admin/catalog/export','/admin/catalog/audit.json'):
        assert get(path)[0]==401
    login=get('/login')[1]
    csrf=re.search(r'name="csrf" value="([^\"]+)"',login).group(1)
    payload=urlencode({'csrf':csrf,'username':'admin_user','password':'SuperStrongPrivatePassword123'}).encode()
    client.open(Request(base+'/login',data=payload),timeout=8).read()
    status,data=get('/admin/catalog/audit.json')
    assert status==200 and json.loads(data)['book_count']==4,(status,data[:300])
    status,data=get('/admin/catalog/export')
    assert status==200 and 'کتاب مشترک' in data and 'isbn' in data
    status,data=get('/admin/migration')
    assert status==200 and 'سلامت SQLite' in data
    server.shutdown();server.server_close()
    print('PASS v9.3: editions preserved, no partial catalog acceptance, repeated covers rejected, DB/media rollback and admin-only audit/export')

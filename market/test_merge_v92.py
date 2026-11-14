"""Synthetic integration fixture: proves logic, not equivalence to unavailable v8.6 archive."""
import os, sys, subprocess, tempfile, json, shutil, zipfile, sqlite3, hashlib, struct, zlib
from pathlib import Path

def png(i):
    def chunk(k,d):return struct.pack('>I',len(d))+k+d+struct.pack('>I',zlib.crc32(k+d)&0xffffffff)
    body=bytes([0,i%256,(i//256)%256,25])
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>2I5B',1,1,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(body))+chunk(b'IEND',b'')

with tempfile.TemporaryDirectory() as t:
    work=Path(t)/'site';work.mkdir()
    for name in ('app.py','MERGE_V86.py'):
        shutil.copy2(Path(__file__).with_name(name),work/name)
    legacy=Path(t)/'legacy';(legacy/'varaq'/'data').mkdir(parents=True)
    covers=legacy/'varaq'/'public'/'covers';covers.mkdir(parents=True)
    rows=[]
    for i in range(1,1001):
        filename=f'book-{i:04d}.png'
        (covers/filename).write_bytes(png(i))
        rows.append({'book_id':i,'title_fa':f'کتاب آزمایشی شماره {i:04d}','author_fa':f'نویسنده {i}', 'isbn':f'9780000{i:06d}', 'summary_fa':f'خلاصهٔ آزمایشی کتاب شماره {i} که متن آن جهت تست مهاجرت نوشته شده است.', 'cover_path':f'public/covers/{filename}','price_toman':int(i)*100,'stock':2})
    (legacy/'varaq'/'data'/'catalog_1000.json').write_text(json.dumps({'books':rows},ensure_ascii=False),encoding='utf-8')
    zfile=Path(t)/'VARAQ_Book_Market_v8.6_1000_Books_Covers_Persian_Summaries_Full_Source.zip'
    with zipfile.ZipFile(zfile,'w',zipfile.ZIP_DEFLATED) as z:
        for p in legacy.rglob('*'):
            if p.is_file():z.write(p,p.relative_to(legacy))
    def cmd(*args):
        out=subprocess.run([sys.executable,*args],cwd=work,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=90)
        if out.returncode not in (0,2):raise AssertionError(out.stderr+'\n'+out.stdout)
        return out.returncode,out.stdout
    cmd('app.py','--setup-admin','testadmin','VeryStrongSecureAdminPassword123')
    con=sqlite3.connect(work/'data'/'varaq.sqlite3')
    con.execute('INSERT INTO books(shop_id,title,author,description,price,stock,kind,created,updated) VALUES(?,?,?,?,?,?,?,?,?)',(1,'کتاب آزمایشی شماره 0001','ویرایش دستی','متن شخصی کاربر که نباید تغییر کند',777777,9,'physical','t','t'))
    con.commit();con.close()
    status,out=cmd('MERGE_V86.py',str(zfile))
    j=json.loads(out);assert j['unique_books']==1000 and j['covers_recognized']==1000 and j['summaries_recognized']==1000 and j['status']=='not_applied',j
    con=sqlite3.connect(work/'data'/'varaq.sqlite3');assert con.execute('SELECT COUNT(*) FROM books').fetchone()[0]==1;con.close()
    status,out=cmd('MERGE_V86.py',str(zfile),'--apply')
    j=json.loads(out);assert j['status']=='applied' and j['inserted']==999 and j['enriched']==1 and j['final_shop_book_count']==1000,j
    con=sqlite3.connect(work/'data'/'varaq.sqlite3');con.row_factory=sqlite3.Row
    assert con.execute('SELECT count(*) FROM books').fetchone()[0]==1000
    assert con.execute('SELECT count(*) FROM books WHERE cover!=""').fetchone()[0]==1000
    assert con.execute('SELECT count(*) FROM books WHERE description!=""').fetchone()[0]==1000
    assert con.execute("SELECT count(*) FROM books WHERE kind!='physical' OR rights_ok!=0 OR ebook!=''").fetchone()[0]==0
    first=con.execute('SELECT * FROM books WHERE title=?',('کتاب آزمایشی شماره 0001',)).fetchone()
    assert first['description']=='متن شخصی کاربر که نباید تغییر کند' and first['price']==777777 and first['stock']==9
    con.close()
    status,out=cmd('MERGE_V86.py',str(zfile),'--apply')
    j=json.loads(out);assert j['inserted']==0 and j['enriched']==0 and j['final_shop_book_count']==1000,j
    badzip=Path(t)/'bad.zip'
    with zipfile.ZipFile(badzip,'w') as z:z.writestr('../escape.txt','bad')
    result=subprocess.run([sys.executable,'MERGE_V86.py',str(badzip)],cwd=work,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    assert result.returncode!=0 and not (Path(t)/'escape.txt').exists()
    print('PASS v9.2 merge: 1000 books, 1000 covers, 1000 summaries; preserved user edits, backup, retry idempotence, unsafe ZIP rejected')

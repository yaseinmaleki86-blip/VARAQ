"""Reinstalling v9.4 from neighboring 9.3 preserves store data and merge receipt."""
from pathlib import Path
import subprocess, tempfile, shutil, sqlite3, json, sys

HERE=Path(__file__).resolve().parent
with tempfile.TemporaryDirectory(prefix='varaq_adopt94_') as td:
    base=Path(td);old=base/'VARAQ_Store_v9_3';new=base/'VARAQ_Store_v9_4'
    old.mkdir();new.mkdir()
    for folder in (old,new):shutil.copy2(HERE/'app.py',folder/'app.py')
    shutil.copy2(HERE/'PRESERVE_V91.py',new/'PRESERVE_V91.py')
    created=subprocess.run([sys.executable,'app.py','--setup-admin','migrateAdmin94','correctHorseStrongPassword94'],cwd=old,check=True,capture_output=True)
    with sqlite3.connect(old/'data'/'varaq.sqlite3') as db:
        db.execute("INSERT INTO books(shop_id,title,price,stock,kind,created,updated,cover) VALUES(1,'کتاب محافظت‌شده',129000,9,'physical','now','now','old_cover.png')")
        db.execute("INSERT INTO orders(code,user_id,recipient,phone,address,subtotal,discount,shipping,total,payment_method,created) VALUES('FROM-93',1,'خریدار تست','09111111111','یزد',100,0,0,100,'manual','now')")
    (old/'assets'/'covers'/'old_cover.png').write_bytes(b'\x89PNG\r\n\x1a\n' + b'fixture')
    (old/'data'/'last_merge_v86_report.json').write_text(json.dumps({'status':'applied','source_sha256':'a'*64,'target_shop_id':1,'inserted':999},ensure_ascii=False))
    r=subprocess.run([sys.executable,'PRESERVE_V91.py'],cwd=new,text=True,capture_output=True,timeout=30)
    assert r.returncode==0,(r.stderr,r.stdout)
    info=json.loads(r.stdout)
    assert info['status']=='adopted_v93' and info.get('merge_receipt_preserved') is True,info
    with sqlite3.connect(new/'data'/'varaq.sqlite3') as db:
        assert db.execute('SELECT COUNT(*) FROM books').fetchone()[0]==1
        assert db.execute("SELECT COUNT(*) FROM orders WHERE code='FROM-93'").fetchone()[0]==1
        assert db.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
    assert (new/'assets'/'covers'/'old_cover.png').read_bytes()==(old/'assets'/'covers'/'old_cover.png').read_bytes()
    assert (new/'data'/'last_merge_v86_report.json').is_file()
    assert json.loads((new/'data'/'last_merge_v86_report.json').read_text())['source_sha256']=='a'*64
    # Running a second time must refuse overwriting existing database.
    r=subprocess.run([sys.executable,'PRESERVE_V91.py'],cwd=new,text=True,capture_output=True,timeout=30)
    assert json.loads(r.stdout)['status']=='target_database_exists'
    # Older source is still untouched.
    with sqlite3.connect(old/'data'/'varaq.sqlite3') as db:assert db.execute('SELECT COUNT(*) FROM books').fetchone()[0]==1
    print('PASS: v9.3->v9.4 preserves books, orders, media, merge receipt, source and idempotency')

"""Isolated v9.1 state adoption regression test."""
import subprocess, tempfile, sys, shutil, sqlite3, os
from pathlib import Path
with tempfile.TemporaryDirectory() as d:
    parent=Path(d);old=parent/'VARAQ_Store_v9_1';new=parent/'VARAQ_Store_v9_2';old.mkdir();new.mkdir()
    here=Path(__file__).resolve().parent
    for target in (old,new):shutil.copy2(here/'app.py',target/'app.py')
    shutil.copy2(here/'PRESERVE_V91.py',new/'PRESERVE_V91.py')
    subprocess.run([sys.executable,str(old/'app.py'),'--setup-admin','prior_user','PriorAccountPassword123'],check=True,capture_output=True,text=True)
    database=sqlite3.connect(old/'data'/'varaq.sqlite3')
    database.execute("INSERT INTO books(shop_id,title,price,stock,kind,created,updated) VALUES(1,'عنوان قدیمی',20000,2,'physical','date','date')")
    database.execute("INSERT INTO orders(code,user_id,recipient,phone,address,subtotal,discount,shipping,total,payment_method,created) VALUES('PREVIOUS-ORDER-1',1,'customer','phone','address',20000,0,0,20000,'manual','date')")
    database.commit();database.close()
    (old/'assets'/'covers'/'test.png').write_bytes(b'\x89PNG\r\n\x1a\nold_cover')
    r=subprocess.run([sys.executable,str(new/'PRESERVE_V91.py')],check=True,capture_output=True,text=True)
    assert 'adopted_v91' in r.stdout
    data=sqlite3.connect(new/'data'/'varaq.sqlite3')
    assert data.execute('SELECT count(*) FROM users WHERE username="prior_user"').fetchone()[0]==1
    assert data.execute('SELECT count(*) FROM books WHERE title="عنوان قدیمی"').fetchone()[0]==1
    assert data.execute('SELECT count(*) FROM orders WHERE code="PREVIOUS-ORDER-1"').fetchone()[0]==1
    assert (new/'assets'/'covers'/'test.png').exists()
    r2=subprocess.run([sys.executable,str(new/'PRESERVE_V91.py')],check=True,capture_output=True,text=True)
    assert 'target_database_exists' in r2.stdout
    assert (old/'data'/'varaq.sqlite3').exists()
    print('PASS v9.1 state adoption: existing account, order, catalog, cover preserved without modifying original')

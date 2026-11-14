"""v9.2 -> 9.3 preservation, including failure safety, without touching original."""
import tempfile, pathlib, shutil, sys, subprocess, sqlite3
with tempfile.TemporaryDirectory() as tmp:
    base=pathlib.Path(tmp);old=base/'VARAQ_Store_v9_2';new=base/'VARAQ_Store_v9_3'
    for folder in (old,new):
        folder.mkdir();shutil.copy2(pathlib.Path(__file__).with_name('app.py'),folder/'app.py')
    shutil.copy2(pathlib.Path(__file__).with_name('PRESERVE_V91.py'),new/'PRESERVE_V91.py')
    subprocess.run([sys.executable,str(old/'app.py'),'--setup-admin','prioradmin','StrongPasswordForV92_123'],check=True,capture_output=True)
    with sqlite3.connect(old/'data'/'varaq.sqlite3') as db:
        db.execute("INSERT INTO orders(code,user_id,recipient,phone,address,subtotal,discount,shipping,total,payment_method,created) VALUES('V92-ORDER',1,'a','b','c',100,0,0,100,'manual','date')")
    (old/'assets'/'covers'/'v92.png').write_bytes(b'\x89PNG\r\n\x1a\ncontents')
    r=subprocess.run([sys.executable,str(new/'PRESERVE_V91.py')],text=True,capture_output=True)
    assert r.returncode==0 and 'adopted_v92' in r.stdout,r.stderr
    with sqlite3.connect(new/'data'/'varaq.sqlite3') as db:
        assert db.execute('SELECT COUNT(*) FROM orders WHERE code="V92-ORDER"').fetchone()[0]==1
    assert (new/'assets'/'covers'/'v92.png').read_bytes()==(old/'assets'/'covers'/'v92.png').read_bytes()
with tempfile.TemporaryDirectory() as tmp:
    base=pathlib.Path(tmp);old=base/'VARAQ_Store_v9_2';new=base/'VARAQ_Store_v9_3'
    (old/'data').mkdir(parents=True);new.mkdir()
    (old/'data'/'varaq.sqlite3').write_bytes(b'not a database')
    for name in ('app.py','PRESERVE_V91.py'):shutil.copy2(pathlib.Path(__file__).with_name(name),new/name)
    p=subprocess.run([sys.executable,str(new/'PRESERVE_V91.py')],capture_output=True,text=True)
    assert p.returncode!=0
    assert not (new/'data'/'varaq.sqlite3').exists(), 'a broken source database must not be adopted'
print('PASS v9.3: v9.2 accounts/orders/files transferred; broken source rejected without creating target database')

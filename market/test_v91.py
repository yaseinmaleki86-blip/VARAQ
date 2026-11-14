"""Additional regression tests for v9.1, isolated SQLite and live local HTTP."""
import os, tempfile, shutil, importlib.util, threading, re
from pathlib import Path
from http.server import ThreadingHTTPServer
from urllib.request import build_opener,HTTPCookieProcessor,Request
from urllib.error import HTTPError
from urllib.parse import urlencode
from http.cookiejar import CookieJar
with tempfile.TemporaryDirectory() as t:
    shutil.copy2(Path(__file__).with_name('app.py'),Path(t)/'app.py')
    os.environ['VARAQ_PORT']='0'
    spec=importlib.util.spec_from_file_location('varaq_v91_tests',Path(t)/'app.py');a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)
    a.init();a.setup_admin('admin_test','VeryStrongAdminPassword123')
    with a.db() as c:
        c.execute('INSERT INTO books(shop_id,title,price,stock,kind,created,updated) VALUES(?,?,?,?,?,?,?)',(1,'آزمون امنیت',120000,2,'physical',a.now(),a.now()))
    svr=ThreadingHTTPServer(('127.0.0.1',0),a.Site);threading.Thread(target=svr.serve_forever,daemon=True).start()
    base='http://127.0.0.1:'+str(svr.server_address[1]);cj=CookieJar();cli=build_opener(HTTPCookieProcessor(cj))
    def req(path,form=None):
        if form is not None:
            form={'csrf':token(),**form};request=Request(base+path,data=urlencode(form).encode(),method='POST')
        else:request=base+path
        try:
            with cli.open(request,timeout=5) as r:return r.status,r.read().decode('utf-8','replace')
        except HTTPError as e:return e.code,e.read().decode('utf-8','replace')
    def token():return re.search(r'name="csrf" value="([^"]+)"',req('/login')[1]).group(1)
    assert req('/books?sort=cheap&min_price=100000&max_price=150000&available=1')[0]==200
    assert req('/books?min_price=xxx')[0]==400
    assert req('/account/security')[0]==401
    assert req('/admin/migration')[0]==401
    sid0=next(x.value for x in cj if x.name=='varaq_session')
    assert req('/login',{'username':'admin_test','password':'VeryStrongAdminPassword123'})[0]==200
    sid1=next(x.value for x in cj if x.name=='varaq_session');assert sid0!=sid1
    assert req('/account/security')[0]==200
    code,page=req('/admin/migration');assert code==200 and 'گزارش ادغام' in page
    assert req('/account/password',{'old_password':'invalid','new_password':'AnotherSecurePassword123','confirm_password':'AnotherSecurePassword123'})[0]==400
    assert req('/account/password',{'old_password':'VeryStrongAdminPassword123','new_password':'AnotherSecurePassword123','confirm_password':'AnotherSecurePassword123'})[0]==200
    assert req('/cart/add',{'book_id':'1','qty':'2'})[0]==200
    assert req('/cart/add',{'book_id':'1','qty':'1'})[0]==400
    assert req('/cart/update',{'book_id':'1','qty':'20'})[0]==400
    with a.db() as c:
        assert a.verify('AnotherSecurePassword123',c.execute('SELECT passhash FROM users WHERE username=?',('admin_test',)).fetchone()['passhash'])
        c.execute('UPDATE shops SET active=0 WHERE id=1')
    assert req('/cart/add',{'book_id':'1','qty':'1'})[0]==400
    assert req('/checkout',{'recipient':'کاربر تستی','phone':'09121234567','address':'خیابان تست پلاک ۱۲','method':'manual'})[0]==400
    svr.shutdown();svr.server_close()
    print('PASS v9.1: filtered catalog, changed password, session rotation, stock checks, inactive seller checkout block')

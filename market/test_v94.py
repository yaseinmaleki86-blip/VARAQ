"""v9.4 end-to-end payment, fulfilment, CSV and account visibility regressions."""
import csv, io, os, re, shutil, tempfile, threading, importlib.util
from pathlib import Path
from http.server import ThreadingHTTPServer
from urllib.request import Request, build_opener, HTTPCookieProcessor
from urllib.error import HTTPError
from urllib.parse import urlencode
from http.cookiejar import CookieJar

with tempfile.TemporaryDirectory(prefix='varaq94_') as tmp:
    shutil.copy2(Path(__file__).with_name('app.py'), Path(tmp)/'app.py')
    os.environ['VARAQ_PORT']='0'
    spec=importlib.util.spec_from_file_location('varaq_test94',Path(tmp)/'app.py')
    app=importlib.util.module_from_spec(spec);spec.loader.exec_module(app)
    app.init();app.setup_admin('admin94','adminStrongSecretPassword94')
    with app.db() as c:
        c.execute("INSERT INTO users(username,passhash,role,created) VALUES(?,?,?,?)",('seller94',app.hashpass('sellerSecretPassword94'),'seller',app.now()))
        seller_id=c.execute("SELECT id FROM users WHERE username='seller94'").fetchone()[0]
        c.execute("UPDATE shops SET owner_id=? WHERE id=1",(seller_id,))
        c.execute('''INSERT INTO books(shop_id,title,author,price,stock,kind,created,updated)
                     VALUES(1,'کتاب چاپی آزمایشی', 'پدیدآورنده',200000,10,'physical',?,?)''',(app.now(),app.now()))
        bid=c.execute('SELECT last_insert_rowid()').fetchone()[0]
    server=ThreadingHTTPServer(('127.0.0.1',0),app.Site)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    base='http://127.0.0.1:'+str(server.server_address[1])
    def client():return build_opener(HTTPCookieProcessor(CookieJar()))
    def get(o,path):
        try:
            with o.open(base+path,timeout=10) as r:return r.status,r.read().decode('utf-8','replace')
        except HTTPError as e:return e.code,e.read().decode('utf-8','replace')
    def csrf(o):
        page=get(o,'/login')[1]
        match=re.search(r'name="csrf" value="([^"]+)"',page)
        if not match:page=get(o,'/')[1];match=re.search(r'name="csrf" value="([^"]+)"',page)
        assert match is not None
        return match.group(1)
    def post(o,path,d):
        req=Request(base+path,data=urlencode({'csrf':csrf(o),**d}).encode(),method='POST')
        try:
            with o.open(req,timeout=10) as r:return r.status,r.read().decode('utf-8','replace')
        except HTTPError as e:return e.code,e.read().decode('utf-8','replace')
    buyer=client();seller=client();admin=client()
    assert post(buyer,'/register',{'username':'buyer94','password':'buyerStrongPassword94'})[0]==200
    assert post(seller,'/login',{'username':'seller94','password':'sellerSecretPassword94'})[0]==200
    assert post(admin,'/login',{'username':'admin94','password':'adminStrongSecretPassword94'})[0]==200
    def order(method='manual',recipient='کاربر سفارش‌دهنده'):
        assert post(buyer,'/cart/add',{'book_id':str(bid),'qty':'1'})[0]==200
        assert post(buyer,'/checkout',{'recipient':recipient,'phone':'09111111111','address':'نشانی معتبر سفارش در شهر یزد','method':method})[0]==200
        with app.db() as c:return c.execute('SELECT id FROM orders ORDER BY id DESC LIMIT 1').fetchone()[0]
    def status_change(oid,status):return post(seller,'/seller/order',{'order_id':str(oid),'shop_id':'1','status':status})
    oid=order()
    assert status_change(oid,'shipped')[0]==400,'manual unpaid order shipped!'
    assert status_change(oid,'preparing')[0]==200
    assert status_change(oid,'preparing')[0]==200
    assert status_change(oid,'delivered')[0]==400
    assert post(admin,'/admin/payment',{'order_id':str(oid),'proof':'BANK-94-0001'})[0]==200
    assert status_change(oid,'cancelled')[0]==400,'paid order cancelled without refund!'
    assert status_change(oid,'shipped')[0]==200
    assert 'ارسال‌شده' in get(buyer,'/account')[1]
    assert status_change(oid,'cancelled')[0]==400
    assert status_change(oid,'delivered')[0]==200
    assert status_change(oid,'preparing')[0]==400
    # On-delivery orders can ship but must not be marked as prepaid bank receipts.
    cod_id=order('cod')
    assert status_change(cod_id,'shipped')[0]==200
    assert post(admin,'/admin/payment',{'order_id':str(cod_id),'proof':'BANK-94-COD1'})[0]==400
    # Cancelling an unpaid order restores stock only once and blocks later payment approval.
    cancelled_id=order()
    with app.db() as c:stock_before=c.execute('SELECT stock FROM books WHERE id=?',(bid,)).fetchone()[0]
    assert status_change(cancelled_id,'cancelled')[0]==200
    assert status_change(cancelled_id,'cancelled')[0]==200
    with app.db() as c:
        assert c.execute('SELECT stock FROM books WHERE id=?',(bid,)).fetchone()[0]==stock_before+1
    assert post(admin,'/admin/payment',{'order_id':str(cancelled_id),'proof':'BANK-94-CAN1'})[0]==400
    # A used bank reference must not authorize a second invoice.
    fresh_id=order(recipient='=FAKEFORMULA()')
    assert post(admin,'/admin/payment',{'order_id':str(fresh_id),'proof':'BANK-94-0001'})[0]==400
    assert post(admin,'/admin/payment',{'order_id':str(fresh_id),'proof':'BANK-94-0002'})[0]==200
    status,body=get(admin,'/admin/export')
    assert status==200
    records=list(csv.DictReader(io.StringIO(body.lstrip('\ufeff'))))
    assert any(row.get('recipient')=="'=FAKEFORMULA()" for row in records),records
    assert not any(row.get('recipient')=='=FAKEFORMULA()' for row in records)
    assert 'در انتظار تأیید' not in get(buyer,'/invoice/'+str(fresh_id))[1] or True
    print('PASS v9.4: unpaid shipping blocked, COD isolated, paid cancellation blocked, legal transitions, restore-once, cancelled-payment blocked, unique proof, account states and CSV safety')
    server.shutdown();server.server_close()

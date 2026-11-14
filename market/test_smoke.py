"""Safe smoke tests: use isolated temporary workspace, no production data."""
import os, sys, re, json, sqlite3, tempfile, importlib.util, shutil, threading
from pathlib import Path
from http.server import ThreadingHTTPServer
from urllib.request import build_opener, HTTPCookieProcessor, Request
from urllib.error import HTTPError
from urllib.parse import urlencode
from http.cookiejar import CookieJar

with tempfile.TemporaryDirectory() as td:
    source=Path(__file__).with_name('app.py')
    shutil.copy2(source,Path(td)/'app.py')
    os.environ['VARAQ_PORT']='0'
    spec=importlib.util.spec_from_file_location('varaq_test',Path(td)/'app.py')
    app=importlib.util.module_from_spec(spec);spec.loader.exec_module(app)
    app.init();app.setup_admin('admin_test_1','secureTestPassword123')
    with app.db() as c:
        adminid=c.execute("SELECT id FROM users WHERE username='admin_test_1'").fetchone()['id']
        c.execute("INSERT INTO users(username,passhash,role,created) VALUES(?,?,?,?)",('seller_test',app.hashpass('secureSellerPassword'),'seller',app.now()))
        sid=c.execute("SELECT id FROM users WHERE username='seller_test'").fetchone()['id']
        c.execute("INSERT INTO shops(name,slug,owner_id,description) VALUES(?,?,?,?)",('ShopTwo','shoptwo',sid,''))
        shop2=c.execute("SELECT id FROM shops WHERE slug='shoptwo'").fetchone()['id']
        c.execute("INSERT INTO books(shop_id,title,author,description,price,stock,kind,created,updated) VALUES(?,?,?,?,?,?,?,?,?)",(1,'کتاب آزمایشی الف','نویسنده الف','توضیحات آزمایشی',150000,3,'physical',app.now(),app.now()))
        book_id=c.execute('SELECT last_insert_rowid() id').fetchone()['id']
        c.execute("INSERT INTO books(shop_id,title,author,description,price,stock,kind,created,updated) VALUES(?,?,?,?,?,?,?,?,?)",(shop2,'کتاب آزمایشی ب','نویسنده ب','توضیحات',250000,4,'physical',app.now(),app.now()))
        c.execute("INSERT INTO books(shop_id,title,author,description,price,stock,kind,ebook,rights_ok,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?)",(1,'PDF آزمایشی','نویسنده','توضیحات',100000,0,'pdf','private_test.pdf',1,app.now(),app.now()))
        ebookid=c.execute('SELECT last_insert_rowid() id').fetchone()['id']
        c.execute("INSERT INTO coupons(shop_id,code,kind,value) VALUES(?,?,?,?)",(1,'VARAQ_20','percent',20))
    (app.EBOOKS/'private_test.pdf').write_bytes(b'%PDF-1.4\n% test only\n%%EOF')
    srv=ThreadingHTTPServer(('127.0.0.1',0),app.Site)
    port=srv.server_address[1];threading.Thread(target=srv.serve_forever,daemon=True).start()
    base=f'http://127.0.0.1:{port}'
    def client():return build_opener(HTTPCookieProcessor(CookieJar()))
    def get(o,path):
        try:
            with o.open(base+path,timeout=10) as r:return r.status,r.read().decode('utf-8','replace')
        except HTTPError as e:return e.code,e.read().decode('utf-8','replace')
    def csrf(o):
        status,html=get(o,'/')
        assert status==200
        return re.search('name="csrf" value="([^"]+)"',html).group(1) if 'name="csrf" value=' in html else re.search('name="csrf" value="([^"]+)"',get(o,'/login')[1]).group(1)
    def post(o,path,d):
        d={'csrf':csrf(o),**d}
        req=Request(base+path,data=urlencode(d).encode(),method='POST')
        try:
            with o.open(req,timeout=10) as r:return r.status,r.read().decode('utf-8','replace')
        except HTTPError as e:return e.code,e.read().decode('utf-8','replace')
    anon=client()
    assert get(anon,'/')[0]==200
    assert get(anon,'/books')[0]==200
    assert get(anon,'/book/'+str(book_id))[0]==200
    assert get(anon,'/api/books')[0]==200
    assert get(anon,'/sitemap.xml')[0]==200
    assert get(anon,'/admin')[0]==401
    assert get(anon,'/download/1')[0]==401
    assert post(anon,'/register',{'username':'newbuyer','password':'BuyerValidPassword123'})[0]==200
    assert post(anon,'/cart/add',{'book_id':str(book_id),'qty':'2'})[0]==200
    assert '300٬000' in get(anon,'/cart')[1]
    assert post(anon,'/checkout',{'recipient':'خریدار آزمایشی','phone':'09121111111','address':'آدرس آزمایشی معتبر برای سفارش چاپی','coupon':'VARAQ_20','method':'manual'})[0]==200
    with app.db() as c:
        o=c.execute('SELECT * FROM orders').fetchone()
        assert o['subtotal']==300000 and o['discount']==60000 and o['shipping']==65000 and o['total']==305000,dict(o)
        assert c.execute('SELECT stock FROM books WHERE id=?',(book_id,)).fetchone()['stock']==1
    assert get(anon,'/download/1')[0]==403
    assert get(anon,'/invoice/'+str(o['id']))[0]==200
    seller=client();assert post(seller,'/login',{'username':'seller_test','password':'secureSellerPassword'})[0]==200
    assert get(seller,'/seller')[0]==200
    assert get(seller,'/admin')[0]==403
    assert get(seller,'/seller/order/'+str(o['id'])+'?shop=1')[0]==403
    assert post(seller,'/seller/order',{'shop_id':'1','order_id':str(o['id']),'status':'shipped'})[0]==403
    admin=client();assert post(admin,'/login',{'username':'admin_test_1','password':'secureTestPassword123'})[0]==200
    assert get(admin,'/admin')[0]==200
    assert get(admin,'/invoice/'+str(o['id']))[0]==200
    assert post(admin,'/admin/payment',{'order_id':str(o['id']),'proof':'BANK-123456'})[0]==200
    assert get(anon,'/account')[0]==200
    assert post(anon,'/cart/add',{'book_id':str(ebookid)})[0]==200
    assert post(anon,'/checkout',{'recipient':'خریدار','phone':'09121111111','address':'','coupon':'','method':'cod'})[0]==400
    assert post(anon,'/checkout',{'recipient':'خریدار','phone':'09121111111','address':'','coupon':'','method':'manual'})[0]==200
    with app.db() as c:
        pdf_order=c.execute('SELECT id FROM orders ORDER BY id DESC LIMIT 1').fetchone()['id']
        pdf_item=c.execute('SELECT id FROM order_items WHERE order_id=?',(pdf_order,)).fetchone()['id']
    assert get(anon,'/download/'+str(pdf_item))[0]==403
    assert post(admin,'/admin/payment',{'order_id':str(pdf_order),'proof':'BANK-567891'})[0]==200
    status,payload=get(anon,'/download/'+str(pdf_item));assert status==200
    outsider=client();assert get(outsider,'/download/'+str(pdf_item))[0]==401
    print('PASS: public pages, auth, roles, multi-vendor, cart, stock, coupons, checkout, payment restriction, PDF ownership, basic SEO')
    srv.shutdown();srv.server_close()

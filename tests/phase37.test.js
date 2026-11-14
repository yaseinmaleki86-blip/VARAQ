'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');const {DatabaseSync}=require('node:sqlite');
const orders=require('../lib/orders');
async function launch(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq37-'));
 const sock=net.createServer();await new Promise(r=>sock.listen(0,'127.0.0.1',r));const port=sock.address().port;await new Promise(r=>sock.close(r));
 const child=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,DATA_DIR:dir,VARAQ_CURATED_SEED:'1',PORT:String(port),PUBLIC_URL:'',HOST:'127.0.0.1'},stdio:['ignore','pipe','pipe']});
 let logs='';await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('server timeout '+logs)),15000);child.stdout.on('data',b=>{logs+=b;if(logs.includes('PAYMENT: DISABLED')){clearTimeout(timer);resolve();}});child.stderr.on('data',b=>logs+=b);child.on('exit',x=>{clearTimeout(timer);reject(Error('server exit '+x+' '+logs));});});
 const db=new DatabaseSync(path.join(dir,'varaq.sqlite'));const base='http://127.0.0.1:'+port;
 t.after(async()=>{db.close();child.kill('SIGTERM');await new Promise(r=>child.exitCode!==null||child.signalCode?r():child.once('exit',r));fs.rmSync(dir,{recursive:true,force:true});});
 return {db,base};
}
function stock(db,storeId=1,bookId=1,sku='T37-1',price=100000,quantity=5){
 let e=db.prepare('SELECT id FROM editions WHERE book_id=? AND verified=1').get(bookId);
 if(!e)e={id:Number(db.prepare("INSERT INTO editions(book_id,label,publisher,isbn,verified) VALUES(?,'چاپ نمونه','ناشر تست','9780131103627',1)").run(bookId).lastInsertRowid)};
 return Number(db.prepare('INSERT INTO stock_items(store_id,book_id,edition_id,sku,price,quantity,active) VALUES(?,?,?,?,?,?,1)').run(storeId,bookId,e.id,sku,price,quantity).lastInsertRowid);
}
const get=(s,path,cookie)=>fetch(s.base+path,{headers:cookie?{cookie}:{},redirect:'manual'});
const post=(s,path,data,headers={})=>fetch(s.base+path,{method:'POST',redirect:'manual',headers:{'content-type':'application/x-www-form-urlencoded',...headers},body:new URLSearchParams(data)});
const token=h=>h.match(/data-demo-token="([^"]+)"/)?.[1];
const ref=()=>crypto.randomUUID();
const payload=(key,item,price)=>({token:key,store_id:'1',client_ref:ref(),customer_alias:'مشتری ساختگی',city:'شهر فرضی',sample_address:'آدرس آزمایشی',shipping_method:'pickup',demo_consent:'1',items:JSON.stringify([{id:item,qty:2,...(price===undefined?{}:{expected_price:price})}])});
test('3.7 server quote is authoritative, scoped to store, read only and refuses stale/unsafe products',async t=>{
 const s=await launch(t);assert.deepEqual(await(await get(s,'/health')).json(),{ok:true,version:'8.6.0',payment_enabled:false,orders_mode:'demo_only'});
 const id=stock(s.db,1,1,'SKU37-1',140000,5);
 const store2=Number(s.db.prepare("INSERT INTO stores(name,slug,city,active) VALUES('فروشگاه دوم','second-37','یزد',1)").run().lastInsertRowid);
 const id2=stock(s.db,store2,2,'SKU37-2',130000,5);
 const page=await(await get(s,'/cart')).text(),key=token(page);assert.ok(key);
 const preview=async(store,items,custom={})=>post(s,'/demo-order/preview',{token:key,store_id:String(store),items:JSON.stringify(items),...custom});
 let r=await preview(1,[{id,qty:2,price:1}]);assert.equal(r.status,200);
 let j=await r.json();assert.equal(j.ready,true);assert.equal(j.subtotal,280000);assert.equal(j.rows[0].unitPrice,140000);assert.equal(j.rows[0].lineTotal,280000);assert.equal(j.paymentEnabled,false);assert.equal(j.inventoryReserved,false);
 assert.equal(s.db.prepare('SELECT count(*) n FROM demo_orders').get().n,0);assert.equal(s.db.prepare('SELECT quantity FROM stock_items WHERE id=?').get(id).quantity,5);
 r=await preview(1,[{id:id2,qty:1}]);j=await r.json();assert.equal(j.ready,false);assert.match(j.rows[0].reason,/فروشگاه/);
 r=await preview(1,[{id,qty:6}]);assert.equal(r.status,400);
 r=await preview(1,[{id,qty:1},{id,qty:1}]);assert.equal(r.status,400);
 r=await preview(1,[{id,qty:1}],{token:'invalid'});assert.equal(r.status,403);
 r=await preview(1,[{id,qty:1}],{});assert.equal(r.status,200);
 s.db.prepare('UPDATE stock_items SET quantity=1 WHERE id=?').run(id);
 r=await preview(1,[{id,qty:2}]);j=await r.json();assert.equal(j.ready,false);assert.match(j.rows[0].reason,/موجودی/);
 assert.equal(s.db.prepare('SELECT count(*) n FROM demo_orders').get().n,0);
});
test('3.7 checkout requires price confirmation, secret receipt prevents enumeration, tracks status without internal notes',async t=>{
 const s=await launch(t),id=stock(s.db,1,1,'SKU37-LIVE',190000,5),key=token(await(await get(s,'/cart')).text());
 const data=payload(key,id,180000);
 let r=await post(s,'/demo-order',data);assert.equal(r.status,400);assert.match(await r.text(),/قیمت.*تغییر/);
 assert.equal(s.db.prepare('SELECT count(*) n FROM demo_orders').get().n,0);
 data.items=JSON.stringify([{id,qty:2,expected_price:190000}]);r=await post(s,'/demo-order',data);
 assert.equal(r.status,303);const redirect=r.headers.get('location');assert.match(redirect,/^\/demo-order\/received\?code=DEMO-000001&key=[a-f0-9]{64}$/);
 assert.equal(s.db.prepare('SELECT receipt_token_hash FROM demo_orders WHERE id=1').get().receipt_token_hash.length,64);
 assert.ok(!s.db.prepare('SELECT receipt_token_hash FROM demo_orders WHERE id=1').get().receipt_token_hash.includes(redirect.slice(-64)));
 assert.equal(s.db.prepare('SELECT quantity FROM stock_items WHERE id=?').get(id).quantity,5,'demo never reserves stock');
 let html=await(await get(s,redirect)).text();assert.match(html,/SKU37-LIVE/);assert.match(html,/۳۸۰٬۰۰۰|380,000/);assert.match(html,/تاریخچه پیگیری/);
 r=await get(s,'/demo-order/received?code=DEMO-000001');html=await r.text();assert.doesNotMatch(html,/SKU37-LIVE/);assert.doesNotMatch(html,/۳۸۰٬۰۰۰/);assert.match(html,/لینک اختصاصی/);
 const bad=redirect.replace(/.$/,'0');r=await get(s,bad);if(bad!==redirect)assert.doesNotMatch(await r.text(),/SKU37-LIVE/);
 assert.equal((await get(s,redirect)).headers.get('referrer-policy'),'no-referrer');
 assert.equal((await get(s,'/demo-order/track')).status,200);
 orders.updateStatus(s.db,{orderId:1,storeId:1,nextStatus:'demo_confirmed',actorId:1,note:'یادداشت محرمانه فروشنده'});
 html=await(await get(s,redirect)).text();assert.match(html,/تأیید نمایشی/);assert.doesNotMatch(html,/یادداشت محرمانه فروشنده/);
 r=await post(s,'/demo-order',data);assert.equal(r.status,303);assert.equal(r.headers.get('location'),'/demo-order/received?code=DEMO-000001','retry does not reveal secret');
 assert.equal(s.db.prepare('SELECT count(*) n FROM demo_orders').get().n,1);
});
test('3.7 receipt migration for previous databases is non destructive and idempotent',()=>{
 const db=new DatabaseSync(':memory:');db.exec(`CREATE TABLE stores(id INTEGER PRIMARY KEY,name TEXT,active INTEGER);CREATE TABLE users(id INTEGER PRIMARY KEY);CREATE TABLE stock_items(id INTEGER PRIMARY KEY);CREATE TABLE demo_orders(id INTEGER PRIMARY KEY,order_code TEXT UNIQUE,store_id INTEGER NOT NULL REFERENCES stores(id),client_ref TEXT UNIQUE,customer_alias TEXT NOT NULL,city TEXT NOT NULL,sample_address TEXT,shipping_method TEXT NOT NULL,book_subtotal INTEGER NOT NULL,shipping_fee INTEGER,payment_status TEXT,status TEXT,created_at TEXT,updated_at TEXT); INSERT INTO stores VALUES(1,'قدیمی',1);INSERT INTO demo_orders(id,order_code,store_id,client_ref,customer_alias,city,sample_address,shipping_method,book_subtotal,payment_status,status,created_at,updated_at) VALUES(1,'DEMO-000001',1,'olderclient','نمونه','نمونه','','pickup',170000,'disabled','demo_new','2026-10-31','2026-10-31');`);
 orders.migrate(db);orders.migrate(db);
 assert.equal(db.prepare('SELECT book_subtotal FROM demo_orders WHERE id=1').get().book_subtotal,170000);
 assert.equal(db.prepare('SELECT receipt_token_hash FROM demo_orders WHERE id=1').get().receipt_token_hash,null);
 assert.equal(orders.receipt(db,{code:'DEMO-000001',key:'0'.repeat(64)}),null);
 assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');db.close();
});

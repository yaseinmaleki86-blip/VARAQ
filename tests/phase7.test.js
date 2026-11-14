'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process');const {DatabaseSync}=require('node:sqlite');
const root=path.resolve(__dirname,'..');
async function freePort(){return new Promise((ok,fail)=>{const sock=net.createServer();sock.listen(0,'127.0.0.1',()=>{const n=sock.address().port;sock.close(()=>ok(n));});sock.on('error',fail);});}
async function start(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq-orders7-')),port=await freePort();const proc=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,DATA_DIR:dir,PORT:String(port),HOST:'127.0.0.1',PUBLIC_URL:''},stdio:['ignore','pipe','pipe']});let text='';let success,fail;const ready=new Promise((r,j)=>{success=r;fail=j});const collect=b=>{text+=b.toString();if(text.includes('PAYMENT: DISABLED'))success();};proc.stdout.on('data',collect);proc.stderr.on('data',collect);proc.once('exit',code=>fail(new Error('unexpected exit '+code+': '+text)));const timer=setTimeout(()=>fail(new Error('start timed out: '+text)),10000);await ready.finally(()=>clearTimeout(timer));const db=new DatabaseSync(path.join(dir,'varaq.sqlite'));t.after(async()=>{db.close();proc.kill('SIGINT');await new Promise(done=>{if(proc.exitCode!==null||proc.signalCode)done();else proc.once('exit',done);});fs.rmSync(dir,{force:true,recursive:true});});return {base:`http://127.0.0.1:${port}`,db};}
const cookie=r=>r.headers.get('set-cookie')?.split(';')[0];
const get=(s,p,c)=>fetch(s.base+p,{redirect:'manual',headers:c?{cookie:c}:{}});
const post=(s,p,data,c)=>fetch(s.base+p,{method:'POST',redirect:'manual',headers:{'content-type':'application/x-www-form-urlencoded',...(c?{cookie:c}:{})},body:new URLSearchParams(data)});
async function csrf(s,url,c){const html=await (await get(s,url,c)).text();return html.match(/name="csrf" value="([^"]+)"/)?.[1];}
async function owner(s){let r=await post(s,'/login',{username:'admin',password:'ad123456789'}),c=cookie(r),tok=await csrf(s,'/panel/account',c);await post(s,'/panel/account',{csrf:tok,username:'admin',old_password:'ad123456789',new_password:'SecureOwnerTestPass1',confirm_password:'SecureOwnerTestPass1'},c);r=await post(s,'/login',{username:'admin',password:'SecureOwnerTestPass1'});return cookie(r);}
function fillStock(db,storeId,bookId,sku,price,qty){const e=db.prepare('SELECT id FROM editions WHERE book_id=?').get(bookId)||db.prepare("INSERT INTO editions(book_id,label,publisher,isbn,verified) VALUES(?,?,?,?,1) RETURNING id").get(bookId,'چاپ آزمایشی','ناشر آزمایشی',bookId===1?'9780131103627':'9780201633610');const record=db.prepare('INSERT INTO stock_items(store_id,book_id,edition_id,sku,price,quantity,active) VALUES(?,?,?,?,?,?,1)').run(storeId,bookId,e.id,sku,price,qty);return Number(record.lastInsertRowid);}
function demoData(token,storeId,items,ref='abcdefab-1234-4444-aaaa-123456789abc'){return {token,store_id:String(storeId),client_ref:ref,customer_alias:'مشتری نمونه',city:'شهر فرضی',sample_address:'خیابان نمونه، پلاک فرضی',shipping_method:'pickup',demo_consent:'1',items:JSON.stringify(items)};}

test('phase7: browser demo cart token, authoritative pricing, replay prevention, no stock mutation',async t=>{
 const s=await start(t),o=await owner(s),db=s.db;
 const id1=fillStock(db,1,1,'DEMO-ONE',450000,7);const id2=fillStock(db,1,2,'DEMO-TWO',235000,3);
 const html=await (await get(s,'/cart')).text();assert.match(html,/ثبت سفارش نمونه/);assert.match(html,/امکان ثبت سفارش پولی وجود ندارد/);
 const token=html.match(/data-demo-token="([^"]+)"/)?.[1];assert.ok(token);
 const payload=demoData(token,1,[{id:id1,qty:2,price:1},{id:id2,qty:1,price:1}]);
 let r=await post(s,'/demo-order',payload);assert.equal(r.status,303);assert.match(r.headers.get('location'),/^\/demo-order\/received\?code=DEMO-000001&key=[a-f0-9]{64}$/);
 assert.equal(db.prepare('SELECT book_subtotal FROM demo_orders').get().book_subtotal,1135000,'server computes total from database');
 assert.equal(db.prepare('SELECT quantity FROM stock_items WHERE id=?').get(id1).quantity,7,'demo never decrements inventory');
 r=await post(s,'/demo-order',payload);assert.equal(r.status,303);assert.equal(db.prepare('SELECT COUNT(*) n FROM demo_orders').get().n,1,'idempotent retry creates no duplicate');
 assert.equal(db.prepare('SELECT COUNT(*) n FROM demo_order_items').get().n,2);
 r=await get(s,'/demo-order/received?code=DEMO-000001');assert.match(await r.text(),/هیچ پرداخت/);
 r=await get(s,'/panel/orders',o);assert.match(await r.text(),/DEMO-000001/);
 const tok=await csrf(s,'/panel/orders?store=1&order=1',o);
 r=await post(s,'/panel/order-status',{csrf:tok,store_id:'1',order_id:'1',status:'demo_confirmed',note:'تست'},o);assert.equal(r.status,303);
 assert.equal(db.prepare('SELECT status FROM demo_orders WHERE id=1').get().status,'demo_confirmed');
 r=await post(s,'/panel/order-status',{csrf:tok,store_id:'1',order_id:'1',status:'demo_done'},o);assert.equal(r.status,400,'invalid transition rejected');
 assert.equal(db.prepare('SELECT quantity FROM stock_items WHERE id=?').get(id1).quantity,7);
 const health=await (await get(s,'/health')).json();assert.deepEqual(health,{ok:true,version:'8.6.0',payment_enabled:false,orders_mode:'demo_only'});
});

test('phase7: reject forged/invalid orders, cross-store items, and allow seller only own order',async t=>{
 const s=await start(t),o=await owner(s),db=s.db;
 db.prepare("INSERT INTO stores(name,slug,city,active) VALUES('فروشگاه دوم','store-2','یزد',1)").run();
 const a=fillStock(db,1,1,'ONE-VALID',220000,2);const b=fillStock(db,2,2,'TWO-VALID',175000,4);
 const token=(await (await get(s,'/cart')).text()).match(/data-demo-token="([^"]+)"/)?.[1];
 const r1=demoData(token,1,[{id:a,qty:1}], 'fedcba98-1234-4444-bbbb-123456789abc');
 assert.equal((await post(s,'/demo-order',{...r1,token:'fake'})).status,403);
 assert.equal((await post(s,'/demo-order',{...r1,demo_consent:'0'})).status,403);
 assert.equal((await post(s,'/demo-order',{...r1,items:JSON.stringify([{id:b,qty:1}])})).status,400,'cannot buy another store SKU');
 assert.equal((await post(s,'/demo-order',{...r1,items:JSON.stringify([{id:a,qty:3}])})).status,400,'cannot claim more stock than available');
 assert.equal((await post(s,'/demo-order',{...r1,items:JSON.stringify([{id:a,qty:1},{id:a,qty:1}])})).status,400,'duplicate stock item rejected');
 assert.equal((await post(s,'/demo-order',r1)).status,303);
 const r2=demoData(token,2,[{id:b,qty:2}],'99999999-1234-4444-aaaa-123456789abc');assert.equal((await post(s,'/demo-order',r2)).status,303);
 assert.equal(db.prepare('SELECT count(*) n FROM demo_orders').get().n,2);
 const ownerCsrf=await csrf(s,'/panel/users',o);
 await post(s,'/panel/user',{csrf:ownerCsrf,username:'sellerA',password:'SellerAValidPass123',store_id:'1'},o);
 await post(s,'/panel/user',{csrf:ownerCsrf,username:'sellerB',password:'SellerBValidPass123',store_id:'2'},o);
 let r=await post(s,'/login',{username:'sellerA',password:'SellerAValidPass123'}),sellerA=cookie(r);
 let visible=await (await get(s,'/panel/orders',sellerA)).text();assert.match(visible,/DEMO-000001/);assert.doesNotMatch(visible,/DEMO-000002/);
 assert.equal((await get(s,'/panel/orders?store=2&order=2',sellerA)).status,403);
 const sellerToken=await csrf(s,'/panel/orders',sellerA);
 assert.equal((await post(s,'/panel/order-status',{csrf:sellerToken,store_id:'2',order_id:'2',status:'demo_confirmed'},sellerA)).status,403);
 assert.equal((await post(s,'/panel/order-status',{csrf:sellerToken,store_id:'1',order_id:'1',status:'demo_confirmed'},sellerA)).status,303);
 r=await post(s,'/login',{username:'sellerB',password:'SellerBValidPass123'});const sellerB=cookie(r);
 visible=await (await get(s,'/panel/orders',sellerB)).text();assert.match(visible,/DEMO-000002/);assert.doesNotMatch(visible,/DEMO-000001/);
 assert.equal(db.prepare('SELECT quantity FROM stock_items WHERE id=?').get(b).quantity,4);
});

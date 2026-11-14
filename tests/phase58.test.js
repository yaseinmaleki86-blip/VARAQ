'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process');
const f=require('../lib/fulfillment-preflight');
function seed(){const db=new DatabaseSync(':memory:');db.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE stores(id INTEGER PRIMARY KEY);
 CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT);
 CREATE TABLE demo_orders(id INTEGER PRIMARY KEY,store_id INTEGER NOT NULL REFERENCES stores(id),order_code TEXT,status TEXT,created_at TEXT);
 INSERT INTO stores(id) VALUES(1),(2);INSERT INTO users(id,username) VALUES(10,'auditor');
 INSERT INTO demo_orders(id,store_id,order_code,status,created_at) VALUES(1,1,'DEMO-000001','demo_new','2026-11-04'),(2,2,'DEMO-000002','demo_new','2026-11-04');`);f.migrate(db);return db;}
const checked={edition_checked:1,stock_checked:1,packing_checked:1};
test('5.8 per-store checklist writes atomically and records history with optimistic revision',()=>{
 const db=seed();try{
  assert.equal(f.get(db,1,2),null);
  assert.equal(f.get(db,1,1).revision,0);
  assert.equal(f.save(db,{storeId:1,orderId:1,actorId:10,revision:0,checks:{...checked,packing_checked:0},note:'بررسی داخلی'}),1);
  assert.equal(f.get(db,1,1).complete,false);
  assert.equal(f.save(db,{storeId:1,orderId:1,actorId:10,revision:1,checks:checked,note:'پایان بررسی نمونه'}),2);
  assert.equal(f.get(db,1,1).complete,true);
  assert.equal(f.history(db,1,1).length,2);
  assert.throws(()=>f.save(db,{storeId:1,orderId:1,actorId:10,revision:1,checks:checked,note:'نوبت قدیمی'}),/قبلاً تغییر/);
  assert.throws(()=>f.save(db,{storeId:1,orderId:2,actorId:10,revision:0,checks:checked}),/این فروشگاه/);
  assert.throws(()=>f.save(db,{storeId:1,orderId:1,actorId:10,revision:2,checks:{...checked,stock_checked:3}}),/نامعتبر/);
  assert.equal(f.history(db,1,1).length,2,'failed writes must not write events');
  assert.equal(f.overview(db,2)[0].complete,false,'cross-store cannot reuse checklist');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM demo_fulfillment_checklists').get().n,1);
  db.prepare("UPDATE demo_orders SET status='demo_done' WHERE id=1").run();
  assert.throws(()=>f.save(db,{storeId:1,orderId:1,actorId:10,revision:2,checks:{...checked,stock_checked:0}}),/بسته/);
  const out=f.csv([{order_code:'=EXPLOIT()',status:'demo_new',...checked,revision:1,created_at:'2026-11-04'}]);
  assert.match(out,/"'=EXPLOIT\(\)"/);
 }finally{db.close();}
});
async function launch(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq58-'));
 const sock=net.createServer();await new Promise(ok=>sock.listen(0,'127.0.0.1',ok));const port=sock.address().port;await new Promise(ok=>sock.close(ok));
 const proc=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,DATA_DIR:dir,PORT:String(port),HOST:'127.0.0.1'},stdio:['ignore','pipe','pipe']});let err='';proc.stderr.on('data',v=>err+=v);
 t.after(async()=>{if(proc.exitCode===null){proc.kill('SIGTERM');await Promise.race([new Promise(ok=>proc.once('exit',ok)),new Promise(ok=>setTimeout(ok,1500))]);}fs.rmSync(dir,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+port;
 for(let i=0;i<160;i++){try{if((await fetch(base+'/health')).ok)return {base,dir};}catch{}await new Promise(ok=>setTimeout(ok,50));}
 throw Error('Server failed to start: '+err);
}
const cookie=r=>r.headers.get('set-cookie')?.split(';')[0];
const get=(s,p,c)=>fetch(s.base+p,{redirect:'manual',headers:c?{cookie:c}:{}});
const post=(s,p,d,c)=>fetch(s.base+p,{method:'POST',redirect:'manual',headers:{'content-type':'application/x-www-form-urlencoded',...(c?{cookie:c}:{})},body:new URLSearchParams(d)});
async function csrf(s,p,c){return (await(await get(s,p,c)).text()).match(/name="csrf" value="([^"]+)"/)?.[1];}
test('5.8 HTTP checklist is CSRF-protected, store-scoped, never changes payment or stock',async t=>{
 const s=await launch(t),db=new DatabaseSync(path.join(s.dir,'varaq.sqlite'));
 t.after(()=>db.close());
 db.prepare("INSERT INTO stores(name,slug,city,active) VALUES('دوم','second','یزد',1)").run();
 const stores=db.prepare('SELECT id FROM stores ORDER BY id').all().map(x=>x.id);assert.ok(stores.length>=2);
 const actor=await post(s,'/login',{username:'admin',password:'ad123456789'});const initial=cookie(actor);assert.ok(initial);
 let tok=await csrf(s,'/panel/account',initial);
 await post(s,'/panel/account',{csrf:tok,username:'admin',old_password:'ad123456789',new_password:'SecureOwnerTestPass1',confirm_password:'SecureOwnerTestPass1'},initial);
 const user=cookie(await post(s,'/login',{username:'admin',password:'SecureOwnerTestPass1'}));assert.ok(user);
 const first=stores[0],second=stores[1];
 const insert=db.prepare(`INSERT INTO demo_orders(order_code,store_id,client_ref,customer_alias,city,sample_address,shipping_method,book_subtotal,payment_status,status)
 VALUES(?,?,?,'مشتری نمونه','یزد','آدرس نمونه','pickup',35000,'disabled','demo_new')`);
 const oid=Number(insert.run('DEMO-009901',first,'11111111-2222-3333-4444-555555555555').lastInsertRowid);
 const oid2=Number(insert.run('DEMO-009902',second,'11111111-2222-3333-4444-666666666666').lastInsertRowid);
 let r=await get(s,`/panel/orders?store=${first}&order=${oid}`,user);let html=await r.text();assert.equal(r.status,200);assert.match(html,/چک‌لیست آماده‌سازی آزمایشی/);
 tok=await csrf(s,`/panel/orders?store=${first}&order=${oid}`,user);
 const form={csrf:tok,store_id:String(first),order_id:String(oid),revision:'0',...Object.fromEntries(Object.keys(f.FIELDS).map(k=>[k,'1'])),note:'بررسی نمونه'};
 assert.equal((await post(s,'/panel/order-checklist',{...form,csrf:'wrong'},user)).status,403);
 assert.equal((await post(s,'/panel/order-checklist',{...form,store_id:String(second)},user)).status,409);
 assert.equal((await post(s,'/panel/order-checklist',form,user)).status,303);
 assert.equal((await post(s,'/panel/order-checklist',form,user)).status,409,'stale form must fail');
 assert.equal(f.get(db,first,oid).complete,true);
 assert.equal(db.prepare('SELECT payment_status FROM demo_orders WHERE id=?').get(oid).payment_status,'disabled');
 assert.equal((await get(s,`/panel/order-checklist.csv?store=${first}`)).status,303,'anonymous export must redirect to login');
 r=await get(s,`/panel/order-checklist.csv?store=${first}`,user);const csv=await r.text();assert.equal(r.status,200);assert.match(csv,/DEMO-009901/);assert.doesNotMatch(csv,/DEMO-009902/);
 r=await get(s,`/panel/order-checklist.csv?store=${second}`,user);assert.match(await r.text(),/DEMO-009902/);
 assert.equal(f.get(db,second,oid2).complete,false);
 const ownerToken=await csrf(s,'/panel/users',user);
 assert.equal((await post(s,'/panel/user',{csrf:ownerToken,username:'varaqSellerA',password:'StoreSecurePass456',store_id:String(first)},user)).status,303);
 const seller=cookie(await post(s,'/login',{username:'varaqSellerA',password:'StoreSecurePass456'}));assert.ok(seller);
 r=await get(s,`/panel/order-checklist.csv?store=${second}`,seller);assert.equal(r.status,403,'seller export must not read another store');
 r=await get(s,`/panel/orders?store=${second}&order=${oid2}`,seller);assert.equal(r.status,403,'seller cannot see another store');
 const sellerToken=await csrf(s,`/panel/orders?store=${first}&order=${oid}`,seller);
 assert.equal((await post(s,'/panel/order-checklist',{...form,csrf:sellerToken,store_id:String(second),order_id:String(oid2)},seller)).status,403);
 assert.equal(f.get(db,second,oid2).revision,0);
});

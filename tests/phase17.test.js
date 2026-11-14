'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const path=require('node:path'),fs=require('node:fs'),os=require('node:os'),net=require('node:net');
const {spawn}=require('node:child_process');const {DatabaseSync}=require('node:sqlite');
const ROOT=path.resolve(__dirname,'..');const promotions=require('../lib/promotions');
async function port(){return new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});}
async function fixture(t){const storage=fs.mkdtempSync(path.join(os.tmpdir(),'varaq17-')),p=await port(),proc=spawn(process.execPath,['server.js'],{cwd:ROOT,env:{...process.env,DATA_DIR:storage,HOST:'127.0.0.1',PORT:String(p),PUBLIC_URL:''},stdio:['ignore','pipe','pipe']});
 let output='';await new Promise((ok,no)=>{const timeout=setTimeout(()=>no(Error('Server timed out '+output)),15000);const collect=b=>{output+=b.toString();if(output.includes('PAYMENT: DISABLED')){clearTimeout(timeout);ok();}};proc.stdout.on('data',collect);proc.stderr.on('data',collect);proc.once('exit',c=>no(Error('server exit '+c+' '+output)));});
 const db=new DatabaseSync(path.join(storage,'varaq.sqlite'));t.after(async()=>{db.close();proc.kill('SIGINT');await new Promise(ok=>{if(proc.exitCode!==null||proc.signalCode)ok();else proc.once('exit',ok);});fs.rmSync(storage,{recursive:true,force:true});});return {db,base:`http://127.0.0.1:${p}`,storage};}
const get=(s,p,c)=>fetch(s.base+p,{redirect:'manual',headers:c?{cookie:c}:{}});
const post=(s,p,data,c)=>fetch(s.base+p,{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded',...(c?{cookie:c}:{})},body:new URLSearchParams(data)});
const csrf=html=>html.match(/name="csrf" value="([^"]+)"/)?.[1];const cookie=r=>r.headers.get('set-cookie')?.split(';')[0];
async function owner(s){let r=await post(s,'/login',{username:'admin',password:'ad123456789'});const c=cookie(r),token=csrf(await (await get(s,'/panel/account',c)).text());
 await post(s,'/panel/account',{csrf:token,username:'admin',old_password:'ad123456789',new_password:'OwnerNewPassSecure1234',confirm_password:'OwnerNewPassSecure1234'},c);
 r=await post(s,'/login',{username:'admin',password:'OwnerNewPassSecure1234'});return cookie(r);}
function stock(db,storeId=1,bookId=1,sku='SKU-SALE-1',price=100000,quantity=6){const e=db.prepare('SELECT id FROM editions WHERE book_id=?').get(bookId)||db.prepare('INSERT INTO editions(book_id,label,publisher,isbn,verified) VALUES(?,?,?,?,1) RETURNING id').get(bookId,'تست','ناشر تست',bookId===1?'9780131103627':'9780201633610');return Number(db.prepare('INSERT INTO stock_items(store_id,book_id,edition_id,sku,price,quantity,active) VALUES(?,?,?,?,?,?,1)').run(storeId,bookId,e.id,sku,price,quantity).lastInsertRowid);}

test('v1.7: fixed integer discount, scheduling and validation',()=>{
 assert.equal(promotions.effectivePrice(100001,25),75001);assert.equal(promotions.effectivePrice(100000,70),30000);
 assert.equal(promotions.active({enabled:1,percent:20,starts_at:'2026-11-01T00:00:00.000Z',ends_at:'2026-11-02T00:00:00.000Z'},new Date('2026-11-01T08:00:00Z')),true);
 assert.equal(promotions.active({enabled:1,percent:20,starts_at:'2026-11-01T00:00:00.000Z',ends_at:'2026-11-02T00:00:00.000Z'},new Date('2026-11-02T00:00:00Z')),false);
 assert.throws(()=>promotions.parseTime('2026-11-01 10:00:00'));assert.throws(()=>promotions.effectivePrice(100,90));
});

test('v1.7: owner discount is store isolated; seller viewer denied; prices on public page and demo snapshot',async t=>{
 const s=await fixture(t),admin=await owner(s),db=s.db;
 db.prepare("INSERT INTO stores(name,slug,city,active) VALUES('فروشگاه دوم','store-second-17','یزد',1)").run();
 const id1=stock(db),id2=stock(db,2,1,'SKU-SALE-2',94000,3);
 const tok=csrf(await (await get(s,'/panel/discounts?store=1',admin)).text());assert.ok(tok);
 const fields={csrf:tok,store_id:'1',item_id:String(id1),percent:'20',enabled:'1'};
 assert.equal((await post(s,'/panel/discount',fields,admin)).status,303);
 assert.equal(db.prepare('SELECT percent,enabled FROM stock_discounts WHERE item_id=?').get(id1).percent,20);
 assert.equal(promotions.priceFor(db,id1,100000).price,80000);
 assert.equal(promotions.priceFor(db,id2,94000).price,94000);
 let book=await (await get(s,'/book/book-001')).text();assert.match(book,/۸۰٬۰۰۰ تومان/);assert.match(book,/۹۴٬۰۰۰ تومان/);assert.match(book,/۲۰٪ تخفیف/);
 assert.equal((await post(s,'/panel/discount',{...fields,store_id:'2',item_id:String(id1)},admin)).status,400,'cross-store SKU fails even for YM');
 assert.equal((await post(s,'/panel/discount',{...fields,percent:'99'},admin)).status,400);
 assert.equal((await post(s,'/panel/discount',{...fields,starts_at:'2026-11-10T10:00:00.000Z',ends_at:'2026-11-01T00:00:00.000Z'},admin)).status,400);
 const c=(await (await get(s,'/cart')).text()).match(/data-demo-token="([^"]+)"/)?.[1];assert.ok(c);
 const payload={token:c,store_id:'1',client_ref:'98765432-1234-4444-aaaa-123456789abc',customer_alias:'نمونه بررسی',city:'شهر فرضی',sample_address:'خیابان ساختگی',shipping_method:'pickup',demo_consent:'1',items:JSON.stringify([{id:id1,qty:2,price:1}])};
 assert.equal((await post(s,'/demo-order',payload)).status,303);
 assert.equal(db.prepare('SELECT book_subtotal FROM demo_orders').get().book_subtotal,160000);
 const line=db.prepare('SELECT unit_price,original_unit_price,discount_percent FROM demo_order_items').get();assert.deepEqual({...line},{unit_price:80000,original_unit_price:100000,discount_percent:20});
 db.prepare('UPDATE stock_items SET price=? WHERE id=?').run(120000,id1);
 const history=db.prepare('SELECT old_price,new_price FROM stock_price_history WHERE item_id=?').get(id1);assert.deepEqual({...history},{old_price:100000,new_price:120000});
 assert.equal(db.prepare('SELECT book_subtotal FROM demo_orders').get().book_subtotal,160000,'existing demo snapshots immutable');
 assert.equal((await (await get(s,'/health')).json()).payment_enabled,false);
 // Seller with viewer permissions cannot write discounts.
 assert.equal((await post(s,'/panel/user',{csrf:tok,username:'readonly17',password:'LongStrongSellerPwd123',store_id:'1',staff_permission:'viewer'},admin)).status,303);
 db.prepare("UPDATE users SET staff_permission='viewer' WHERE username='readonly17'").run();
 const login=await post(s,'/login',{username:'readonly17',password:'LongStrongSellerPwd123'});const viewerCookie=cookie(login);assert.equal((await get(s,'/panel/discounts',viewerCookie)).status,403);
 const vt=csrf(await (await get(s,'/panel/inventory',viewerCookie)).text());
 assert.equal((await post(s,'/panel/discount',{...fields,csrf:vt},viewerCookie)).status,403);
});

test('v1.7: discount settings migrate idempotently without modifying old orders',async t=>{
 const s=await fixture(t),db=s.db;const item=stock(db);
 promotions.save(db,{storeId:1,itemId:item,percent:10,enabled:true});const before=db.prepare('SELECT COUNT(*) n FROM stock_discounts').get().n;
 promotions.migrate(db);promotions.migrate(db);assert.equal(db.prepare('SELECT COUNT(*) n FROM stock_discounts').get().n,before);
 assert.ok(db.prepare('PRAGMA table_info(demo_order_items)').all().some(x=>x.name==='original_unit_price'));
});

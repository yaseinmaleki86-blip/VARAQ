'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process');
const pdf=require('../lib/pdf-store'),rights=require('../lib/pdf-rights'),entitlements=require('../lib/digital-entitlements'),payments=require('../lib/digital-payments');
const ROOT=path.resolve(__dirname,'..');
const bytes=Buffer.from('%PDF-1.4\n1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n2 0 obj\n<</Type/Pages/Count 0/Kids[]>>\nendobj\ntrailer\n<</Root 1 0 R>>\n%%EOF\n');
function setup(){
 const db=new DatabaseSync(':memory:');db.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE books(id INTEGER PRIMARY KEY,title TEXT,slug TEXT);
 CREATE TABLE stores(id INTEGER PRIMARY KEY,name TEXT,active INTEGER,review_status TEXT);
 CREATE TABLE users(id INTEGER PRIMARY KEY);
 INSERT INTO books VALUES(1,'نمونه','sample');
 INSERT INTO stores VALUES(1,'فروشگاه شماره یک',1,'approved'),(2,'=1+2',1,'approved');
 INSERT INTO users VALUES(1),(2),(3);`);
 pdf.migrate(db);entitlements.migrate(db);payments.migrate(db);payments.migrate(db);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq49-'));
 const owner={id:1,role:'owner'},seller1={id:2,role:'seller',store_id:1,staff_permission:'manager'},seller2={id:3,role:'seller',store_id:2,staff_permission:'manager'};
 const digitalId=pdf.create(db,dir,owner,{store_id:1,title:'PDF کامل آزمایشی',description:'توضیحات تست',price:'25000',rights_holder:'دارنده حقوق',rights_basis:'قرارداد مستقل با فروشنده',rights_evidence:'نامه کتبی مجوز توزیع آزمایشی',licensed:'1',original_name:'file.pdf',rights_expires_on:'2099-12-31'},bytes);
 pdf.setStatus(db,owner,digitalId,'pending');pdf.setStatus(db,owner,digitalId,'approved');
 return {db,dir,owner,seller1,seller2,digitalId,cleanup(){db.close();fs.rmSync(dir,{force:true,recursive:true});}};
}
function prepare(x){
 payments.saveProfile(x.db,x.seller1,{provider:'zarinpal',merchant_label:'merchant_01',owner_confirmed:'1',revision:0});
 payments.reviewProfile(x.db,x.owner,{store_id:1,revision:1,status:'approved',note:'مدارک هویت بررسی شده است'});
}
function receipt(x,intentRef,transactionId='receipt-simulated-0001'){return {success:true,intentRef,provider:'zarinpal',merchantLabel:'merchant_01',amountToman:25000,currency:'TOMAN',digitalId:x.digitalId,storeId:1,transactionId};}
test('4.9 profile tenant isolation, review permissions, revision checks, and safe CSV',t=>{
 const x=setup();t.after(x.cleanup);
 assert.equal(payments.profiles(x.db,x.seller1).length,1);
 assert.equal(payments.profiles(x.db,x.seller2)[0].store_id,2);
 assert.equal(payments.profiles(x.db,{role:'seller',store_id:1,staff_permission:'viewer'}).length,0);
 assert.throws(()=>payments.saveProfile(x.db,x.seller1,{store_id:2,provider:'other',merchant_label:'merchant_02',owner_confirmed:'1',revision:0}),/دسترسی|فروشگاه/);
 assert.throws(()=>payments.saveProfile(x.db,x.seller1,{provider:'unknown',merchant_label:'secret',owner_confirmed:'1',revision:0}),/درگاه/);
 assert.throws(()=>payments.reviewProfile(x.db,x.seller1,{store_id:1,revision:0,status:'approved',note:'توضیح معتبر کافی است'}),/YM/);
 prepare(x);
 assert.equal(payments.profiles(x.db,x.seller1)[0].payment_review,'approved');
 assert.throws(()=>payments.saveProfile(x.db,x.seller1,{provider:'other',merchant_label:'merchant_new',owner_confirmed:'1',revision:0}),/تازه/);
 assert.equal(payments.profiles(x.db,x.seller2)[0].payment_review,'unreviewed');
 assert.match(payments.csv([{intent_ref:'x',store_id:2,store_name:'=1+2',digital_id:3,title:'sample',amount_toman:2,currency:'TOMAN',provider:'zarinpal',status:'pending'}]),/"'=1\+2"/);
});
test('4.9 ledger remains unpaid without trusted verifier and verifies exact store, price and gateway merchant',async t=>{
 const x=setup();t.after(x.cleanup);
 assert.throws(()=>payments.createIntent(x.db,{digitalId:x.digitalId,idempotencyKey:'abcdefghijklmnopqrstuvwxyz12345'},1000),/آماده نیست/);
 prepare(x);
 const intent=payments.createIntent(x.db,{digitalId:x.digitalId,idempotencyKey:'abcdefghijklmnopqrstuvwxyz12345'},1000);
 const second=payments.createIntent(x.db,{digitalId:x.digitalId,idempotencyKey:'abcdefghijklmnopqrstuvwxyz12345'},1001);
 assert.equal(second.duplicate,true);assert.equal(second.intentRef,intent.intentRef);
 assert.equal(payments.intents(x.db,x.seller2).length,0);
 assert.equal(payments.intents(x.db,x.seller1).length,1);
 assert.equal(x.db.prepare('SELECT COUNT(*) n FROM digital_entitlements').get().n,0);
 await assert.rejects(payments.verifyIntent(x.db,intent.intentRef,{},null,2000),/استعلام/);
 await assert.rejects(payments.verifyIntent(x.db,intent.intentRef,{},async()=>({...receipt(x,intent.intentRef),amountToman:1}),2000),/مطابقت/);
 await assert.rejects(payments.verifyIntent(x.db,intent.intentRef,{},async()=>({...receipt(x,intent.intentRef),merchantLabel:'other-merchant'}),2000),/مطابقت/);
 await assert.rejects(payments.verifyIntent(x.db,intent.intentRef,{},async()=>({...receipt(x,intent.intentRef),storeId:2}),2000),/مطابقت/);
 assert.equal(payments.intents(x.db,x.owner)[0].status,'pending');
 const confirmed=await payments.verifyIntent(x.db,intent.intentRef,{serverSideQuery:'trusted'},async()=>receipt(x,intent.intentRef),2000);
 assert.equal(confirmed.duplicate,false);assert.match(confirmed.token,/^[A-Za-z0-9_-]{43}$/);
 assert.equal(payments.intents(x.db,x.owner)[0].status,'verified');
 assert.equal(x.db.prepare('SELECT COUNT(*) n FROM digital_entitlements').get().n,1);
 assert.ok(entitlements.claim(x.db,x.dir,confirmed.token,3000));
 const duplicate=await payments.verifyIntent(x.db,intent.intentRef,{},async()=>{throw Error('should not requery');},3000);
 assert.equal(duplicate.duplicate,true);assert.equal(duplicate.token,undefined);
 assert.equal(x.db.prepare('SELECT COUNT(*) n FROM digital_entitlements').get().n,1);
 const next=payments.createIntent(x.db,{digitalId:x.digitalId,idempotencyKey:'abcdefghijklmnopqrstuvwxyz12346'},3500);
 await assert.rejects(payments.verifyIntent(x.db,next.intentRef,{},async()=>receipt(x,next.intentRef),4000),/قبلاً استفاده/);
 assert.equal(payments.intents(x.db,x.owner)[0].status,'pending','replay does not mark intent as paid');
});
test('4.9 expiry, changed prices and suspended rights fail closed before granting PDF',async t=>{
 const x=setup();t.after(x.cleanup);prepare(x);
 let intent=payments.createIntent(x.db,{digitalId:x.digitalId,idempotencyKey:'abcdefghijklmnopqrstuvwxyz99999'},1000);
 await assert.rejects(payments.verifyIntent(x.db,intent.intentRef,{},async()=>receipt(x,intent.intentRef),1000+900000),/مهلت/);
 assert.equal(payments.expire(x.db,1000+900000),1);
 assert.equal(payments.intents(x.db,x.owner)[0].status,'expired');
 intent=payments.createIntent(x.db,{digitalId:x.digitalId,idempotencyKey:'abcdefghijklmnopqrstuvwxyz99998'},2000000);
 x.db.prepare('UPDATE digital_books SET price=26000 WHERE id=?').run(x.digitalId);
 await assert.rejects(payments.verifyIntent(x.db,intent.intentRef,{},async()=>receipt(x,intent.intentRef),2000001),/قیمت/);
 x.db.prepare('UPDATE digital_books SET price=25000 WHERE id=?').run(x.digitalId);
 rights.change(x.db,x.owner,{id:x.digitalId,revision:0,action:'hold',note:'مالک حقوق انتشار را متوقف کرده است'});
 await assert.rejects(payments.verifyIntent(x.db,intent.intentRef,{},async()=>receipt(x,intent.intentRef),2000001),/مجوز/);
 assert.equal(x.db.prepare('SELECT count(*) n FROM digital_entitlements').get().n,0);
});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function freePort(){const s=net.createServer();await new Promise(ok=>s.listen(0,'127.0.0.1',ok));const port=s.address().port;await new Promise(ok=>s.close(ok));return port;}
test('4.9 HTTP public checkout unavailable, admin payment readiness protected by auth and CSRF',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq49-http-')),port=await freePort(),base='http://127.0.0.1:'+port;
 const child=spawn(process.execPath,['server.js'],{cwd:ROOT,env:{...process.env,DATA_DIR:dir,PORT:String(port),HOST:'127.0.0.1',PUBLIC_URL:''},stdio:['ignore','pipe','pipe']});let errors='';child.stderr.on('data',x=>errors+=x);
 t.after(async()=>{if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),delay(2000)]);}fs.rmSync(dir,{force:true,recursive:true});});
 for(let k=0;k<100;k++){try{const r=await fetch(base+'/health');if(r.ok)break;}catch{}if(k===99)throw Error('Startup timeout '+errors);await delay(70);}
 const get=(p,c='')=>fetch(base+p,{headers:{cookie:c},redirect:'manual'});
 const post=(p,data,c='')=>fetch(base+p,{method:'POST',headers:{cookie:c,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(data),redirect:'manual'});
 let r=await get('/health');assert.deepEqual(await r.json(),{ok:true,version:'8.6.0',payment_enabled:false,orders_mode:'demo_only'});
 r=await get('/panel/payment-readiness');assert.equal(r.status,303);
 r=await get('/panel/payment-ledger.csv');assert.equal(r.status,303);
 r=await get('/pdf-books');assert.match(await r.text(),/غیرفعال/);
 r=await post('/payments/verify',{claimed_success:'true'});assert.equal(r.status,404);
 r=await post('/panel/payment-profile',{store_id:'1',provider:'zarinpal'});assert.equal(r.status,303);
 r=await get('/pdf-delivery/'+'a'.repeat(43));assert.equal(r.status,404);
 r=await fetch(base+'/pdf-delivery/'+'a'.repeat(43),{method:'HEAD'});assert.equal(r.status,405);
 r=await post('/login',{username:'admin',password:'ad123456789'});let cookie=r.headers.get('set-cookie').split(';')[0];
 r=await get('/panel/account',cookie);let csrf=(await r.text()).match(/name="csrf" value="([^"]+)"/)[1];
 await post('/panel/account',{csrf,username:'admin',old_password:'ad123456789',new_password:'SecureNewOwnerPassword123',confirm_password:'SecureNewOwnerPassword123'},cookie);
 r=await post('/login',{username:'admin',password:'SecureNewOwnerPassword123'});cookie=r.headers.get('set-cookie').split(';')[0];
 r=await get('/panel/payment-readiness',cookie);assert.equal(r.status,200);let html=await r.text();assert.match(html,/چرخه تراکنش PDF/);csrf=html.match(/name="csrf" value="([^"]+)"/)[1];
 r=await post('/panel/payment-profile',{csrf:'wrong',store_id:'1',revision:'0',provider:'zarinpal',merchant_label:'merchant_01',owner_confirmed:'1'},cookie);assert.equal(r.status,403);
 r=await post('/panel/payment-profile',{csrf,store_id:'1',revision:'0',provider:'zarinpal',merchant_label:'merchant_01',owner_confirmed:'1'},cookie);assert.equal(r.status,303);
 r=await get('/panel/payment-readiness',cookie);html=await r.text();assert.match(html,/merchant_01/);
 r=await get('/panel/payment-ledger.csv',cookie);assert.equal(r.status,200);assert.match(await r.text(),/intent_ref/);
 const check=new DatabaseSync(path.join(dir,'varaq.sqlite'));assert.equal(check.prepare('SELECT COUNT(*) n FROM digital_payment_intents').get().n,0);check.close();
});

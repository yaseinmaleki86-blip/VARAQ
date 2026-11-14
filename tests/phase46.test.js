'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{DatabaseSync}=require('node:sqlite');
const {spawn}=require('node:child_process'),net=require('node:net');
const pdf=require('../lib/pdf-store'),rights=require('../lib/pdf-rights'),delivery=require('../lib/digital-entitlements');
const outreach=require('../lib/publisher-outreach');
const sample=Buffer.from('%PDF-1.4\n1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n2 0 obj\n<</Type/Pages/Count 0/Kids[]>>\nendobj\ntrailer\n<</Root 1 0 R>>\n%%EOF\n');
const info={store_id:1,title:'کتاب حقوق دیجیتال آزمایشی',description:'نمونه تست حق توزیع',price:'27000',rights_holder:'مالک حق',rights_basis:'قرارداد فروش مستقل آزمایشی',rights_evidence:'سند کتبی با شماره آزمایش ۱۴۰۵',licensed:'1',original_name:'unit.pdf',rights_expires_on:'2099-12-31'};
function dbInit(){const db=new DatabaseSync(':memory:');db.exec(`PRAGMA foreign_keys=ON; CREATE TABLE books(id INTEGER PRIMARY KEY,title TEXT,slug TEXT,author TEXT);CREATE TABLE stores(id INTEGER PRIMARY KEY,name TEXT,active INTEGER);CREATE TABLE users(id INTEGER PRIMARY KEY);INSERT INTO books VALUES(1,'کتاب نمونه','test','نویسنده آزمایشی');INSERT INTO stores VALUES(1,'اول',1),(2,'دوم',1);INSERT INTO users VALUES(1),(2);`);pdf.migrate(db);delivery.migrate(db);return db;}
test('4.6 rights migration and owner-only revision checked hold, resume and expiry',t=>{
 const db=dbInit(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq46-'));t.after(()=>{db.close();fs.rmSync(dir,{force:true,recursive:true});});
 rights.migrate(db);const owner={role:'owner',id:1},seller={role:'seller',id:2,store_id:1,staff_permission:'manager'};
 const id=pdf.create(db,dir,owner,info,sample);pdf.setStatus(db,owner,id,'pending');pdf.setStatus(db,owner,id,'approved');
 assert.equal(pdf.publicBook(db,id)?.id,id);
 assert.throws(()=>rights.change(db,seller,{id,revision:0,action:'hold',note:'حقوق انتشار به تعلیق درآمد'}),/مدیر مرکزی/);
 assert.equal(rights.change(db,owner,{id,revision:0,action:'hold',note:'ناشر درخواست توقف توزیع کرد'}),1);
 assert.equal(pdf.publicBook(db,id),null);
 assert.throws(()=>rights.change(db,owner,{id,revision:0,action:'resume',note:'پیشنهاد بازگشایی با تأیید'},'2026-11-02'),/تغییر کرده/);
 assert.equal(rights.change(db,owner,{id,revision:1,action:'resume',note:'اجازه قبلی هنوز معتبر است'},'2026-11-02'),2);
 assert.equal(pdf.publicBook(db,id)?.id,id);
 assert.equal(rights.change(db,owner,{id,revision:2,action:'renew',expires_on:'2026-11-02',evidence:'قرارداد تازه شماره ۲۰۲۶-۰۲',note:'تجدید مجوز طبق نامه مالک'},'2026-11-02'),3);
 assert.equal(rights.report(db,owner,'2026-11-03')[0].rights_state,'expired');
 assert.equal(rights.report(db,seller,'2026-11-03').length,1);
 assert.equal(rights.report(db,{role:'seller',store_id:2,staff_permission:'manager'},'2026-11-03').length,0);
 assert.throws(()=>rights.change(db,owner,{id,revision:3,action:'renew',expires_on:'2026-02-30',evidence:'قرارداد تازه شماره ۲۰۲۶-۰۲',note:'ویرایش سند مجوز'},'2026-11-02'),/معتبر/);
 assert.throws(()=>rights.change(db,owner,{id,revision:3,action:'hold',note:'کوتاه'},'2026-11-02'),/دلیل/);
 assert.match(rights.csv(rights.report(db,owner)),/rights_expires_on/);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM digital_book_events WHERE action LIKE ?').get('rights_%').n,3);
});
test('4.6 existing download grants revoke immediately after rights suspension',async t=>{
 const db=dbInit(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq46-'));t.after(()=>{db.close();fs.rmSync(dir,{force:true,recursive:true});});
 const owner={role:'owner',id:1},id=pdf.create(db,dir,owner,info,sample);pdf.setStatus(db,owner,id,'pending');pdf.setStatus(db,owner,id,'approved');
 const receipt={success:true,digitalId:id,storeId:1,amountToman:27000,currency:'TOMAN',provider:'mock-gateway',transactionId:'mock-verified-ref-44'};
 const token=(await delivery.issueAfterGatewayVerification(db,{digitalId:id,paymentRequest:{nonce:1}},async()=>receipt,1000)).token;
 assert.ok(delivery.claim(db,dir,token,2000));
 rights.change(db,owner,{id,revision:0,action:'hold',note:'فسخ مجوز توزیع آزمایشی'});
 assert.equal(delivery.claim(db,dir,token,2000),null,'historical entitlement must not override a rights hold');
 await assert.rejects(delivery.issueAfterGatewayVerification(db,{digitalId:id,paymentRequest:{}},async()=>receipt,3000),/not sellable/);
 assert.equal(pdf.publicRows(db).length,0);
});
function delay(ms){return new Promise(r=>setTimeout(r,ms));}
async function port(){const s=net.createServer();await new Promise(ok=>s.listen(0,'127.0.0.1',ok));const value=s.address().port;await new Promise(ok=>s.close(ok));return value;}
test('4.6 publisher outreach, rights CSV isolation and CSRF secured route',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq46-http-')),PORT=await port(),base=`http://127.0.0.1:${PORT}`;
 const child=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,VARAQ_CURATED_SEED:'1',PUBLIC_URL:'',DATA_DIR:dir,PORT:String(PORT),HOST:'127.0.0.1'},stdio:['ignore','pipe','pipe']});let errors='';child.stderr.on('data',x=>errors+=x);
 t.after(async()=>{if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(ok=>child.once('exit',ok)),delay(1000)]);}fs.rmSync(dir,{recursive:true,force:true});});
 for(let k=0;k<120;k++){try{const r=await fetch(base+'/health');if(r.ok)break;}catch{}await delay(50);if(k===119)throw Error('Server failed '+errors);}
 const db=new DatabaseSync(path.join(dir,'varaq.sqlite'));
 const items=outreach.rows(db);const groups=outreach.groups(items);assert.ok(items.length>0);assert.ok(groups.length>0);assert.ok(items.every(x=>x.isbn));assert.match(outreach.csv(items),/publisher_contact/);db.close();
 let r=await fetch(base+'/panel/publisher-outreach',{redirect:'manual'});assert.equal(r.status,303);
 r=await fetch(base+'/login',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:'admin',password:'ad123456789'}),redirect:'manual'});
 let cookie=r.headers.get('set-cookie').split(';')[0];
 r=await fetch(base+'/panel/account',{headers:{cookie}});
 const csrf=(await r.text()).match(/name="csrf" value="([^"]+)"/)[1];
 r=await fetch(base+'/panel/account',{method:'POST',redirect:'manual',headers:{cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,username:'admin',old_password:'ad123456789',new_password:'StrongVaraqPassword456!',confirm_password:'StrongVaraqPassword456!'})});assert.equal(r.status,303);
 r=await fetch(base+'/login',{method:'POST',redirect:'manual',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:'admin',password:'StrongVaraqPassword456!'})});cookie=r.headers.get('set-cookie').split(';')[0];
 r=await fetch(base+'/panel/publisher-outreach',{headers:{cookie}});assert.equal(r.status,200);assert.match(await r.text(),/بسته آماده مکاتبات ناشران/);
 r=await fetch(base+'/panel/publisher-outreach.csv',{headers:{cookie}});assert.equal(r.status,200);assert.match(await r.text(),/publisher_contact/);
 r=await fetch(base+'/panel/pdf-rights.csv',{headers:{cookie}});assert.equal(r.status,200);assert.match(await r.text(),/digital_id/);
 r=await fetch(base+'/panel/pdf-rights-update',{method:'POST',headers:{cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({id:1,revision:0,action:'hold',note:'توقف برای تست'})});assert.equal(r.status,403);
 r=await fetch(base+'/health');assert.equal((await r.json()).payment_enabled,false);
});

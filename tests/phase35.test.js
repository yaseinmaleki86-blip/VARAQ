'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');const {spawn}=require('node:child_process');
const rights=require('../lib/cover-rights');
async function boot(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq35-'));
 const sock=net.createServer();await new Promise(r=>sock.listen(0,'127.0.0.1',r));const port=sock.address().port;await new Promise(r=>sock.close(r));
 const child=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,VARAQ_CURATED_SEED:'1',DATA_DIR:dir,HOST:'127.0.0.1',PORT:String(port),PUBLIC_URL:''},stdio:['ignore','pipe','pipe']});
 let log='';await new Promise((ok,fail)=>{const timer=setTimeout(()=>fail(Error(log||'server timeout')),16000);child.stdout.on('data',d=>{log+=d;if(log.includes('PAYMENT: DISABLED')){clearTimeout(timer);ok();}});child.stderr.on('data',d=>log+=d);child.on('exit',x=>{clearTimeout(timer);fail(Error('server exited '+x+' '+log));});});
 const db=new DatabaseSync(path.join(dir,'varaq.sqlite'));t.after(async()=>{db.close();child.kill('SIGTERM');await new Promise(r=>child.exitCode!==null||child.signalCode?r():child.once('exit',r));fs.rmSync(dir,{recursive:true,force:true});});return {db,base:'http://127.0.0.1:'+port};
}
const get=(s,p,c)=>fetch(s.base+p,{headers:c?{cookie:c}:{},redirect:'manual'});
const post=(s,p,c,f)=>fetch(s.base+p,{method:'POST',redirect:'manual',headers:{cookie:c||'','content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(f)});
function csrf(s){return s.match(/name="csrf" value="([^"]+)"/)?.[1];}
async function owner(s){let r=await post(s,'/login','',{username:'admin',password:'ad123456789'});let cookie=r.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie);let h=await(await get(s,'/panel/account',cookie)).text();assert.equal((await post(s,'/panel/account',cookie,{csrf:csrf(h),username:'admin',old_password:'ad123456789',new_password:'StrongerVaraq35Password!',confirm_password:'StrongerVaraq35Password!'})).status,303);r=await post(s,'/login','',{username:'admin',password:'StrongerVaraq35Password!'});cookie=r.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie);return cookie;}
function form(id,extra={}){return {edition_id:id,status:'requested',contact_name:'مکاتبه رسمی',contact_date:'2026-10-20',next_followup_date:'2026-10-30',notes:'پیگیری',...extra};}
test('3.5: old rights table schema upgrades in place, preserves older records; no synthetic events',()=>{
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE editions(id INTEGER PRIMARY KEY,verified INTEGER,isbn TEXT);CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT);INSERT INTO editions VALUES(1,1,'1234567890123');INSERT INTO users(id,username) VALUES(1,'owner');
 CREATE TABLE edition_rights_requests(edition_id INTEGER PRIMARY KEY REFERENCES editions(id) ON DELETE CASCADE,
 status TEXT NOT NULL DEFAULT 'not_requested' CHECK(status IN ('not_requested','requested','granted','denied')),
 contact_name TEXT NOT NULL DEFAULT '',contact_date TEXT NOT NULL DEFAULT '',evidence_ref TEXT NOT NULL DEFAULT '',notes TEXT NOT NULL DEFAULT '',
 updated_by INTEGER REFERENCES users(id),updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
 INSERT INTO edition_rights_requests(edition_id,status,contact_name,contact_date) VALUES(1,'requested','فروشنده','2026-10-21');`);
 rights.migrate(db);rights.migrate(db);
 const old=db.prepare('SELECT * FROM edition_rights_requests WHERE edition_id=1').get();assert.equal(old.contact_name,'فروشنده');assert.equal(old.revision,0);assert.equal(old.next_followup_date,'');assert.equal(db.prepare('SELECT count(*) n FROM edition_rights_request_events').get().n,0);
 rights.save(db,form(1,{contact_name:'فروشنده',contact_date:'2026-10-21',revision:0}),1);
 assert.equal(db.prepare('SELECT revision FROM edition_rights_requests WHERE edition_id=1').get().revision,1);
 assert.equal(rights.history(db,1).length,1);db.close();
});
test('3.5: deadlines, immutability, stale edit, validation, transition, CSV injection defenses',async t=>{
 const s=await boot(t), id=s.db.prepare('SELECT id FROM editions WHERE verified=1 LIMIT 1').get().id;
 assert.equal(rights.validDate('2026-02-29'),false);assert.equal(rights.validDate('2024-02-29'),true);assert.equal(rights.validDate('2026-04-31'),false);
 assert.throws(()=>rights.save(s.db,form(id,{contact_date:'2026-02-29'}),1),/تاریخ مکاتبه/);
 assert.throws(()=>rights.save(s.db,form(id,{next_followup_date:'2026-10-19'}),1),/زودتر/);
 assert.throws(()=>rights.save(s.db,form(id,{status:'granted'}),1),/مرجع/);
 assert.throws(()=>rights.save(s.db,form(id,{status:'denied'}),1),/موعد پیگیری فقط/);
 rights.save(s.db,form(id,{notes:'=IMPORTXML("abc")'}),1);
 assert.equal(rights.history(s.db,id).length,1);
 assert.equal(rights.followupState({request_status:'requested',next_followup_date:'2026-10-30'},'2026-11-02'),'overdue');
 assert.equal(rights.followupState({request_status:'requested',next_followup_date:'2026-11-02'},'2026-11-02'),'today');
 assert.equal(rights.followupState({request_status:'requested',next_followup_date:'2026-11-09'},'2026-11-02'),'next7');
 assert.equal(rights.followupState({request_status:'requested',next_followup_date:'2026-11-10'},'2026-11-02'),'later');
 assert.equal(rights.stats(rights.rows(s.db),'2026-11-02').overdue,1);
 rights.save(s.db,form(id,{notes:'=IMPORTXML("abc")'}),1);
 assert.equal(rights.history(s.db,id).length,1,'same fields must not add history');
 assert.throws(()=>rights.save(s.db,form(id,{revision:0}),1),/تغییر کرده/);
 assert.match(rights.csv(s.db),/"'=IMPORTXML/);
 rights.save(s.db,form(id,{status:'granted',next_followup_date:'',evidence_ref:'نامه 123456',revision:1}),1);
 assert.equal(rights.history(s.db,id).length,2);assert.equal(rights.stats(rights.rows(s.db),'2026-11-02').overdue,0);
 assert.equal(s.db.prepare('SELECT COUNT(*) n FROM edition_cover_assets').get().n,0);
 assert.equal(s.db.prepare('SELECT COUNT(*) n FROM edition_sources WHERE rights_confirmed=1').get().n,0);
 assert.equal(s.db.prepare('SELECT count(*) n FROM edition_rights_request_events').get().n,2);
});
test('3.5: end-to-end owner-only filters, CSRF, CSV and revision conflict; sellers denied',async t=>{
 const s=await boot(t),cookie=await owner(s);
 let r=await get(s,'/panel/rights-tracker?followup=overdue',cookie);assert.equal(r.status,200);let h=await r.text();assert.match(h,/موارد عقب‌افتاده/);
 const id=s.db.prepare('SELECT id FROM editions WHERE verified=1 LIMIT 1').get().id;
 r=await get(s,'/panel/rights-tracker?edition='+id,cookie);h=await r.text();assert.match(h,/تاریخچه ثبت‌شده|هنوز سابقه‌ای/);const token=csrf(h);assert.ok(token);assert.match(h,/name="revision" value="0"/);
 assert.equal((await post(s,'/panel/rights-tracker',cookie,{...form(id),csrf:'bad',revision:0})).status,403);
 assert.equal((await post(s,'/panel/rights-tracker',cookie,{...form(id),csrf:token,revision:0})).status,303);
 assert.equal((await post(s,'/panel/rights-tracker',cookie,{...form(id,{notes:'نسخه قدیمی'}),csrf:token,revision:0})).status,400);
 const due=await(await get(s,'/panel/rights-tracker?followup=overdue',cookie)).text();assert.match(due,/ملت عشق/);assert.match(due,/پیگیری عقب‌افتاده/);
 const history=await(await get(s,'/panel/rights-tracker?edition='+id,cookie)).text();assert.match(history,/نام="fake"|تاریخچه ثبت‌شده/);assert.match(history,/name="revision" value="1"/);
 r=await get(s,'/panel/rights-tracker.csv',cookie);assert.equal(r.status,200);assert.match(await r.text(),/next_followup_date,|"next_followup_date"/);
 assert.equal((await get(s,'/panel/rights-tracker.csv')).status,303);
 // Create a store-scoped seller with the same server-compatible scrypt password representation.
 const salt='f'.repeat(32),password='Seller35Password!',hash=salt+':'+crypto.scryptSync(password,salt,64).toString('hex');
 const storeId=s.db.prepare('SELECT id FROM stores LIMIT 1').get().id;
 s.db.prepare("INSERT INTO users(username,password_hash,role,store_id,must_change_password,enabled,staff_permission) VALUES(?,?, 'seller',?,0,1,'manager')").run('seller35',hash,storeId);
 r=await post(s,'/login','',{username:'seller35',password});const sellerCookie=r.headers.get('set-cookie')?.split(';')[0];assert.ok(sellerCookie);
 assert.equal((await get(s,'/panel/rights-tracker',sellerCookie)).status,403);
 assert.equal((await get(s,'/panel/rights-tracker.csv',sellerCookie)).status,403);
 const sellerHtml=await (await get(s,'/panel',sellerCookie)).text();
 assert.equal((await post(s,'/panel/rights-tracker',sellerCookie,{...form(id),csrf:csrf(sellerHtml)})).status,403);
});

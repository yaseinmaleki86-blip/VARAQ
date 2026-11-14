'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {DatabaseSync}=require('node:sqlite');const {spawn}=require('node:child_process');
const rights=require('../lib/cover-rights');
async function boot(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq34-'));
 const sock=net.createServer();await new Promise(r=>sock.listen(0,'127.0.0.1',r));const port=sock.address().port;await new Promise(r=>sock.close(r));
 const child=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,VARAQ_CURATED_SEED:'1',DATA_DIR:dir,HOST:'127.0.0.1',PORT:String(port),PUBLIC_URL:''},stdio:['ignore','pipe','pipe']});
 let log='';await new Promise((ok,fail)=>{let timer=setTimeout(()=>fail(Error(log||'server timeout')),15000);child.stdout.on('data',d=>{log+=d;if(log.includes('PAYMENT: DISABLED')){clearTimeout(timer);ok();}});child.stderr.on('data',d=>log+=d);child.on('exit',x=>{clearTimeout(timer);fail(Error('server exited '+x+' '+log));});});
 const db=new DatabaseSync(path.join(dir,'varaq.sqlite'));t.after(async()=>{db.close();child.kill('SIGTERM');await new Promise(r=>child.exitCode!==null||child.signalCode?r():child.once('exit',r));fs.rmSync(dir,{recursive:true,force:true});});return {db,base:'http://127.0.0.1:'+port};
}
const get=(s,p,c)=>fetch(s.base+p,{headers:c?{cookie:c}:{},redirect:'manual'});
const post=(s,p,c,f)=>fetch(s.base+p,{method:'POST',redirect:'manual',headers:{cookie:c||'','content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(f)});
function csrf(s){return s.match(/name="csrf" value="([^"]+)"/)?.[1];}
async function owner(s){let r=await post(s,'/login','',{username:'admin',password:'ad123456789'});let cookie=r.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie);let h=await (await get(s,'/panel/account',cookie)).text();assert.equal((await post(s,'/panel/account',cookie,{csrf:csrf(h),username:'admin',old_password:'ad123456789',new_password:'StrongerVaraq34Password!',confirm_password:'StrongerVaraq34Password!'})).status,303);r=await post(s,'/login','',{username:'admin',password:'StrongerVaraq34Password!'});cookie=r.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie);return cookie;}
test('3.4: 200 original books retained; 128 source-linked editions across 71 works; payments off',async t=>{
 const s=await boot(t);const a=s.db.prepare('SELECT COUNT(*) n FROM books').get().n,b=s.db.prepare('SELECT COUNT(*) n FROM edition_sources').get().n,c=s.db.prepare('SELECT COUNT(DISTINCT book_id) n FROM editions WHERE verified=1').get().n;
 assert.deepEqual([a,b,c],[200,128,71]);assert.equal(s.db.prepare("SELECT COUNT(*) n FROM edition_rights_requests").get().n,0);
 const h=await (await get(s,'/health')).json();assert.equal(h.version,'8.6.0');assert.equal(h.payment_enabled,false);
});
test('3.4: permission request tracker cannot make covers public and requires evidence for reported grant',async t=>{
 const s=await boot(t);const r=rights.rows(s.db);assert.equal(r.length,128);assert.equal(rights.stats(r).public_covers,0);
 const id=r[0].edition_id;
 assert.throws(()=>rights.save(s.db,{edition_id:id,status:'granted',contact_name:'ناشر تست',contact_date:'2026-11-02'},1),/مرجع/);
 rights.save(s.db,{edition_id:id,status:'requested',contact_name:'ناشر تست',contact_date:'2026-11-02',notes:'درخواست از مسیر رسمی'},1);
 rights.save(s.db,{edition_id:id,status:'granted',contact_name:'ناشر تست',contact_date:'2026-11-02',evidence_ref:'نامه شماره فرضی 2026-A'},1);
 assert.equal(s.db.prepare('SELECT status FROM edition_rights_requests WHERE edition_id=?').get(id).status,'granted');
 assert.equal(s.db.prepare('SELECT COUNT(*) n FROM edition_cover_assets').get().n,0);
 assert.equal(s.db.prepare('SELECT COUNT(*) n FROM edition_sources WHERE rights_confirmed=1').get().n,0);
 assert.match(rights.csv(s.db),/granted/);
});
test('3.4: rights panel and CSV require authentication and CSRF; owner may update',async t=>{
 const s=await boot(t);assert.equal((await get(s,'/panel/rights-tracker')).status,303);assert.equal((await get(s,'/panel/rights-tracker.csv')).status,303);
 const cookie=await owner(s);let r=await get(s,'/panel/rights-tracker',cookie);assert.equal(r.status,200);let h=await r.text();assert.match(h,/پیگیری اجازه تصاویر ناشران/);const token=csrf(h);assert.ok(token);
 assert.equal((await get(s,'/panel/rights-tracker.csv',cookie)).status,200);
 const id=s.db.prepare('SELECT id FROM editions WHERE verified=1 LIMIT 1').get().id;
 assert.equal((await post(s,'/panel/rights-tracker',cookie,{csrf:'bad',edition_id:id,status:'requested'})).status,403);
 assert.equal((await post(s,'/panel/rights-tracker',cookie,{csrf:token,edition_id:id,status:'requested',contact_name:'ناشر',contact_date:'2026-11-02'})).status,303);
 assert.equal(s.db.prepare('SELECT status FROM edition_rights_requests WHERE edition_id=?').get(id).status,'requested');
});

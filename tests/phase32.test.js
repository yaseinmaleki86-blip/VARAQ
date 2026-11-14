'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process');const {DatabaseSync}=require('node:sqlite');
const qa=require('../lib/editorial-qa');
function token(html){return html.match(/name="csrf" value="([^"]+)"/)?.[1];}
async function site(t){
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'varaq-v32-'));
 const sock=net.createServer();await new Promise(r=>sock.listen(0,'127.0.0.1',r));const port=sock.address().port;await new Promise(r=>sock.close(r));
 let log='';const child=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,DATA_DIR:folder,HOST:'127.0.0.1',PORT:String(port),PUBLIC_URL:''},stdio:['ignore','pipe','pipe']});
 await new Promise((resolve,reject)=>{const tm=setTimeout(()=>reject(Error('timeout '+log)),18000);const received=x=>{log+=x.toString();if(log.includes('PAYMENT: DISABLED')){clearTimeout(tm);resolve();}};child.stdout.on('data',received);child.stderr.on('data',received);child.once('exit',c=>{clearTimeout(tm);reject(Error('exit '+c+' '+log));});});
 const db=new DatabaseSync(path.join(folder,'varaq.sqlite'));
 t.after(async()=>{db.close();child.kill('SIGINT');await new Promise(r=>{if(child.exitCode!==null||child.signalCode)r();else child.once('exit',r);});fs.rmSync(folder,{recursive:true,force:true});});
 return {db,url:`http://127.0.0.1:${port}`};
}
async function req(s,p,cookie='',form){return fetch(s.url+p,{method:form?'POST':'GET',headers:form?{cookie,'content-type':'application/x-www-form-urlencoded'}:{cookie},body:form?new URLSearchParams(form):undefined,redirect:'manual'});}
async function owner(s){let r=await req(s,'/login','',{username:'admin',password:'ad123456789'});let c=r.headers.get('set-cookie')?.split(';')[0];assert.ok(c);let h=await (await req(s,'/panel/account',c)).text();
 assert.equal((await req(s,'/panel/account',c,{csrf:token(h),username:'admin',old_password:'ad123456789',new_password:'StrongerVaraq32Password!',confirm_password:'StrongerVaraq32Password!'})).status,303);
 r=await req(s,'/login','',{username:'admin',password:'StrongerVaraq32Password!'});c=r.headers.get('set-cookie')?.split(';')[0];h=await (await req(s,'/panel/editorial-qa',c)).text();return {cookie:c,csrf:token(h)};}
test('3.2: review panel is owner-only, CSV safely exports draft status, and payments remain off',async t=>{
 const s=await site(t),a=await owner(s);
 assert.equal((await req(s,'/panel/editorial-qa',a.cookie)).status,200);
 assert.equal((await req(s,'/panel/editorial-qa.csv',a.cookie)).status,200);
 assert.equal((await req(s,'/panel/editorial-qa')).status,303);
 assert.equal((await req(s,'/panel/editorial-qa.csv')).status,303);
 assert.equal((await req(s,'/panel/editorial-qa',a.cookie,{csrf:'invalid',draft_id:'1'})).status,403);
 // Seller staff must not inspect or edit central editorial evidence.
 assert.equal((await req(s,'/panel/user',a.cookie,{csrf:a.csrf,username:'sellerqa32',password:'SellerPasswordForQA32!',store_id:'1'})).status,303);
 const l=await req(s,'/login','',{username:'sellerqa32',password:'SellerPasswordForQA32!'});const seller=l.headers.get('set-cookie')?.split(';')[0];
 assert.equal((await req(s,'/panel/editorial-qa',seller)).status,403);
 assert.equal((await req(s,'/panel/editorial-qa.csv',seller)).status,403);
 const sp=await (await req(s,'/panel',seller)).text();assert.equal((await req(s,'/panel/editorial-qa',seller,{csrf:token(sp),draft_id:'1'})).status,403);
 assert.deepEqual((await (await req(s,'/health')).json()).payment_enabled,false);
});
test('3.2: staged draft needs verified evidence before new review-publish workflow',async t=>{
 const s=await site(t),a=await owner(s);
 assert.equal((await req(s,'/panel/editorial-batch-31',a.cookie,{csrf:a.csrf,confirm:'1'})).status,303);
 const d=s.db.prepare("SELECT id,book_id FROM catalog_metadata_drafts WHERE status='pending' ORDER BY id LIMIT 1").get();assert.ok(d);
 assert.equal((await req(s,'/panel/editorial-qa-publish',a.cookie,{csrf:a.csrf,draft_id:String(d.id)})).status,409);
 assert.equal((await req(s,'/panel/editorial-qa',a.cookie,{csrf:a.csrf,draft_id:String(d.id),author_checked:'1',synopsis_checked:'1',review_note:'کوتاه'})).status,400);
 assert.equal((await req(s,'/panel/editorial-qa',a.cookie,{csrf:a.csrf,draft_id:String(d.id),author_checked:'1',synopsis_checked:'1',source_url:'http://unsafe.example'})).status,400);
 assert.equal((await req(s,'/panel/editorial-qa',a.cookie,{csrf:a.csrf,draft_id:String(d.id),author_checked:'1',synopsis_checked:'1',review_note:'تأیید اطلاعات اثر از روی نسخه کتاب و بررسی انسانی ثبت شد.'})).status,303);
 assert.equal(qa.status(s.db,d.id).valid,true);
 assert.equal((await req(s,'/panel/editorial-qa-publish',a.cookie,{csrf:a.csrf,draft_id:String(d.id)})).status,303);
 assert.equal(s.db.prepare('SELECT status FROM catalog_metadata_drafts WHERE id=?').get(d.id).status,'approved');
});
test('3.2: draft revision invalidates earlier QA check and existing data is not overwritten',async t=>{
 const s=await site(t),a=await owner(s);
 assert.equal((await req(s,'/panel/editorial-batch-31',a.cookie,{csrf:a.csrf,confirm:'1'})).status,303);
 const d=s.db.prepare("SELECT id,book_id,author,description,source_note FROM catalog_metadata_drafts WHERE status='pending' ORDER BY id LIMIT 1").get();assert.ok(d);
 const original=s.db.prepare('SELECT author,description FROM books WHERE id=?').get(d.book_id);
 const input={csrf:a.csrf,draft_id:String(d.id),author_checked:'1',synopsis_checked:'1',review_note:'کتاب و متن از شناسنامه نسخه موجود مطابقت داده شده‌اند.'};
 assert.equal((await req(s,'/panel/editorial-qa',a.cookie,input)).status,303);
 s.db.prepare('UPDATE catalog_metadata_drafts SET description=description||? WHERE id=?').run(' بررسی مجدد.',d.id);
 assert.equal(qa.status(s.db,d.id).valid,false);
 assert.equal((await req(s,'/panel/editorial-qa-publish',a.cookie,{csrf:a.csrf,draft_id:String(d.id)})).status,409);
 assert.deepEqual(s.db.prepare('SELECT author,description FROM books WHERE id=?').get(d.book_id),original);
 const csv=qa.csv(qa.counts(s.db).rows);assert.ok(csv.includes('review_current'));
});

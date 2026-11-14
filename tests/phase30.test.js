'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process');const {DatabaseSync}=require('node:sqlite');
const editorial=require('../lib/editorial-batch'),coverBatch=require('../lib/cover-batch');
const ROOT=path.join(__dirname,'..');
const waitPort=()=>new Promise((resolve,reject)=>{const srv=net.createServer();srv.once('error',reject);srv.listen(0,'127.0.0.1',()=>{const port=srv.address().port;srv.close(()=>resolve(port));});});
async function setup(t){const folder=fs.mkdtempSync(path.join(os.tmpdir(),'varaq-v30-')),port=await waitPort();let log='';const proc=spawn(process.execPath,['server.js'],{cwd:ROOT,env:{...process.env,DATA_DIR:folder,PORT:String(port),HOST:'127.0.0.1',PUBLIC_URL:''},stdio:['ignore','pipe','pipe']});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('server timeout '+log)),15000);const read=x=>{log+=x.toString();if(log.includes('PAYMENT: DISABLED')){clearTimeout(timer);resolve();}};proc.stdout.on('data',read);proc.stderr.on('data',read);proc.once('exit',c=>reject(Error('server exited '+c+log)));});
 const db=new DatabaseSync(path.join(folder,'varaq.sqlite'));t.after(async()=>{db.close();proc.kill('SIGINT');await new Promise(resolve=>{if(proc.exitCode!==null||proc.signalCode)resolve();else proc.once('exit',resolve);});fs.rmSync(folder,{recursive:true,force:true});});return {db,folder,url:`http://127.0.0.1:${port}`};}
function post(s,p,params,cookie=''){return fetch(s.url+p,{method:'POST',headers:{cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(params),redirect:'manual'});}
function get(s,p,cookie=''){return fetch(s.url+p,{headers:{cookie},redirect:'manual'});}
function token(text){return text.match(/name="csrf" value="([^"]+)"/)?.[1];}
async function owner(s){let r=await post(s,'/login',{username:'admin',password:'ad123456789'});let c=r.headers.get('set-cookie').split(';')[0];let h=await (await get(s,'/panel/account',c)).text();assert.equal((await post(s,'/panel/account',{csrf:token(h),username:'admin',old_password:'ad123456789',new_password:'StrongPasswordForVaraq30!',confirm_password:'StrongPasswordForVaraq30!'},c)).status,303);r=await post(s,'/login',{username:'admin',password:'StrongPasswordForVaraq30!'});c=r.headers.get('set-cookie').split(';')[0];h=await (await get(s,'/panel/editorial-batch',c)).text();return {cookie:c,csrf:token(h)};}
test('v3.0: 66 authored descriptions are staged for review, never auto-published, and idempotent',async t=>{
 const s=await setup(t);const admin=await owner(s);let r=await get(s,'/panel/editorial-batch',admin.cookie);assert.equal(r.status,200);assert.match(await r.text(),/۶۶ معرفی/);
 const before=editorial.preview(s.db);assert.equal(before.total,66);assert.ok(before.ready>40);
 assert.equal((await post(s,'/panel/editorial-batch',{csrf:'bogus',confirm:'1'},admin.cookie)).status,403);
 assert.equal((await post(s,'/panel/editorial-batch',{csrf:admin.csrf},admin.cookie)).status,400);
 assert.equal((await post(s,'/panel/editorial-batch',{csrf:admin.csrf,confirm:'1'},admin.cookie)).status,303);
 assert.equal(s.db.prepare("SELECT COUNT(*) n FROM catalog_metadata_drafts WHERE status='pending'").get().n,before.ready);
 const rec=s.db.prepare('SELECT id,book_id,author,description FROM catalog_metadata_drafts WHERE book_id=14').get();assert.ok(rec);assert.match(rec.description,/سرگذشت|نقشه/);
 const b=s.db.prepare('SELECT description FROM books WHERE id=14').get();assert.equal(b.description,'');
 const publicBook=await (await get(s,'/book/book-014')).text();assert.doesNotMatch(publicBook,/مردی که پس از خیانتی بزرگ/);
 assert.equal((await post(s,'/panel/editorial-batch',{csrf:admin.csrf,confirm:'1'},admin.cookie)).status,303);
 assert.equal(s.db.prepare('SELECT COUNT(*) n FROM catalog_metadata_drafts').get().n,before.ready);
 const qacheck=await post(s,'/panel/editorial-qa',{csrf:admin.csrf,draft_id:String(rec.id),author_checked:'1',synopsis_checked:'1',review_note:'معرفی و نام نویسنده این نسخه با منبع کتابشناختی بررسی و ثبت گردید.'},admin.cookie);assert.equal(qacheck.status,303);
 const approval=await post(s,'/panel/catalog-moderate',{csrf:admin.csrf,draft_id:String(rec.id),action:'approve'},admin.cookie);
 assert.equal(approval.status,303);assert.match(s.db.prepare('SELECT description FROM books WHERE id=14').get().description,/مردی که پس از خیانتی بزرگ/);
 assert.equal((await (await get(s,'/health')).json()).payment_enabled,false);
});
test('v3.0: seller cannot stage or access editorial content',async t=>{
 const s=await setup(t),a=await owner(s);
 assert.equal((await post(s,'/panel/user',{csrf:a.csrf,username:'seller30',password:'SellerPasswordFor30!',store_id:'1'},a.cookie)).status,303);
 const r=await post(s,'/login',{username:'seller30',password:'SellerPasswordFor30!'});const c=r.headers.get('set-cookie').split(';')[0];
 assert.equal((await get(s,'/panel/editorial-batch',c)).status,403);
 const p=await get(s,'/panel',c),csrf=token(await p.text());assert.equal((await post(s,'/panel/editorial-batch',{csrf,confirm:'1'},c)).status,403);
 assert.equal(s.db.prepare('SELECT COUNT(*) n FROM catalog_metadata_drafts').get().n,0);
});
test('v3.0: real cover batch requires valid ISBN, local image, evidence, and dry-run does not modify data',async t=>{
 const s=await setup(t),db=s.db;
 const book=db.prepare('SELECT id FROM books WHERE id=3').get().id;
 const isbn='9789646404465'; // belongs to another book in data if seeded, choose existing or inserted after lookup
 const unique='9780131103627';
 const current=db.prepare('SELECT id FROM editions WHERE isbn=?').get(unique);
 assert.equal(current,undefined);
 db.prepare("INSERT INTO editions(book_id,label,translator,publisher,isbn,verified) VALUES(?,'چاپ تست','','آزمایشگاه',?,1)").run(book,unique);
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'cover-v30-'));t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
 fs.copyFileSync(path.join(__dirname,'fixtures','validation-only-cover.png'),path.join(folder,'cover.png'));
 const header='isbn,filename,source,rights_note,match_evidence,permission_evidence';
 const line=`${unique},cover.png,فایل عکاس,استفاده با اجازه کتبی صاحب تصویر,بارکد و شابک روی نسخه فیزیکی,رضایت کتبی عکاس برای انتشار تجاری`;
 const rows=coverBatch.parseManifest(header+'\n'+line+'\n');
 assert.equal(coverBatch.processRows(db,rows,folder,path.join(s.folder,'covers')).ready,1);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM edition_cover_assets').get().n,0);
 assert.throws(()=>coverBatch.parseManifest(header+'\n'+line+'\n'+line),/Duplicate/);
 assert.throws(()=>coverBatch.parseManifest(header+'\n'+line.replace('cover.png','../private.png')),/Unsafe filename/);
 assert.throws(()=>coverBatch.parseManifest(header+'\n'+line.replace('رضایت کتبی عکاس برای انتشار تجاری','')),/Evidence/);
 const result=coverBatch.processRows(db,rows,folder,path.join(s.folder,'covers'),true);
 assert.equal(result.saved,1);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM edition_cover_assets').get().n,1);
 assert.match(db.prepare('SELECT permission_evidence FROM edition_cover_import_evidence').get().permission_evidence,/رضایت کتبی/);
 assert.throws(()=>coverBatch.processRows(db,rows,folder,path.join(s.folder,'covers'),true),/already exists/);
});

'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process');const {DatabaseSync}=require('node:sqlite');
const batch30=require('../lib/editorial-batch'),batch31=require('../lib/editorial-batch-v31');
const allBooks=require('../data/books.json');
function token(html){return html.match(/name="csrf" value="([^"]+)"/)?.[1];}
async function spawnSite(t){
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'varaq-v31-'));
 const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 let log='';const process=spawn(processExec(),['server.js'],{cwd:path.join(__dirname,'..'),env:{...global.process.env,DATA_DIR:folder,HOST:'127.0.0.1',PORT:String(port),PUBLIC_URL:''},stdio:['ignore','pipe','pipe']});
 await new Promise((resolve,reject)=>{const tm=setTimeout(()=>reject(Error('server timeout '+log)),20000);const received=x=>{log+=x.toString();if(log.includes('PAYMENT: DISABLED')){clearTimeout(tm);resolve();}};process.stdout.on('data',received);process.stderr.on('data',received);process.once('exit',c=>{clearTimeout(tm);reject(Error('server exited '+c+' '+log));});});
 const db=new DatabaseSync(path.join(folder,'varaq.sqlite'));t.after(async()=>{db.close();process.kill('SIGINT');await new Promise(r=>{if(process.exitCode!==null||process.signalCode)r();else process.once('exit',r);});fs.rmSync(folder,{recursive:true,force:true});});
 return {db,url:`http://127.0.0.1:${port}`};
}
function processExec(){return global.process.execPath;}
async function req(s,p,cookie='',form){return fetch(s.url+p,{method:form?'POST':'GET',headers:form?{cookie,'content-type':'application/x-www-form-urlencoded'}:{cookie},body:form?new URLSearchParams(form):undefined,redirect:'manual'});}
async function owner(s){let r=await req(s,'/login','',{username:'admin',password:'ad123456789'});let c=r.headers.get('set-cookie')?.split(';')[0];assert.ok(c);let h=await (await req(s,'/panel/account',c)).text();assert.equal((await req(s,'/panel/account',c,{csrf:token(h),username:'admin',old_password:'ad123456789',new_password:'StrongSecretForVaraq31!',confirm_password:'StrongSecretForVaraq31!'})).status,303);
 r=await req(s,'/login','',{username:'admin',password:'StrongSecretForVaraq31!'});c=r.headers.get('set-cookie')?.split(';')[0];h=await (await req(s,'/panel/editorial-batch-31',c)).text();return {cookie:c,csrf:token(h)};}
test('3.1: exactly 134 new original drafts complement 66 previous drafts and 200 existing titles',()=>{
 assert.equal(batch30.entries.length,66);assert.equal(batch31.entries.length,134);assert.equal(allBooks.length,1000);
 const all=[...batch30.entries,...batch31.entries];assert.equal(new Set(all.map(x=>x.book_id)).size,200);
 for(const x of batch31.entries){const b=allBooks.find(b=>b.id===x.book_id);assert.ok(b);assert.ok(x.description.length>=75);assert.equal(x.source_url,'');assert.ok(x.source_note.includes('بررسی')||x.source_note.includes('نیازمند'));
 assert.ok(!/\bhttps?:\/\//.test(x.description));}
});
test('3.1: owner may stage missing descriptions but nothing is published and no existing fields replaced',async t=>{
 const s=await spawnSite(t),a=await owner(s);
 let r=await req(s,'/panel/editorial-batch-31',a.cookie);assert.equal(r.status,200);assert.match(await r.text(),/۱۳۴ معرفی/);
 assert.equal((await req(s,'/panel/editorial-batch-31',a.cookie,{csrf:'bad',confirm:'1'})).status,403);
 assert.equal((await req(s,'/panel/editorial-batch-31',a.cookie,{csrf:a.csrf})).status,400);
 const before=s.db.prepare('SELECT author,description FROM books WHERE id=34').get();assert.equal(before.description,'');
 const preview=batch31.preview(s.db);assert.equal(preview.total,134);assert.ok(preview.ready>110);
 assert.equal((await req(s,'/panel/editorial-batch-31',a.cookie,{csrf:a.csrf,confirm:'1'})).status,303);
 assert.equal(s.db.prepare("SELECT COUNT(*) n FROM catalog_metadata_drafts WHERE status='pending'").get().n,preview.ready);
 const after=s.db.prepare('SELECT author,description FROM books WHERE id=34').get();assert.deepEqual(after,before);
 assert.equal((await req(s,'/panel/editorial-batch-31',a.cookie,{csrf:a.csrf,confirm:'1'})).status,303);
 assert.equal(s.db.prepare('SELECT COUNT(*) n FROM catalog_metadata_drafts').get().n,preview.ready);
 assert.equal((await (await req(s,'/health')).json()).payment_enabled,false);
});
test('3.1: old staged drafts remain untouched, new drafts do not collide, and seller cannot access batch',async t=>{
 const s=await spawnSite(t),a=await owner(s);
 assert.equal((await req(s,'/panel/editorial-batch',a.cookie,{csrf:a.csrf,confirm:'1'})).status,303);
 const old=s.db.prepare('SELECT book_id,author,description,status FROM catalog_metadata_drafts WHERE book_id=1').get();assert.ok(old);
 assert.equal((await req(s,'/panel/editorial-batch-31',a.cookie,{csrf:a.csrf,confirm:'1'})).status,303);
 assert.deepEqual(s.db.prepare('SELECT book_id,author,description,status FROM catalog_metadata_drafts WHERE book_id=1').get(),old);
 assert.equal(s.db.prepare('SELECT COUNT(*) n FROM catalog_metadata_drafts').get().n,200);
 assert.equal(s.db.prepare('SELECT COUNT(*) n FROM books').get().n,1000);
 const create=await req(s,'/panel/user',a.cookie,{csrf:a.csrf,username:'seller31',password:'SellerPasswordFor31!',store_id:'1'});assert.equal(create.status,303);
 const login=await req(s,'/login','',{username:'seller31',password:'SellerPasswordFor31!'});const c=login.headers.get('set-cookie')?.split(';')[0];
 assert.equal((await req(s,'/panel/editorial-batch-31',c)).status,403);
 const panel=await (await req(s,'/panel',c)).text();assert.equal((await req(s,'/panel/editorial-batch-31',c,{csrf:token(panel),confirm:'1'})).status,403);
});

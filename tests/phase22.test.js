'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process'),{DatabaseSync}=require('node:sqlite');
const research=require('../lib/cover-research');
async function start(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq22-'));
 const srv=net.createServer();await new Promise(ok=>srv.listen(0,'127.0.0.1',ok));const port=srv.address().port;await new Promise(ok=>srv.close(ok));
 const p=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,VARAQ_CURATED_SEED:'1',DATA_DIR:dir,PORT:String(port),HOST:'127.0.0.1',PUBLIC_URL:''},stdio:['ignore','pipe','pipe']});
 let logs='';await new Promise((ok,fail)=>{const timeout=setTimeout(()=>fail(Error('Server startup timeout '+logs)),15000);p.stdout.on('data',d=>{logs+=d;if(logs.includes('PAYMENT: DISABLED')){clearTimeout(timeout);ok();}});p.stderr.on('data',d=>logs+=d);p.on('exit',c=>fail(Error('Server exit '+c+' '+logs)));});
 t.after(()=>{p.kill('SIGINT');fs.rmSync(dir,{recursive:true,force:true});});return {base:`http://127.0.0.1:${port}`,dir};
}
test('v2.2: researched covers are stored as non-public candidates only',async t=>{
 const s=await start(t);let db=new DatabaseSync(path.join(s.dir,'varaq.sqlite'));
 assert.equal(research.list(db).length,128);assert.equal(db.prepare('SELECT count(*) n FROM online_cover_candidates').get().n,0);
 const selected=research.list(db)[0];
 const id=research.add(db,{edition_id:selected.edition_id,image_url:'https://publisher.example/cover-one.jpg',source_url:'https://publisher.example/book/1',source_name:'صفحه ناشر',status:'permission_pending'},null);
 assert.ok(id>0);assert.equal(research.candidates(db,selected.edition_id).length,1);
 assert.equal(db.prepare('SELECT count(*) n FROM edition_cover_assets').get().n,0);
 assert.equal(db.prepare('SELECT count(*) n FROM edition_sources WHERE rights_confirmed=1').get().n,0);
 const csv=research.csv(db);assert.match(csv,/شناسه کتاب/);assert.match(csv,/978/);assert.match(csv,/google.com\/search/);
 db.close();
});
test('v2.2: dangerous cover URLs rejected',()=>{
 for(const url of ['http://example.com/image.jpg','https://127.0.0.1/image.jpg','https://localhost/image.jpg','file:///etc/passwd','javascript:alert(1)','https://user:pass@example.com/a.jpg','https://example.com:8080/a.jpg'])assert.throws(()=>research.validUrl(url));
 assert.equal(research.validUrl('https://publisher.example/cover.jpg'),'https://publisher.example/cover.jpg');
});
test('v2.2: cover research panel requires owner account and keeps payment disabled',async t=>{
 const s=await start(t);const get=(p,c='')=>fetch(s.base+p,{redirect:'manual',headers:{cookie:c}}),post=(p,form,c='')=>fetch(s.base+p,{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded',cookie:c},body:new URLSearchParams(form)});
 let r=await get('/panel/cover-research');assert.equal(r.status,303);
 r=await get('/panel/cover-research.csv');assert.equal(r.status,303);
 const h=await(await get('/health')).json();assert.equal(h.version,'8.6.0');assert.equal(h.payment_enabled,false);
 r=await post('/login',{username:'admin',password:'ad123456789'});let cookie=r.headers.get('set-cookie').split(';')[0];
 let a=await(await get('/panel/account',cookie)).text(),csrf=a.match(/name="csrf" value="([^"]+)"/)[1];
 await post('/panel/account',{csrf,username:'admin',old_password:'ad123456789',new_password:'StrongSecurePassword1234',confirm_password:'StrongSecurePassword1234'},cookie);
 r=await post('/login',{username:'admin',password:'StrongSecurePassword1234'});cookie=r.headers.get('set-cookie').split(';')[0];
 a=await(await get('/panel/cover-research',cookie)).text();assert.match(a,/جست‌وجوی تصویر جلد واقعی/);assert.match(a,/۱۲۸/);
 csrf=a.match(/name="csrf" value="([^"]+)"/)[1];
 const db=new DatabaseSync(path.join(s.dir,'varaq.sqlite'));const editionId=research.list(db)[0].edition_id;
 r=await post('/panel/cover-research',{csrf,edition_id:editionId,image_url:'https://publisher.example/real-cover.jpg',source_url:'https://publisher.example/books/1',source_name:'ناشر رسمی'},cookie);
 assert.equal(r.status,303);
 assert.equal(research.candidates(db,editionId).length,1);
 r=await get('/panel/cover-research.csv',cookie);assert.equal(r.status,200);assert.match(await r.text(),/Open Library/);
 db.close();
});

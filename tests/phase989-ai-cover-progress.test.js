'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const root=path.join(__dirname,'..');
const books=require('../data/books.json');
const progress=require('../lib/generated-cover-progress');
test('9.8.9: readiness scan accepts high-resolution portrait art and keeps thumbnail dimensions strict',()=>{
 const {validWebp}=require('../lib/catalog-readiness-v82');
 const full=path.join(root,'public/concept-art/book-001.webp');
 const thumb=path.join(root,'public/concept-thumb/book-001.webp');
 assert.equal(validWebp(full,480,672,true),true);
 assert.equal(validWebp(full,240,336),false);
 assert.equal(validWebp(thumb,240,336),true);
 assert.equal(validWebp(thumb,480,672,true),false);
});
test('9.8.9: receipt title and sealed bytes must both match',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq-cover-binding-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 fs.mkdirSync(path.join(dir,'data/ai-cover-progress'),{recursive:true});
 fs.mkdirSync(path.join(dir,'public/concept-art'),{recursive:true});
 const file=path.join(dir,'public/concept-art/book-001.webp');
 const receipt=path.join(dir,'data/ai-cover-progress/book-001.json');
 const bytes=fs.readFileSync(path.join(root,'public/concept-art/book-001.webp'));
 fs.writeFileSync(file,bytes);
 const record={id:1,title:books[0].title,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
 fs.writeFileSync(receipt,JSON.stringify(record));
 assert.equal(progress.load(dir,books).size,1);
 fs.writeFileSync(receipt,JSON.stringify({...record,title:'عنوان متفاوت'}));
 assert.equal(progress.load(dir,books).size,0);
 fs.writeFileSync(receipt,JSON.stringify(record));fs.writeFileSync(file,Buffer.from('changed'));
 assert.equal(progress.load(dir,books).size,0);
});
test('9.8.9: new art is served on book details and catalogue with fresh cache key',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq989-smoke-'));
 const child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,DATA_DIR:dir,PORT:'0',HOST:'127.0.0.1',PUBLIC_URL:''},stdio:['ignore','pipe','pipe']});
 let logs='';child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
 t.after(async()=>{if(child.exitCode===null){child.kill('SIGINT');await new Promise(r=>child.once('exit',r));}fs.rmSync(dir,{recursive:true,force:true});});
 let origin;
 for(let i=0;i<100;i++){
  const match=logs.match(/http:\/\/127\.0\.0\.1:(\d+)/);
  if(match){origin=match[0];break;}
  if(child.exitCode!==null)throw Error('server startup failed');
  await new Promise(r=>setTimeout(r,100));
 }
 assert.ok(origin,'server should become ready');
 const record=progress.load(root,books).get(1);assert.ok(record);
 const detail=await fetch(origin+'/book/book-001');assert.equal(detail.status,200);
 const html=await detail.text();
 assert.ok(html.includes('/concept-art/book-001.webp?v='+record.version));
 assert.ok(html.includes('تصویرسازی داستانی ورق'));
 const listing=await (await fetch(origin+'/books?q='+encodeURIComponent(books[0].title))).text();
 assert.ok(listing.includes('/concept-thumb/book-001.webp?v='+record.version));
 for(const type of ['art','thumb']){
  const r=await fetch(origin+'/concept-'+type+'/book-001.webp?v='+record.version);
  assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/image\/webp/);
  assert.ok((await r.arrayBuffer()).byteLength>1000);
 }
});

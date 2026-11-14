'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const root=path.join(__dirname,'..');
const data=require('../data/exclusive_content_v990.json');
const books=require('../data/books.json');
const binding=require('../lib/exclusive-content');
const {validateImage}=require('../lib/images');
const escape=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
test('9.9.0: 300 distinct introduction/summary pairs bound to the actual work',()=>{
 assert.equal(data.records.length,300);
 for(const field of ['summary','introduction'])assert.equal(new Set(data.records.map(r=>r[field])).size,300);
 for(const r of data.records){
  assert.equal(r.title,books[r.id-1].title);assert.notEqual(r.summary,r.introduction);
  assert.ok(r.introduction.length>=65&&r.summary.length>=100);
  assert.equal(binding.forBook(books[r.id-1]),r);
  assert.equal(binding.forBook({...books[r.id-1],title:'edited title'}),null);
 }
 assert.equal(binding.forBook(books[300]),null);
});
test('9.9.0: all 300 generated image receipts match valid unique full images and thumbnails',()=>{
 const hashes=new Set();
 for(let id=1;id<=300;id++){
  const name=`book-${String(id).padStart(3,'0')}`;
  const receipt=JSON.parse(fs.readFileSync(path.join(root,'data/ai-cover-progress',name+'.json')));
  assert.equal(receipt.title,books[id-1].title);
  for(const [folder,w,h,key] of [['concept-art',1000,1400,'sha256'],['concept-thumb',240,336,'thumbnail_sha256']]){
   const bytes=fs.readFileSync(path.join(root,'public',folder,name+'.webp'));
   const meta=validateImage(bytes);assert.equal(meta.width,w);assert.equal(meta.height,h);
   const hash=crypto.createHash('sha256').update(bytes).digest('hex');assert.equal(receipt[key],hash);
   if(folder==='concept-art'){assert.ok(!hashes.has(hash));hashes.add(hash);}
  }
 }
});
test('9.9.0: all 300 detail and reading pages expose their own introduction and summary',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq990-'));
 const child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,DATA_DIR:dir,PORT:'0',HOST:'127.0.0.1',PUBLIC_URL:''},stdio:['ignore','pipe','pipe']});
 let logs='';child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
 t.after(async()=>{if(child.exitCode===null){child.kill('SIGINT');await new Promise(r=>child.once('exit',r));}fs.rmSync(dir,{recursive:true,force:true});});
 let origin;
 for(let i=0;i<200;i++){
  const match=logs.match(/http:\/\/127\.0\.0\.1:(\d+)/);if(match){origin=match[0];break;}
  if(child.exitCode!==null)throw Error('server failed to start');await new Promise(r=>setTimeout(r,100));
 }
 assert.ok(origin,'server ready');
 let next=0;
 async function worker(){while(next<data.records.length){
  const record=data.records[next++];
  for(const suffix of ['','/read']){
   const r=await fetch(origin+'/book/'+record.slug+suffix);assert.equal(r.status,200,record.slug+suffix);
   const html=await r.text();
   assert.ok(html.includes(escape(record.introduction)),'missing introduction '+record.id+suffix);
   assert.ok(html.includes(escape(record.summary)),'missing summary '+record.id+suffix);
   assert.ok(html.includes('خلاصه اختصاصی کتاب'));
  }
 }}
 await Promise.all(Array.from({length:5},worker));
 const sheet=await (await fetch(origin+'/book/book-300/sheet')).text();assert.ok(sheet.includes(escape(data.records[299].summary)));
 const collection=await (await fetch(origin+'/books-300')).text();assert.ok(collection.includes('/book/book-001'));assert.ok(collection.includes('/books-300?page=2'));
 const last=await (await fetch(origin+'/books-300?page=13')).text();assert.ok(last.includes('/book/book-300'));assert.ok(!last.includes('/book/book-301'));
 const old=await fetch(origin+'/book/book-301');assert.equal(old.status,200);
});

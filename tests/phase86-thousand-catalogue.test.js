'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {spawn}=require('node:child_process');
const net=require('node:net');
const {validateImage}=require('../lib/images');
const root=path.resolve(__dirname,'..');
const library=require('../data/books.json');
const drafts=require('../data/generated_catalog_v86.json');
function port(){return new Promise((resolve,reject)=>{const srv=net.createServer();srv.listen(0,'127.0.0.1',()=>{const p=srv.address().port;srv.close(()=>resolve(p));});srv.on('error',reject);});}
async function start(t,storage){
 const p=await port();
 const child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,DATA_DIR:storage,PORT:String(p),HOST:'127.0.0.1',PUBLIC_URL:''},stdio:['ignore','pipe','pipe']});
 let log='';child.stdout.on('data',b=>log+=String(b));child.stderr.on('data',b=>log+=String(b));
 t.after(async()=>{child.kill('SIGINT');await new Promise(r=>setTimeout(r,140));});
 for(let i=0;i<120;i++){if(child.exitCode!==null)throw Error('server failed: '+log.slice(-2000));try{const r=await fetch(`http://127.0.0.1:${p}/health`);if(r.status===200)return `http://127.0.0.1:${p}`;}catch{}await new Promise(r=>setTimeout(r,100));}
 throw Error('startup timeout '+log.slice(-2000));
}
test('8.6: exactly 1000 unique real-world work candidates with Persian editorial drafts',()=>{
 assert.equal(library.length,1000);assert.equal(drafts.length,1000);
 const slugs=new Set(),ids=new Set();
 for(let i=0;i<library.length;i++){
  const b=library[i],d=drafts[i];
  assert.equal(b.id,i+1);assert.equal(b.slug,`book-${String(i+1).padStart(3,'0')}`);
  assert.ok(b.title?.trim()&&b.category?.trim());
  if(i>=200)assert.ok(b.author?.trim(),'new book author must be known');
  assert.ok(b.editorial_draft_fa?.trim().length>=90,`missing Persian draft ${b.id}`);
  assert.equal(d.title,b.title);assert.equal(d.description,b.editorial_draft_fa);
  assert.equal(b.description,'','drafts must not masquerade as approved operator copy');
  assert.ok(!slugs.has(b.slug));slugs.add(b.slug);assert.ok(!ids.has(b.id));ids.add(b.id);
  if(i>=200)assert.equal(b.isbn,'','ISBN must not be fabricated');
 }
});
test('8.6: all 2000 cover files exist, correct webp metadata, thumbnails smaller, original art distinct',()=>{
 const hashes=new Set();
 const ok=(b,w,h)=>{const meta=validateImage(b);assert.equal(meta.mime,'image/webp');assert.equal(meta.width,w);assert.equal(meta.height,h);};
 for(const b of library){
  const name=`book-${String(b.id).padStart(3,'0')}.webp`,full=fs.readFileSync(path.join(root,'public/concept-art',name)),thumb=fs.readFileSync(path.join(root,'public/concept-thumb',name));
  assert.ok(full.length>thumb.length,`large/small sizes reversed ${name}`);
  ok(full,480,672);ok(thumb,240,336);
  const hash=crypto.createHash('sha256').update(full).digest('hex');assert.ok(!hashes.has(hash),`duplicate art ${name}`);hashes.add(hash);
 }
});
test('8.6: newly installed site lists and serves books 1000, without paid checkout',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq86-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const origin=await start(t,dir);
 let r=await fetch(origin+'/health');assert.equal((await r.json()).version,'8.6.0');
 const db=new DatabaseSync(path.join(dir,'varaq.sqlite'),{readOnly:true});
 assert.equal(db.prepare('SELECT count(*) n FROM books').get().n,1000);db.close();
 r=await fetch(origin+'/book/book-1000');assert.equal(r.status,200);const detail=await r.text();assert.ok(detail.includes(library[999].title));assert.ok(detail.includes(library[999].editorial_draft_fa.slice(0,30)));
 r=await fetch(origin+'/books?q='+encodeURIComponent(library[999].title));assert.equal(r.status,200);assert.ok((await r.text()).includes(library[999].title));
 for(const kind of ['art','thumb']){r=await fetch(origin+`/concept-${kind}/book-1000.webp?v=86`);assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),'image/webp');}
 r=await fetch(origin+'/pdf-books');assert.equal(r.status,200);assert.match(await r.text(),/پرداخت و تحویل غیرفعال/);
});
test('8.6: migrate a pre-existing edited catalog non-destructively',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq86-upgrade-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const rootdb=path.join(dir,'varaq.sqlite');
 const old=new DatabaseSync(rootdb);
 old.exec(`CREATE TABLE books(id INTEGER PRIMARY KEY,slug TEXT UNIQUE NOT NULL,title TEXT NOT NULL,author TEXT DEFAULT '',category TEXT NOT NULL,description TEXT DEFAULT '',publisher TEXT DEFAULT '',isbn TEXT DEFAULT '',created_at TEXT DEFAULT CURRENT_TIMESTAMP);`);
 old.prepare('INSERT INTO books(id,slug,title,author,category,description,publisher,isbn) VALUES(?,?,?,?,?,?,?,?)').run(1,'book-001','عنوان ویرایش‌شده مالک','ویراستار','نمایشی','متن ویرایش‌شده شخصی','ناشر','');
 old.close();
 await start(t,dir);
 const after=new DatabaseSync(rootdb,{readOnly:true});
 assert.equal(after.prepare('SELECT title FROM books WHERE id=1').get().title,'عنوان ویرایش‌شده مالک');
 assert.equal(after.prepare('SELECT description FROM books WHERE id=1').get().description,'متن ویرایش‌شده شخصی');
 assert.equal(after.prepare('SELECT count(*) n FROM books').get().n,801,'adds 201-1000 without rewriting legacy 1-200');
 assert.equal(after.prepare('SELECT slug FROM books WHERE id=1000').get().slug,'book-1000');after.close();
});

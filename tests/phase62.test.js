'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process'),{DatabaseSync}=require('node:sqlite');
const root=path.join(__dirname,'..');
const catalogue=require('../data/generated_catalog_v62.json');
const delay=t=>new Promise(ok=>setTimeout(ok,t));
async function start(t,sharedDir=null){
 const dir=sharedDir||fs.mkdtempSync(path.join(os.tmpdir(),'varaq62-'));
 const sock=net.createServer();await new Promise(ok=>sock.listen(0,'127.0.0.1',ok));const port=sock.address().port;await new Promise(ok=>sock.close(ok));
 const proc=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,DATA_DIR:dir,HOST:'127.0.0.1',PORT:String(port),PUBLIC_URL:''},stdio:['ignore','pipe','pipe']});let errors='';proc.stderr.on('data',c=>errors+=c);
 t.after(async()=>{if(proc.exitCode===null){proc.kill();await Promise.race([new Promise(ok=>proc.once('exit',ok)),delay(1000)])}if(!sharedDir)fs.rmSync(dir,{recursive:true,force:true})});
 const base='http://127.0.0.1:'+port;
 for(let i=0;i<130;i++){try{const r=await fetch(base+'/health');if(r.ok)return {base,dir};}catch{}await delay(50)}
 throw Error(errors);
}
test('6.2: 200 unique, valid, offline concept art images and different intros, no official cover assets fabricated',async t=>{
 assert.equal(catalogue.length,200);assert.equal(new Set(catalogue.map(x=>x.title)).size,200);
 assert.equal(new Set(catalogue.map(x=>x.description)).size,200);
 for(const x of catalogue){
  assert.ok(x.description.length>=65,x.title);
  const art=path.join(root,'public',x.image);const data=fs.readFileSync(art);
  assert.ok(data.length>2500,x.title);assert.equal(data.toString('ascii',0,4),'RIFF');assert.equal(data.toString('ascii',8,12),'WEBP');
  assert.equal(x.status,'generated_concept_not_publisher_cover');
 }
 const {base,dir}=await start(t);
 const html=await (await fetch(base+'/books')).text();
 assert.match(html,/concept-thumb\/book-001\.webp/);assert.match(html,/طرح اختصاصی ورق · نه جلد ناشر/);
 const r=await fetch(base+'/concept-art/book-001.webp');assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/image\/webp/);
 assert.equal((await fetch(base+'/concept-art/book-9999.webp')).status,404);
 const page=await(await fetch(base+'/book/book-001')).text();
 assert.match(page,/روایتی درباره پیوند عشق/);assert.match(page,/پیش‌نویس تحریریه/);
 const db=new DatabaseSync(path.join(dir,'varaq.sqlite'));t.after(()=>db.close());
 assert.equal(db.prepare('SELECT count(*) n FROM books WHERE trim(description)<>\'\'').get().n,0);
 assert.equal(db.prepare('SELECT count(*) n FROM book_covers').get().n,0);
});
test('6.2: real licensed cover priority; existing author edited introduction never replaced',async t=>{
 const {base,dir}=await start(t);
 const db=new DatabaseSync(path.join(dir,'varaq.sqlite'));t.after(()=>db.close());
 db.prepare('UPDATE books SET description=? WHERE id=1').run('معرفی ویرایش‌شده توسط مدیر فروشگاه.');
 const page=await(await fetch(base+'/book/book-001')).text();assert.match(page,/معرفی ویرایش‌شده توسط مدیر فروشگاه/);assert.doesNotMatch(page,/روایتی درباره پیوند عشق/);
 const name='a'.repeat(32)+'.png',bytes=fs.readFileSync(path.join(__dirname,'fixtures','test_cover.png'));
 fs.writeFileSync(path.join(dir,'covers',name),bytes);
 db.prepare('INSERT INTO book_covers(book_id,filename,mime,alt,source,rights_note) VALUES(?,?,?,?,?,?)').run(1,name,'image/png','تصویر دارای مجوز ناشر','ناشر','مدرک بررسی‌شده');
 const h=await(await fetch(base+'/books?q='+encodeURIComponent('ملت عشق'))).text();
 assert.match(h,new RegExp('/media/covers/'+name));assert.doesNotMatch(h,/concept-art\/book-001\.webp/);
 assert.equal((await fetch(base+'/pdf-delivery/1234567890123456789012345678901234567890123')).status,404);
});

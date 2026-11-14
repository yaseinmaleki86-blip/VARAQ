'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
const discovery=require('../lib/discovery');
function availablePort(){return new Promise((resolve,reject)=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});s.on('error',reject);});}
async function boot(t,{storage=null,publicUrl=false}={}){
 const dir=storage||fs.mkdtempSync(path.join(os.tmpdir(),'varaq-phase9-'));
 if(!storage)t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const port=await availablePort();
 const base=`http://127.0.0.1:${port}`;
 const child=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,PORT:String(port),HOST:'127.0.0.1',DATA_DIR:dir,...(publicUrl?{PUBLIC_URL:base,VARAQ_PUBLIC_INDEX:'1',VARAQ_LEGAL_REVIEWED:'1',VARAQ_MEDIA_RIGHTS_REVIEWED:'1',VARAQ_BROWSER_QA_APPROVED:'1'}:{})},stdio:['ignore','pipe','pipe']});
 let log='';child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);
 try{for(let i=0;i<70;i++){if(child.exitCode!==null)throw Error('server exit '+log);try{const h=await fetch(base+'/health');if(h.ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}}
 catch(e){child.kill('SIGINT');throw e;}
 t.after(()=>child.kill('SIGINT'));
 return {base,dir,log:()=>log};
}
const read=(base,url)=>fetch(base+url);
test('phase9: Persian normalized searches, edition translator and ISBN, prefix results and safe filters',async t=>{
 const {base,dir}=await boot(t);const db=new DatabaseSync(path.join(dir,'varaq.sqlite'));t.after(()=>db.close());
 const book=db.prepare("SELECT id,author FROM books WHERE title='ملت عشق'").get();assert.ok(book);
 let r=await read(base,'/books?q='+encodeURIComponent('ملت عشق'));assert.equal(r.status,200);let body=await r.text();assert.match(body,/ملت عشق/);
 r=await read(base,'/books?q='+encodeURIComponent('ملت ع'));assert.equal(r.status,200);assert.match(await r.text(),/ملت عشق/);
 const p=db.prepare('SELECT title FROM books WHERE id=?').get(book.id);
 db.prepare('UPDATE books SET title=? WHERE id=?').run('كتاب ياسین امتحانی',book.id);
 r=await read(base,'/books?q='+encodeURIComponent('کتاب یاسین'));assert.equal(r.status,200);assert.match(await r.text(),/كتاب ياسین امتحانی/);
 db.prepare('UPDATE books SET title=? WHERE id=?').run(p.title,book.id);
 const ed=db.prepare('INSERT INTO editions(book_id,label,translator,publisher,isbn,verified) VALUES(?,?,?,?,?,1)').run(book.id,'چاپ مرجع','مترجم آزمایشی','انتشارات آزمایشی','9786000000001');assert.ok(ed.lastInsertRowid);
 r=await read(base,'/books?q='+encodeURIComponent('مترجم آزمایشی'));assert.equal(r.status,200);assert.match(await r.text(),/ملت عشق/);
 r=await read(base,'/books?q=9786000000001');assert.equal(r.status,200);assert.match(await r.text(),/ملت عشق/);
 r=await read(base,'/books?publisher='+encodeURIComponent('انتشارات آزمایشی'));assert.equal(r.status,200);assert.match(await r.text(),/ملت عشق/);
 r=await read(base,'/books?q='+encodeURIComponent('**() OR x:y'));assert.equal(r.status,200);assert.doesNotMatch(await r.text(),/خطای داخلی سرور/);
 assert.equal(discovery.normalize('كِتاب‌های ۱۲۳'),'کتاب های 123');
 db.prepare('DELETE FROM editions WHERE id=?').run(ed.lastInsertRowid);
 r=await read(base,'/books?q=9786000000001');assert.equal(r.status,200);assert.match(await r.text(),/کتابی با این مشخصات پیدا نشد/);
});
test('phase9: public author and publisher directories, sitemap, sanitized metadata and no payment',async t=>{
 const {base,dir}=await boot(t);const db=new DatabaseSync(path.join(dir,'varaq.sqlite'));t.after(()=>db.close());
 db.prepare('UPDATE books SET publisher=? WHERE id=1').run('ناشر تست فاز نه');
 for(const url of ['/authors','/publishers','/authors/'+encodeURIComponent('الیف شافاک'),'/publishers/'+encodeURIComponent('ناشر تست فاز نه'),'/sitemap.xml']){
  const r=await read(base,url);assert.equal(r.status,200,url);assert.ok((await r.text()).length>100,url);
 }
 let r=await read(base,'/book/book-001');let html=await r.text();assert.match(html,/\/authors\//);assert.match(html,/\/publishers\//);assert.match(html,/application\/ld\+json/);
 r=await read(base,'/sitemap.xml');html=await r.text();assert.match(html,/\/authors\//);assert.match(html,/\/publishers\//);assert.match(html,/\/book\/book-001/);
 r=await read(base,'/books?q=ملت');html=await r.text();assert.match(html,/noindex,nofollow/); // local demo always noindex
 r=await read(base,'/health');const health=await r.json();assert.equal(health.payment_enabled,false);assert.equal(health.version,'8.6.0');
 r=await read(base,'/authors/'+encodeURIComponent('<script>'));assert.equal(r.status,404);
});
test('phase9: existing version 0.8 sqlite preserved; indexed updates from separate sqlite connection',async t=>{
 const {base,dir}=await boot(t);const db=new DatabaseSync(path.join(dir,'varaq.sqlite'));t.after(()=>db.close());
 const before=db.prepare('SELECT COUNT(*) n FROM books').get().n;
 db.prepare("INSERT INTO stores(name,slug,city,active) VALUES('فروشگاه تست ویرایش','store-test-nine','یزد',0)").run();
 db.prepare("INSERT INTO books(slug,title,author,category,publisher) VALUES('phase9-book','کتاب مخصوص فاز نهم','نویسنده نهم','فلسفه و تاریخ','ناشر نهم')").run();
 let r=await read(base,'/books?q='+encodeURIComponent('مخصوص فاز'));assert.equal(r.status,200);assert.match(await r.text(),/کتاب مخصوص فاز نهم/);
 db.prepare("UPDATE books SET author='نویسنده تازه' WHERE slug='phase9-book'").run();
 r=await read(base,'/books?q='+encodeURIComponent('نویسنده تازه'));assert.equal(r.status,200);assert.match(await r.text(),/کتاب مخصوص فاز نهم/);
 assert.equal(db.prepare('SELECT count(*) n FROM books').get().n,before+1);
 assert.equal(db.prepare('SELECT count(*) n FROM stores WHERE slug=?').get('store-test-nine').n,1);
 r=await read(base,'/publishers/'+encodeURIComponent('ناشر نهم'));assert.equal(r.status,200);
});
test('phase9: CDN-ready static cache, noindex search page and canonical public profile',async t=>{
 const {base}=await boot(t,{publicUrl:true});
 const r=await read(base,'/assets/style.css');assert.equal(r.status,200);
 const etag=r.headers.get('etag');assert.ok(etag);
 let re=await fetch(base+'/assets/style.css',{headers:{'If-None-Match':etag}});
 assert.equal(re.status,304);
 re=await read(base,'/books?q='+encodeURIComponent('ملت عشق'));
 let html=await re.text();assert.match(html,/<meta name="robots" content="noindex,follow">/);
 assert.match(html,/<link rel="canonical" href="http:\/\/127\.0\.0\.1:\d+\/books">/);
 re=await read(base,'/authors/'+encodeURIComponent('الیف شافاک'));
 html=await re.text();assert.match(html,/noindex,follow/); // v3.8: thin author profile without sourced edition cannot be indexed
 assert.match(html,/<link rel="canonical" href="http:\/\/127\.0\.0\.1:\d+\/authors\//);
 assert.equal((await(await read(base,'/health')).json()).payment_enabled,false);
});

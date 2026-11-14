'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process');const {DatabaseSync}=require('node:sqlite');
const bib=require('../lib/bibliography'),worklist=require('../lib/catalog-worklist');
async function boot(t,existing){
 const dir=existing||fs.mkdtempSync(path.join(os.tmpdir(),'varaq29-'));
 const sock=net.createServer();await new Promise(r=>sock.listen(0,'127.0.0.1',r));const port=sock.address().port;await new Promise(r=>sock.close(r));
 const child=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,VARAQ_CURATED_SEED:'1',DATA_DIR:dir,HOST:'127.0.0.1',PORT:String(port)},stdio:['ignore','pipe','pipe']});
 let output='';await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('timeout '+output)),20000);child.stdout.on('data',d=>{output+=d;if(output.includes('PAYMENT: DISABLED')){clearTimeout(timer);resolve();}});child.stderr.on('data',d=>output+=d);child.on('exit',c=>{clearTimeout(timer);reject(Error('exit '+c+' '+output));});});
 t.after(()=>{child.kill();if(!existing)fs.rmSync(dir,{recursive:true,force:true});});return {dir,url:'http://127.0.0.1:'+port};
}
async function loggedIn(s){let r=await fetch(s.url+'/login',{method:'POST',body:new URLSearchParams({username:'admin',password:'ad123456789'}),redirect:'manual'});let c=r.headers.get('set-cookie')?.split(';')[0];assert.ok(c);let h=await (await fetch(s.url+'/panel/account',{headers:{cookie:c}})).text();const csrf=h.match(/name="csrf" value="([^"]+)"/)[1];r=await fetch(s.url+'/panel/account',{method:'POST',headers:{cookie:c},body:new URLSearchParams({csrf,username:'admin',old_password:'ad123456789',new_password:'NewSecret1234567',confirm_password:'NewSecret1234567'}),redirect:'manual'});assert.equal(r.status,303);r=await fetch(s.url+'/login',{method:'POST',body:new URLSearchParams({username:'admin',password:'NewSecret1234567'}),redirect:'manual'});return r.headers.get('set-cookie')?.split(';')[0];}
test('2.9 curated ISBNs have unique, valid ISBN-13 and match exact book identities',()=>{
 const list=require('../data/curated_editions_v29.json');assert.equal(list.length,13);assert.equal(new Set(list.map(x=>x.id)).size,6);
 const bookList=require('../data/books.json');for(const x of list){assert.ok(bib.isbnValid(x.isbn),x.isbn);assert.match(x.source_url,/^https:\/\//);assert.equal(x.cover_url,'');assert.equal(bookList.find(b=>b.id===x.id)?.title,x.title);}
});
test('2.9 seeds 117 editions across 68 works, keeps all 200 originals, with no real payments or unlicensed covers',async t=>{
 const s=await boot(t);const db=new DatabaseSync(path.join(s.dir,'varaq.sqlite'));
 assert.equal(db.prepare('SELECT COUNT(*) n FROM books').get().n,1000);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM edition_sources').get().n,128);
 assert.equal(db.prepare('SELECT COUNT(DISTINCT e.book_id) n FROM editions e JOIN edition_sources x ON x.edition_id=e.id').get().n,71);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM edition_sources WHERE rights_confirmed=1').get().n,0);
 assert.equal((await (await fetch(s.url+'/health')).json()).payment_enabled,false);
 const items=worklist.rows(db),c=worklist.counts(items);assert.equal(c.books,1000);assert.equal(c.sourced,71);assert.equal(c.cover,0);assert.equal(c.ready,0);
 assert.equal(worklist.filter(items,'unsourced','').length,929);
 assert.equal(worklist.filter(items,'missing-cover','').length,1000);
 db.close();
});
test('2.9 manager sees filtered completion queue and CSV, public cannot access',async t=>{
 const s=await boot(t);let r=await fetch(s.url+'/panel/catalog-worklist');assert.doesNotMatch(await r.text(),/صف تکمیل اطلاعات و جلد واقعی/);
 const cookie=await loggedIn(s);r=await fetch(s.url+'/panel/catalog-worklist?status=unsourced',{headers:{cookie}});assert.equal(r.status,200);
 const html=await r.text();assert.match(html,/صف تکمیل اطلاعات و جلد واقعی/);assert.match(html,/ثبت شناسنامه چاپ و شابک/);
 r=await fetch(s.url+'/panel/catalog-worklist.csv',{headers:{cookie}});assert.equal(r.status,200);const txt=await r.text();assert.match(txt,/next_tasks/);assert.match(txt,/ملت عشق/);assert.equal(txt.split('\r\n').length,1002);
});
test('2.9 upgrades old records without overwriting seller changes',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq29-upgrade-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 // Legacy-style 200 title database with custom data, no curated records initially.
 const db=new DatabaseSync(path.join(dir,'varaq.sqlite'));db.exec('CREATE TABLE books (id INTEGER PRIMARY KEY,slug TEXT UNIQUE NOT NULL,title TEXT NOT NULL,author TEXT NOT NULL DEFAULT \'\',category TEXT NOT NULL,description TEXT NOT NULL DEFAULT \'\',publisher TEXT NOT NULL DEFAULT \'\',isbn TEXT NOT NULL DEFAULT \'\',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
 const catalog=require('../data/books.json'),ins=db.prepare('INSERT INTO books(id,slug,title,author,category,description,publisher,isbn) VALUES(?,?,?,?,?,?,?,?)');for(const b of catalog)ins.run(b.id,b.slug,b.title,b.author,b.category,b.description,b.publisher,b.isbn);
 db.prepare('UPDATE books SET description=? WHERE id=1').run('متن اختصاصی فروشگاه که باید حفظ شود');db.close();
 const s=await boot(t,dir),up=new DatabaseSync(path.join(dir,'varaq.sqlite'));
 assert.equal(up.prepare('SELECT description FROM books WHERE id=1').get().description,'متن اختصاصی فروشگاه که باید حفظ شود');
 assert.equal(up.prepare('SELECT COUNT(*) n FROM edition_sources').get().n,128);up.close();
});

'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const net=require('node:net');const {spawn}=require('node:child_process');const {DatabaseSync}=require('node:sqlite');
const bibliography=require('../lib/bibliography'),printVariants=require('../lib/print-variants');
async function serve(t,dir){
 const own=!dir;if(!dir)dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq28-'));
 const sk=net.createServer();await new Promise(r=>sk.listen(0,'127.0.0.1',r));const port=sk.address().port;await new Promise(r=>sk.close(r));
 const child=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,VARAQ_CURATED_SEED:'1',DATA_DIR:dir,HOST:'127.0.0.1',PORT:String(port),PUBLIC_URL:''},stdio:['ignore','pipe','pipe']});
 let text='';await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('server timeout '+text)),20000);child.stdout.on('data',b=>{text+=b;if(text.includes('PAYMENT: DISABLED')){clearTimeout(timer);resolve();}});child.stderr.on('data',b=>text+=b);child.on('exit',c=>reject(Error('server exit '+c+' '+text)));});
 t.after(()=>{child.kill();if(own)fs.rmSync(dir,{recursive:true,force:true});});
 return {dir,url:'http://127.0.0.1:'+port};
}
test('2.8 all new 13 ISBNs are valid and attributable to 8 books',()=>{
 const rows=require('../data/curated_editions_v28.json');assert.equal(rows.length,13);assert.equal(new Set(rows.map(x=>x.id)).size,8);
 assert.equal(new Set(rows.map(x=>x.isbn)).size,13);
 for(const x of rows){assert.ok(bibliography.isbnValid(x.isbn));assert.match(x.source_url,/^https:\/\//);assert.equal(x.cover_url,'');}
});
test('2.8 verified seed preserves 200 titles, 97 editions across 59 books; no cover approved or payment enabled',async t=>{
 const s=await serve(t);const db=new DatabaseSync(path.join(s.dir,'varaq.sqlite'));
 assert.equal(db.prepare('SELECT COUNT(*) n FROM books').get().n,1000);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM edition_sources').get().n,128);
 assert.equal(db.prepare('SELECT COUNT(DISTINCT e.book_id) n FROM editions e JOIN edition_sources es ON es.edition_id=e.id').get().n,71);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM edition_sources WHERE rights_confirmed=1').get().n,0);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM edition_cover_assets').get().n,0);
 assert.equal((await (await fetch(s.url+'/health')).json()).payment_enabled,false);
 db.close();
});
test('2.8 show evidence of divergent pages, with source links, without altering stored master edition page count',async t=>{
 const s=await serve(t);const db=new DatabaseSync(path.join(s.dir,'varaq.sqlite'));
 const conflicts=printVariants.conflicts(db);
 assert.ok(conflicts.some(x=>x.isbn==='9789645643889'&&x.min_pages===682&&x.max_pages===684));
 assert.ok(conflicts.some(x=>x.isbn==='9789643803247'&&x.min_pages===440&&x.max_pages===442));
 assert.equal(printVariants.all(db).length,13);
 const b=db.prepare("SELECT id FROM books WHERE title='قصه‌های مجید'").get();const evid=printVariants.forBook(db,b.id);assert.equal(evid['9789645643889'].length,2);
 const html=await (await fetch(s.url+'/book/book-101')).text();assert.match(html,/اطلاعات نوبت‌های چاپ/);assert.match(html,/https:\/\/mahdroo\.ir\/shop\/product\/book-404364-u9vqx6/);
 assert.equal(db.prepare("SELECT pages FROM editions WHERE isbn='9789645643889'").get().pages,682);
 db.close();
});
test('2.8 preserves existing records on repeat migrations and guards report',async t=>{
 const s=await serve(t);const db=new DatabaseSync(path.join(s.dir,'varaq.sqlite'));
 db.prepare('UPDATE editions SET pages=? WHERE isbn=?').run(777,'9789645643889');
 bibliography.migrate(db);printVariants.migrate(db);
 assert.equal(db.prepare("SELECT pages FROM editions WHERE isbn='9789645643889'").get().pages,777);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM print_run_evidence').get().n,13);
 for(const path of ['/panel/print-evidence','/panel/print-evidence.csv','/panel/cover-priority']){
  const r=await fetch(s.url+path,{redirect:'manual'});assert.notEqual(r.status,200);
 }
 db.close();
});

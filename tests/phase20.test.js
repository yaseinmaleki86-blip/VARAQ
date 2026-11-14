'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const net=require('node:net');
const {spawn}=require('node:child_process');const {DatabaseSync}=require('node:sqlite');
const cover=require('../lib/edition-cover');const bib=require('../lib/bibliography');
async function start(t,seed=true){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq-phase20-'));
 const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));
 const proc=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,VARAQ_CURATED_SEED:seed?'1':'0',DATA_DIR:dir,PORT:String(port),HOST:'127.0.0.1',PUBLIC_URL:''},stdio:['ignore','pipe','pipe']});
 let logs='';await new Promise((ok,fail)=>{const timer=setTimeout(()=>fail(Error(logs||'timeout')),12000);proc.stdout.on('data',d=>{logs+=d;if(logs.includes('PAYMENT: DISABLED')){clearTimeout(timer);ok();}});proc.stderr.on('data',d=>logs+=d);proc.on('exit',n=>fail(Error('server exit '+n+' '+logs)));});
 t.after(()=>{proc.kill('SIGINT');fs.rmSync(dir,{force:true,recursive:true});});return {dir,base:'http://127.0.0.1:'+port};
}
test('v2.0: verified edition batch is idempotent and never changes merchant data',async t=>{
 const s=await start(t);const db=new DatabaseSync(path.join(s.dir,'varaq.sqlite'));
 assert.equal(db.prepare('SELECT count(*) n FROM books').get().n,1000);
 assert.equal(db.prepare('SELECT count(*) n FROM edition_sources').get().n,128);
 assert.equal(db.prepare('SELECT count(DISTINCT book_id) n FROM editions WHERE verified=1').get().n,71);
 assert.equal(db.prepare('SELECT pages FROM editions WHERE isbn=?').get('9789643128432').pages,452);
 assert.equal(db.prepare('SELECT translator FROM editions WHERE isbn=?').get('9786008738701').translator,'هادی بهمنی');
 db.prepare("UPDATE editions SET pages=451 WHERE isbn='9789643128432'").run();
 bib.migrate(db);
 assert.equal(db.prepare('SELECT pages FROM editions WHERE isbn=?').get('9789643128432').pages,451);
 assert.equal(db.prepare('SELECT count(*) n FROM edition_sources').get().n,128);
 db.close();
 const h=await (await fetch(s.base+'/health')).json();assert.equal(h.version,'8.6.0');assert.equal(h.payment_enabled,false);
});
test('v2.0: ISBN-specific real photo requires permission and matching book and can be served',async t=>{
 const s=await start(t);const db=new DatabaseSync(path.join(s.dir,'varaq.sqlite'));
 const edition=db.prepare("SELECT id FROM editions WHERE isbn='9786008738701'").get().id;
 const pic=fs.readFileSync(path.join(__dirname,'fixtures/cover-test-only.png'));
 const info={bookId:42,editionId:edition,image:pic,source:'عکس تست، برای آزمایش مجوز',rights:'تصویر تولیدشده در تست و مجاز برای استفاده',permission:'1',matched:'1'};
 const dest=path.join(s.dir,'covers');
 assert.throws(()=>cover.save(db,{...info,bookId:41},dest),/همان کتاب/);
 assert.throws(()=>cover.save(db,{...info,permission:'0'},dest),/حق استفاده/);
 assert.throws(()=>cover.save(db,{...info,matched:'0'},dest),/تطبیق/);
 assert.equal(cover.forBook(db,42),undefined);
 const saved=cover.save(db,info,dest);
 assert.ok(fs.existsSync(path.join(dest,saved.filename)));
 assert.equal(cover.forBook(db,42).isbn,'9786008738701');
 assert.equal(cover.forBook(db,41),undefined);
 db.close();
 const book=await (await fetch(s.base+'/book/book-042')).text();assert.match(book,new RegExp(saved.filename));
 const r=await fetch(s.base+'/media/covers/'+saved.filename);assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),'image/png');
 assert.equal((await fetch(s.base+'/panel/bibliography',{redirect:'manual'})).status,303);
});

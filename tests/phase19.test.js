'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const net=require('node:net');
const {spawn}=require('node:child_process');const {DatabaseSync}=require('node:sqlite');
const bib=require('../lib/bibliography');
async function start(t){const storage=fs.mkdtempSync(path.join(os.tmpdir(),'varaq-v19-'));const sock=net.createServer();await new Promise(r=>sock.listen(0,'127.0.0.1',r));const port=sock.address().port;await new Promise(r=>sock.close(r));
 const proc=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,VARAQ_CURATED_SEED:'1',DATA_DIR:storage,PORT:String(port),HOST:'127.0.0.1',PUBLIC_URL:''},stdio:['ignore','pipe','pipe']});let output='';
 await new Promise((ok,fail)=>{const timeout=setTimeout(()=>fail(new Error('startup timeout '+output)),12000);const log=x=>{output+=x.toString();if(output.includes('PAYMENT: DISABLED')){clearTimeout(timeout);ok();}};proc.stdout.on('data',log);proc.stderr.on('data',log);proc.on('exit',c=>fail(new Error('exit '+c+': '+output)));});
 t.after(()=>{proc.kill('SIGINT');fs.rmSync(storage,{recursive:true,force:true});});return {url:'http://127.0.0.1:'+port,storage};
}
test('v1.9: curated ISBN examples are source-backed; 200 books and 3 genuine cover pointers are present',async t=>{
 const s=await start(t);const db=new DatabaseSync(path.join(s.storage,'varaq.sqlite'));
 assert.equal(db.prepare('SELECT count(*) n FROM books').get().n,1000);
 assert.equal(db.prepare('SELECT count(*) n FROM edition_sources').get().n,128);
 assert.equal(db.prepare('SELECT count(*) n FROM edition_sources WHERE cover_matched=1').get().n,3);
 assert.equal(db.prepare('SELECT pages FROM editions WHERE isbn=?').get('9789643119195').pages,511);
 assert.equal(db.prepare('SELECT title FROM books WHERE id=5').get().title,'جزء از کل');
 assert.ok(bib.getCover(db,1).cover_url.includes('arianhonar'));
 assert.equal(bib.getCover(db,6),undefined);
 db.close();
 const health=await (await fetch(s.url+'/health')).json();assert.equal(health.version,'8.6.0');assert.equal(health.payment_enabled,false);
 // The selected edition has no licensed local cover; since v6.3 the hero uses a clearly labeled original concept illustration instead of a remote image pointer.
 const a=await (await fetch(s.url+'/book/book-001')).text();assert.match(a,/تصویر گرافیکی اختصاصی معرفی کتاب/);assert.match(a,/مشاهده منبع شناسنامه/);assert.doesNotMatch(a,/class="uploaded-cover external-cover"/);
 const b=await (await fetch(s.url+'/book/book-006')).text();assert.match(b,/تصویر گرافیکی اختصاصی معرفی کتاب/);assert.match(b,/طرح اختصاصی ورق · نه جلد ناشر/);
 const home=await (await fetch(s.url+'/')).text();assert.match(home,/hero-real-covers/);assert.doesNotMatch(home,/art-book front/);
});
test('v1.9: untrusted image hosts, invalid ISBN and cross-book collisions are rejected',async t=>{
 const s=await start(t);const db=new DatabaseSync(path.join(s.storage,'varaq.sqlite'));
 const data={book_id:'6',isbn:'9780131103627',publisher:'ناشر معتبر',label:'چاپ نمونه',source_url:'https://example.org/book',cover_url:'https://evil.example/malicious.svg',cover_matched:'1'};
 assert.throws(()=>bib.save(db,data),/دامنه تصویر/);
 assert.throws(()=>bib.save(db,{...data,cover_url:'',isbn:'9780131103628'}),/شابک/);
 assert.throws(()=>bib.save(db,{...data,cover_url:'',isbn:'9789643119195'}),/کتاب دیگری/);
 assert.equal(db.prepare('SELECT count(*) n FROM editions').get().n,128);
 db.close();
});
test('v1.9: edition editor is protected and all external cover domains are scoped by CSP',async t=>{
 const s=await start(t);const r=await fetch(s.url+'/panel/bibliography',{redirect:'manual'});assert.equal(r.status,303);assert.equal(r.headers.get('location'),'/login');
 const view=await fetch(s.url+'/book/book-005');assert.match(view.headers.get('content-security-policy'),/img-src[^;]+img\.taaghche\.com/);const html=await view.text();assert.match(html,/طرح اختصاصی ورق · نه جلد ناشر/);assert.doesNotMatch(html.split('<div class="detail-text">')[0],/img\.taaghche\.com/);
});
